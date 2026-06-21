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
import { traverseGraph, buildCompactGraphMap, MIN_CANDIDATES_FOR_STAGE1 } from "./issueMapper";
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

export async function loadRetrievalIndex(owner: string, repo: string): Promise<RetrievalIndex | null> {
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

// ── Round-2 path resolution ───────────────────────────────────────────────────

/**
 * Resolve the file paths Gemini asks for in Round 1 against the real graph.
 * Tries exact match, then basename match, then suffix match — because Gemini
 * frequently returns a slightly different path string than our fileId. Without
 * this, Round 2 used to fetch zero files and waste a full Pro call.
 */
function resolveRequestedFiles(requested: string[], graphFileIds: Set<string>): string[] {
    const out = new Set<string>();
    const ids = [...graphFileIds];
    const byBase = new Map<string, string[]>();
    for (const id of ids) {
        const base = id.split("/").pop()?.toLowerCase() ?? id.toLowerCase();
        (byBase.get(base) ?? byBase.set(base, []).get(base)!).push(id);
    }
    for (const raw of requested) {
        const norm = raw.replace(/\\/g, "/").replace(/^\.\//, "").trim();
        if (graphFileIds.has(norm)) { out.add(norm); continue; }
        const lower = norm.toLowerCase();
        const base = lower.split("/").pop() ?? lower;
        const baseHits = byBase.get(base) ?? [];
        if (baseHits.length === 1) { out.add(baseHits[0]); continue; }
        // ambiguous basename or none — try suffix match
        const suffixHit = ids.find(id => id.toLowerCase().endsWith("/" + lower) || id.toLowerCase().endsWith(lower));
        if (suffixHit) { out.add(suffixHit); continue; }
        // if basename hit multiple, take the first as a last resort
        if (baseHits.length > 1) out.add(baseHits[0]);
    }
    return [...out];
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

    // ── Phase 4 gate: Round 2 is EXCEPTIONAL, not the default ──────────────────
    // The expensive second Pro call only earns its cost when Round 1 produced
    // NOTHING usable AND named files we can actually fetch. If Round 1 already
    // returned affected files, accept them — do not pay for a second call.
    if (round1.affectedFiles.length > 0) {
        console.log(`\x1b[32m[issuePipeline] Round 1 returned ${round1.affectedFiles.length} files (needsMoreContext was set) — accepting, SKIPPING Round 2\x1b[0m`);
        return {
            geminiResult: {
                affectedFiles: round1.affectedFiles,
                summary: round1.summary,
                fixApproach: round1.fixApproach,
            },
            snippetCount: snippets.length,
        };
    }

    // Resolve requested paths against the graph: exact, then basename/suffix
    // fuzzy match (Gemini often returns slightly-off paths). This is what made
    // old Round 2 fetch nothing and waste a call.
    const resolvedRequested = resolveRequestedFiles(round1.requestedFiles, input.graphFileIds);

    if (resolvedRequested.length === 0) {
        console.log(`\x1b[33m[issuePipeline] Round 1 wanted more files but NONE resolve to the graph — returning Round 1 (no Round 2)\x1b[0m`);
        return {
            geminiResult: {
                affectedFiles: round1.affectedFiles,
                summary: round1.summary,
                fixApproach: round1.fixApproach,
            },
            snippetCount: snippets.length,
        };
    }

    // ── Round 2: Gemini requested more files (and they resolve) ────────────────
    console.log(
        `\x1b[33m[issuePipeline] Round 2 triggered — ${resolvedRequested.length}/${round1.requestedFiles.length} requested files resolved: ` +
        `${round1.reason}\x1b[0m`
    );

    const round2Candidates: CandidateFileEntry[] = resolvedRequested
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

    // Stage 1: always run (pure in-memory, <10ms)
    let stage1Candidates: CandidateSet;
    try {
        stage1Candidates = traverseGraph(intent, retrieval, input.linkedPRs, input.graphFileIds);
        console.log(`\x1b[34m[issuePipeline] STAGE 1 — found ${stage1Candidates.files.length} candidates\x1b[0m`);
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

    // Stage 2: only when Stage 1 is insufficient OR issue is vague
    const needsStage2 =
        stage1Candidates.files.length < MIN_CANDIDATES_FOR_STAGE1 ||
        intent.isVague;

    let stage2RequestedFiles: string[] = [];
    if (needsStage2) {
        console.log(`\x1b[33m[issuePipeline] STAGE 2 triggered — candidates=${stage1Candidates.files.length}, isVague=${intent.isVague}\x1b[0m`);
        try {
            const graphMap = buildCompactGraphMap(retrieval);
            stage2RequestedFiles = await callGeminiForGraphNavigation(input.issue, graphMap);
            console.log(`\x1b[34m[issuePipeline] STAGE 2 — Gemini returned ${stage2RequestedFiles.length} files\x1b[0m`);
        } catch (err) {
            console.warn("\x1b[31m[issuePipeline] STAGE 2 failed:\x1b[0m", (err as Error).message);
        }
    } else {
        console.log(`\x1b[32m[issuePipeline] STAGE 1 sufficient and specific — skipping Stage 2\x1b[0m`);
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
