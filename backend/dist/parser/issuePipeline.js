"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.runIssueMappingPipeline = runIssueMappingPipeline;
const issueUnderstanding_1 = require("./issueUnderstanding");
const issueMapper_1 = require("./issueMapper");
const snippetFetcher_1 = require("./snippetFetcher");
const issueAnalyzer_1 = require("./issueAnalyzer");
const jobQueue_1 = require("../queue/jobQueue");
// ── RetrievalIndex loader ─────────────────────────────────────────────────────
async function loadRetrievalIndex(owner, repo) {
    try {
        const key = `retrieval:${owner}:${repo}`;
        const raw = await jobQueue_1.redisConnection.get(key);
        if (!raw) {
            console.log(`\x1b[33m[issuePipeline] no retrieval index in Redis for ${owner}/${repo} — using legacy\x1b[0m`);
            return null;
        }
        const index = JSON.parse(raw);
        console.log(`\x1b[32m[issuePipeline] loaded retrieval index: ${index.files.length} files\x1b[0m`);
        return index;
    }
    catch (err) {
        console.warn("\x1b[31m[issuePipeline] failed to load retrieval index:\x1b[0m", err.message);
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
async function runStage3(candidates, retrieval, intent, input) {
    // ── Round 1: Initial snippet fetch + Gemini ───────────────────────────────
    let snippets = [];
    try {
        snippets = await (0, snippetFetcher_1.fetchSnippets)(candidates, retrieval, intent, input.owner, input.repo, input.commitSha);
        console.log(`\x1b[32m[issuePipeline] Round 1: fetched ${snippets.length} snippets\x1b[0m`);
    }
    catch (err) {
        console.warn("\x1b[31m[issuePipeline] Round 1 snippet fetching failed:\x1b[0m", err.message);
    }
    const round1 = await (0, issueAnalyzer_1.callGeminiForMappingRound1)(input.issue, snippets, input.linkedPRs);
    if (!round1) {
        console.log("\x1b[31m[issuePipeline] Round 1 Gemini call returned null\x1b[0m");
        return { geminiResult: null, snippetCount: snippets.length };
    }
    // ── Check if Gemini is satisfied ──────────────────────────────────────────
    if (!round1.needsMoreContext) {
        // Gemini gave a final answer in Round 1
        if (round1.affectedFiles.length > 0) {
            console.log(`\x1b[35m[issuePipeline] Round 1 FINAL — AI returned ${round1.affectedFiles.length} files:\n${round1.affectedFiles.map(f => `  - ${f.fileId} (confidence: ${f.confidence})`).join("\n")}\x1b[0m`);
        }
        else {
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
    console.log(`\x1b[33m[issuePipeline] Round 2 triggered — Gemini wants ${round1.requestedFiles.length} more files: ` +
        `${round1.reason}\x1b[0m`);
    console.log(`\x1b[36m[issuePipeline] Requested files:\n${round1.requestedFiles.map(f => `  - ${f}`).join("\n")}\x1b[0m`);
    // Build candidates from Gemini's requested file list
    const round2Candidates = round1.requestedFiles
        .filter(fileId => input.graphFileIds.has(fileId)) // only files we know about
        .map(fileId => ({ fileId, source: "gemini-directed" }));
    let round2Snippets = [];
    try {
        round2Snippets = await (0, snippetFetcher_1.fetchSnippets)(round2Candidates, retrieval, intent, input.owner, input.repo, input.commitSha);
        console.log(`\x1b[32m[issuePipeline] Round 2: fetched ${round2Snippets.length} additional snippets\x1b[0m`);
    }
    catch (err) {
        console.warn("\x1b[31m[issuePipeline] Round 2 snippet fetching failed:\x1b[0m", err.message);
    }
    // Combine all snippets and get final answer
    const allSnippets = [...snippets, ...round2Snippets];
    const totalSnippets = allSnippets.length;
    const finalResult = await (0, issueAnalyzer_1.callGeminiForMappingFinal)(input.issue, allSnippets, input.linkedPRs);
    if (finalResult && finalResult.affectedFiles.length > 0) {
        console.log(`\x1b[35m[issuePipeline] Round 2 FINAL — AI returned ${finalResult.affectedFiles.length} files:\n${finalResult.affectedFiles.map(f => `  - ${f.fileId} (confidence: ${f.confidence})`).join("\n")}\x1b[0m`);
    }
    else {
        console.log("\x1b[31m[issuePipeline] Round 2 FINAL — AI returned 0 files\x1b[0m");
    }
    return { geminiResult: finalResult, snippetCount: totalSnippets };
}
// ── Legacy fallback ───────────────────────────────────────────────────────────
/**
 * @deprecated Backward compat for repos without RetrievalIndex.
 */
async function runLegacyPipeline(input) {
    console.log("\x1b[33m[issuePipeline] using legacy pipeline (no retrieval index)\x1b[0m");
    const geminiResult = await (0, issueAnalyzer_1.callGeminiForMapping)(input.issue, [], input.linkedPRs);
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
async function runIssueMappingPipeline(input) {
    const fallbackFiles = []; // deterministic fallback removed
    // ── Stage 1: Token extraction + graph traversal ───────────────────────────
    const commentBodies = input.issue.comments.map(c => c.body);
    const intent = (0, issueUnderstanding_1.extractSearchIntent)(input.issue.title, input.issue.body, commentBodies);
    console.log(`\x1b[32m[issuePipeline] STAGE 1 — intent extracted: ` +
        `entities=[${intent.entities.slice(0, 8).join(", ")}], ` +
        `isVague=${intent.isVague}\x1b[0m`);
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
    // Token-based graph traversal
    let candidates;
    try {
        candidates = (0, issueMapper_1.traverseGraph)(intent, retrieval, input.linkedPRs, input.graphFileIds);
        console.log(`\x1b[34m[issuePipeline] STAGE 1 — graph traversal found ${candidates.files.length} candidates ` +
            `(${candidates.files.filter(f => f.source === "pr").length} from PRs)\x1b[0m`);
        console.log(`\x1b[36m[issuePipeline] STAGE 1 CANDIDATES:\n${candidates.files.map(c => `  - [${c.source}] ${c.fileId}`).join("\n")}\x1b[0m`);
    }
    catch (err) {
        console.warn("\x1b[31m[issuePipeline] STAGE 1 graph traversal failed:\x1b[0m", err.message);
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
    // ── Stage 2: Gemini graph navigation (only if Stage 1 insufficient) ──────
    if (candidates.files.length < issueMapper_1.MIN_CANDIDATES_FOR_STAGE1) {
        console.log(`\x1b[33m[issuePipeline] STAGE 2 — only ${candidates.files.length} candidates from Stage 1 ` +
            `(need ${issueMapper_1.MIN_CANDIDATES_FOR_STAGE1}), sending graph map to Gemini\x1b[0m`);
        try {
            const graphMap = (0, issueMapper_1.buildCompactGraphMap)(retrieval);
            console.log(`\x1b[36m[issuePipeline] STAGE 2 — graph map: ${graphMap.split("\n").length} files, ${graphMap.length} chars\x1b[0m`);
            const requestedFiles = await (0, issueAnalyzer_1.callGeminiForGraphNavigation)(input.issue, graphMap);
            if (requestedFiles.length > 0) {
                // Add Gemini-directed files to the candidate set
                const existingIds = new Set(candidates.files.map(c => c.fileId));
                const newCandidates = requestedFiles
                    .filter(fileId => !existingIds.has(fileId) && input.graphFileIds.has(fileId))
                    .map(fileId => ({ fileId, source: "gemini-directed" }));
                candidates.files.push(...newCandidates);
                console.log(`\x1b[32m[issuePipeline] STAGE 2 — added ${newCandidates.length} Gemini-directed candidates ` +
                    `(total: ${candidates.files.length})\x1b[0m`);
                console.log(`\x1b[36m[issuePipeline] STAGE 2 NEW CANDIDATES:\n${newCandidates.map(c => `  - [gemini-directed] ${c.fileId}`).join("\n")}\x1b[0m`);
            }
            else {
                console.log("\x1b[33m[issuePipeline] STAGE 2 — Gemini returned 0 additional files\x1b[0m");
            }
        }
        catch (err) {
            console.warn("\x1b[31m[issuePipeline] STAGE 2 failed:\x1b[0m", err.message);
            // Non-fatal — proceed with Stage 1 candidates only
        }
    }
    else {
        console.log(`\x1b[32m[issuePipeline] STAGE 1 sufficient (${candidates.files.length} >= ${issueMapper_1.MIN_CANDIDATES_FOR_STAGE1}) — skipping Stage 2\x1b[0m`);
    }
    // ── Stage 3: Iterative Gemini mapping ─────────────────────────────────────
    if (candidates.files.length === 0) {
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
        console.log(`\x1b[34m[issuePipeline] STAGE 3 — starting iterative mapping with ${candidates.files.length} candidates\x1b[0m`);
        const { geminiResult, snippetCount } = await runStage3(candidates.files, retrieval, intent, input);
        return {
            geminiResult,
            usedNewPipeline: true,
            snippetCount,
            isVague: intent.isVague,
            intent,
            fallbackFiles,
        };
    }
    catch (err) {
        console.error("\x1b[31m[issuePipeline] Stage 3 threw unexpectedly:\x1b[0m", err.message);
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
