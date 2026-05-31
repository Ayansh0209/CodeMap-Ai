// src/parser/issuePipeline.ts
// ─────────────────────────────────────────────────────────────────────────────
// Pipeline orchestrator — three-stage, cost-progressive, Gemini-guided.
//
// Phase 3 redesign:
//   Stage 1 — Token-guided graph traversal (free, no AI call):
//     Extract tokens from issue → substring match against RetrievalIndex
//     → barrel expansion → neighborhood expansion.
//     If >= MIN_CANDIDATES_FOR_STAGE1 → skip to Stage 3.
//     If < MIN_CANDIDATES_FOR_STAGE1 → go to Stage 2.
//
//   Stage 2 — Gemini graph navigation (1 AI call, only when needed):
//     Send compact graph map to Gemini → Gemini returns file paths to examine.
//     Add these to the candidate set → go to Stage 3.
//
//   Stage 3 — Gemini-directed snippet fetching (max 2 rounds):
//     Round 1: fetch snippets → send to Gemini → either final answer or
//              "I need more files" with requestedFiles list.
//     Round 2 (only if requested): fetch additional files → final answer.
//
// GRACEFUL DEGRADATION:
//   If RetrievalIndex missing → legacy pipeline (sends filenames to Gemini)
//   If Stage 2 Gemini fails → proceed with Stage 1 candidates only
//   If Round 1 Gemini fails → return empty result (never 500)
//   If Round 2 Gemini fails → return Round 1's partial result
// ─────────────────────────────────────────────────────────────────────────────

import { extractSearchIntent } from "./issueUnderstanding";
import type { SearchIntent } from "./issueUnderstanding";
import { traverseGraph, buildCompactGraphMap } from "./issueMapper";
import type { CandidateSet, CandidateFileEntry } from "./issueMapper";
import { fetchSnippets } from "./snippetFetcher";
import type { CodeSnippet } from "./snippetFetcher";

import {
    callGeminiForMappingRound1,
    callGeminiForMappingFinal,
    callGeminiForMapping,
    callGeminiForGraphNavigation,
    type GeminiMappingResult,
    type IssueContextInput,
    type AffectedFile,
} from "./issueAnalyzer";
import type { RetrievalIndex } from "../models/retrieval";
import type { LinkedPR } from "../github/issueClient";
import { redisConnection } from "../queue/jobQueue";

// ── Types ─────────────────────────────────────────────────────────────────────

/** All inputs the pipeline needs to execute */
export interface PipelineInput {
    /** GitHub repo owner */
    owner: string;
    /** GitHub repo name */
    repo: string;
    /** Commit SHA from the most recent analysis */
    commitSha: string;
    /** Full issue context */
    issue: IssueContextInput;
    /** Linked pull requests (may be empty) */
    linkedPRs: LinkedPR[];
    /**
     * All file IDs in the visualization graph (for filtering candidates).
     */
    graphFileIds: Set<string>;
    /**
     * Inline files for legacy fallback (repos analyzed before RetrievalIndex).
     */
    legacyFiles?: Array<{ id: string; label: string; architecturalImportance?: number }>;
}

/** The complete output of the pipeline */
export interface PipelineResult {
    /** The AI mapping result (or null if Gemini failed) */
    geminiResult: GeminiMappingResult | null;
    /** Whether the new pipeline was used (false = legacy fallback) */
    usedNewPipeline: boolean;
    /** Number of code snippets passed to Gemini */
    snippetCount: number;
    /** Whether the issue was classified as vague */
    isVague: boolean;
    /** The extracted search intent */
    intent: SearchIntent | null;
    /** Always empty — deterministic fallback is removed */
    fallbackFiles: AffectedFile[];
}

// ── RetrievalIndex loader ─────────────────────────────────────────────────────

async function loadRetrievalIndex(owner: string, repo: string): Promise<RetrievalIndex | null> {
    try {
        const key = `retrieval:${owner}:${repo}`;
        const raw = await redisConnection.get(key);
        if (!raw) {
            console.log(`\x1b[33m[issuePipeline] no retrieval index in Redis for ${owner}/${repo} — using legacy\x1b[0m`);
            return null;
        }
        const index = JSON.parse(raw) as RetrievalIndex;
        console.log(`\x1b[32m[issuePipeline] loaded retrieval index: ${index.files.length} files\x1b[0m`);
        return index;
    } catch (err) {
        console.warn("\x1b[31m[issuePipeline] failed to load retrieval index:\x1b[0m", (err as Error).message);
        return null;
    }
}

// ── Stage 3: Iterative Gemini mapping ─────────────────────────────────────────

/**
 * Execute Stage 3: fetch snippets, send to Gemini, optionally do Round 2.
 *
 * @param candidates  All candidates from Stage 1 + Stage 2 combined
 * @param retrieval   RetrievalIndex for function metadata
 * @param intent      SearchIntent for token-based function selection
 * @param input       PipelineInput for GitHub fetch params
 * @returns           GeminiMappingResult and total snippet count
 */
async function runStage3(
    candidates: CandidateFileEntry[],
    retrieval: RetrievalIndex,
    intent: SearchIntent,
    input: PipelineInput,
): Promise<{ geminiResult: GeminiMappingResult | null; snippetCount: number }> {
    // ── Round 1: Initial snippet fetch + Gemini ───────────────────────────────
    let snippets: CodeSnippet[] = [];
    try {
        snippets = await fetchSnippets(
            candidates,
            retrieval,
            intent,
            input.owner,
            input.repo,
            input.commitSha,
        );
        console.log(`\x1b[32m[issuePipeline] Round 1: fetched ${snippets.length} snippets\x1b[0m`);
    } catch (err) {
        console.warn("\x1b[31m[issuePipeline] Round 1 snippet fetching failed:\x1b[0m", (err as Error).message);
    }

    const round1 = await callGeminiForMappingRound1(input.issue, snippets, input.linkedPRs);

    if (!round1) {
        console.log("\x1b[31m[issuePipeline] Round 1 Gemini call returned null\x1b[0m");
        return { geminiResult: null, snippetCount: snippets.length };
    }

    // ── Check if Gemini is satisfied ──────────────────────────────────────────
    if (!round1.needsMoreContext) {
        // Gemini gave a final answer in Round 1
        if (round1.affectedFiles.length > 0) {
            console.log(`\x1b[35m[issuePipeline] Round 1 FINAL — AI returned ${round1.affectedFiles.length} files:\n${round1.affectedFiles.map(f => `  - ${f.fileId} (confidence: ${f.confidence})`).join("\n")}\x1b[0m`);
        } else {
            console.log("\x1b[31m[issuePipeline] Round 1 FINAL — AI returned 0 files\x1b[0m");
        }
        return {
            geminiResult: {
                affectedFiles: round1.affectedFiles,
                summary: round1.summary,
                fixApproach: round1.fixApproach,
            },
            snippetCount: snippets.length,
        };
    }

    // ── Round 2: Gemini requested more files ──────────────────────────────────
    console.log(
        `\x1b[33m[issuePipeline] Round 2 triggered — Gemini wants ${round1.requestedFiles.length} more files: ` +
        `${round1.reason}\x1b[0m`
    );
    console.log(`\x1b[36m[issuePipeline] Requested files:\n${round1.requestedFiles.map(f => `  - ${f}`).join("\n")}\x1b[0m`);

    // Build candidates from Gemini's requested file list
    const round2Candidates: CandidateFileEntry[] = round1.requestedFiles
        .filter(fileId => input.graphFileIds.has(fileId)) // only files we know about
        .map(fileId => ({ fileId, source: "gemini-directed" as const }));

    let round2Snippets: CodeSnippet[] = [];
    try {
        round2Snippets = await fetchSnippets(
            round2Candidates,
            retrieval,
            intent,
            input.owner,
            input.repo,
            input.commitSha,
        );
        console.log(`\x1b[32m[issuePipeline] Round 2: fetched ${round2Snippets.length} additional snippets\x1b[0m`);
    } catch (err) {
        console.warn("\x1b[31m[issuePipeline] Round 2 snippet fetching failed:\x1b[0m", (err as Error).message);
    }

    // Combine all snippets and get final answer
    const allSnippets = [...snippets, ...round2Snippets];
    const totalSnippets = allSnippets.length;

    const finalResult = await callGeminiForMappingFinal(input.issue, allSnippets, input.linkedPRs);

    let geminiResult = finalResult;
    if (!geminiResult || geminiResult.affectedFiles.length === 0) {
        console.log("\x1b[33m[issuePipeline] Round 2 failed or returned 0 files. Falling back to Round 1 results.\x1b[0m");
        geminiResult = {
            affectedFiles: round1.affectedFiles,
            summary: round1.summary,
            fixApproach: round1.fixApproach,
        };
    } else {
        console.log(`\x1b[35m[issuePipeline] Round 2 FINAL — AI returned ${geminiResult.affectedFiles.length} files:\n${geminiResult.affectedFiles.map(f => `  - ${f.fileId} (confidence: ${f.confidence})`).join("\n")}\x1b[0m`);
    }

    return { geminiResult, snippetCount: totalSnippets };
}

// ── Legacy fallback ───────────────────────────────────────────────────────────

/**
 * @deprecated Backward compat for repos without RetrievalIndex.
 */
async function runLegacyPipeline(
    input: PipelineInput,
): Promise<{ geminiResult: GeminiMappingResult | null; snippetCount: number }> {
    console.log("\x1b[33m[issuePipeline] using legacy pipeline (no retrieval index)\x1b[0m");

    const geminiResult = await callGeminiForMapping(
        input.issue,
        [],
        input.linkedPRs,
    );

    return { geminiResult, snippetCount: 0 };
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run the complete 3-stage issue mapping pipeline.
 *
 * Stage 1: Token traversal (free) → candidates
 * Stage 2: Gemini graph navigation (only if Stage 1 insufficient)
 * Stage 3: Gemini-directed snippet fetching (max 2 rounds)
 *
 * @param input    All inputs needed for the pipeline
 * @returns        PipelineResult with Gemini output and diagnostic metadata
 */
export async function runIssueMappingPipeline(
    input: PipelineInput,
): Promise<PipelineResult> {
    const fallbackFiles: AffectedFile[] = []; // deterministic fallback removed

    // ── Stage 1: Token extraction + graph traversal ───────────────────────────
    const commentBodies = input.issue.comments.map(c => c.body);
    const intent = extractSearchIntent(input.issue.title, input.issue.body, commentBodies);

    console.log(
        `\x1b[32m[issuePipeline] STAGE 1 — intent extracted: ` +
        `entities=[${intent.entities.slice(0, 8).join(", ")}], ` +
        `isVague=${intent.isVague}\x1b[0m`
    );

    // Load RetrievalIndex
    const retrieval = await loadRetrievalIndex(input.owner, input.repo);

    if (!retrieval) {
        const { geminiResult, snippetCount } = await runLegacyPipeline(input);
        return {
            geminiResult,
            usedNewPipeline: false,
            snippetCount,
            isVague: intent.isVague,
            intent,
            fallbackFiles,
        };
    }

    // Run Stage 1 and Stage 2 in parallel
    let stage1Candidates: CandidateSet;
    let stage2RequestedFiles: string[] = [];

    try {
        const stage1Promise = Promise.resolve().then(() =>
            traverseGraph(intent, retrieval, input.linkedPRs, input.graphFileIds)
        );
        const stage2Promise = (async () => {
            try {
                const graphMap = buildCompactGraphMap(retrieval);
                console.log(`\x1b[36m[issuePipeline] STAGE 2 — graph map: ${graphMap.split("\n").length} files, ${graphMap.length} chars\x1b[0m`);
                return await callGeminiForGraphNavigation(input.issue, graphMap);
            } catch (err) {
                console.warn("\x1b[31m[issuePipeline] STAGE 2 failed:\x1b[0m", (err as Error).message);
                return [];
            }
        })();

        const [s1, s2] = await Promise.all([stage1Promise, stage2Promise]);
        stage1Candidates = s1;
        stage2RequestedFiles = s2;

        console.log(
            `\x1b[34m[issuePipeline] STAGE 1 — graph traversal found ${stage1Candidates.files.length} candidates ` +
            `(${stage1Candidates.files.filter(f => f.source === "pr").length} from PRs)\x1b[0m`
        );
        console.log(`\x1b[34m[issuePipeline] STAGE 2 — Gemini returned ${stage2RequestedFiles.length} files\x1b[0m`);
    } catch (err) {
        console.warn("\x1b[31m[issuePipeline] STAGE 1 graph traversal failed:\x1b[0m", (err as Error).message);
        // Fall back to legacy
        const { geminiResult, snippetCount } = await runLegacyPipeline(input);
        return {
            geminiResult,
            usedNewPipeline: false,
            snippetCount,
            isVague: intent.isVague,
            intent,
            fallbackFiles,
        };
    }

    // Merge and deduplicate candidates based on source priority: pr > keyword > barrel-expansion > neighborhood > gemini-directed
    const SOURCE_PRIORITY: Record<string, number> = {
        "pr": 5,
        "keyword": 4,
        "barrel-expansion": 3,
        "neighborhood": 2,
        "gemini-directed": 1,
    };

    const mergedMap = new Map<string, CandidateFileEntry>();

    // Add Stage 1 candidates
    for (const fileEntry of stage1Candidates.files) {
        mergedMap.set(fileEntry.fileId, fileEntry);
    }

    // Merge Stage 2 requested files
    for (const fileId of stage2RequestedFiles) {
        if (!input.graphFileIds.has(fileId)) continue; // only files we know about

        const newEntry: CandidateFileEntry = { fileId, source: "gemini-directed" as const };
        const existing = mergedMap.get(fileId);

        if (existing) {
            const existingPriority = SOURCE_PRIORITY[existing.source] || 0;
            const newPriority = SOURCE_PRIORITY[newEntry.source] || 0;
            if (newPriority > existingPriority) {
                mergedMap.set(fileId, newEntry);
            }
        } else {
            mergedMap.set(fileId, newEntry);
        }
    }

    const mergedCandidates = Array.from(mergedMap.values());
    console.log(`\x1b[32m[issuePipeline] Merged and deduplicated to ${mergedCandidates.length} candidate files\x1b[0m`);
    console.log(`\x1b[36m[issuePipeline] FINAL MERGED CANDIDATES:\n${mergedCandidates.map(c => `  - [${c.source}] ${c.fileId}`).join("\n")}\x1b[0m`);

    // ── Stage 3: Iterative Gemini mapping ─────────────────────────────────────
    if (mergedCandidates.length === 0) {
        console.log("\x1b[31m[issuePipeline] no candidates after Stage 1 + 2 — returning empty\x1b[0m");
        return {
            geminiResult: null,
            usedNewPipeline: true,
            snippetCount: 0,
            isVague: intent.isVague,
            intent,
            fallbackFiles,
        };
    }

    try {
        console.log(`\x1b[34m[issuePipeline] STAGE 3 — starting iterative mapping with ${mergedCandidates.length} candidates\x1b[0m`);
        const { geminiResult, snippetCount } = await runStage3(
            mergedCandidates, retrieval, intent, input
        );
        return {
            geminiResult,
            usedNewPipeline: true,
            snippetCount,
            isVague: intent.isVague,
            intent,
            fallbackFiles,
        };
    } catch (err) {
        console.error("\x1b[31m[issuePipeline] Stage 3 threw unexpectedly:\x1b[0m", (err as Error).message);
        const { geminiResult, snippetCount } = await runLegacyPipeline(input);
        return {
            geminiResult,
            usedNewPipeline: false,
            snippetCount,
            isVague: intent.isVague,
            intent,
            fallbackFiles,
        };
    }
}
