// src/eval/evalRunner.ts
// ─────────────────────────────────────────────────────────────────────────────
// Per-issue evaluation runner.
//
// For each benchmark entry:
//   1. Verify the repo has been analyzed (graph in Redis)
//   2. Fetch the issue text from GitHub (same data the real pipeline uses)
//   3. Run runIssueMappingPipeline() with NO PR data (simulates real user)
//   4. Compute metrics against the ground-truth PR files from prValidator
//   5. Classify missed files
//   6. Return IssueEvalResult
//
// IMPORTANT: The pipeline is called with linkedPRs=[] — we deliberately do not
// pass the real PR to avoid test leakage. The issue text alone drives the AI.
// ─────────────────────────────────────────────────────────────────────────────

import { redisConnection } from "../queue/jobQueue";
import { fetchIssue, fetchIssueComments } from "../github/issueClient";
import { runIssueMappingPipeline } from "../parser/issuePipeline";
import { computeMetrics } from "./metricsCalculator";
import { classifyMisses } from "./missClassifier";
import type { DatasetEntry, IssueEvalResult } from "./types";
import type { PRValidationResult } from "./types";

// ── Graph loader ──────────────────────────────────────────────────────────────

interface GraphFile {
    id: string;
    label: string;
    architecturalImportance?: number;
}

async function loadGraphFiles(owner: string, repo: string): Promise<GraphFile[] | null> {
    try {
        const raw = await redisConnection.get(`graph:${owner}:${repo}`);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed?.files)) return null;
        return parsed.files as GraphFile[];
    } catch {
        return null;
    }
}

async function loadCommitSha(owner: string, repo: string): Promise<string | null> {
    try {
        const raw = await redisConnection.get(`graph:${owner}:${repo}`);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed.commitSha as string | null ?? null;
    } catch {
        return null;
    }
}

// ── Main per-issue runner ─────────────────────────────────────────────────────

export async function runSingleEval(
    entry: DatasetEntry,
    validation: PRValidationResult
): Promise<IssueEvalResult> {
    const start = Date.now();
    const timestamp = new Date().toISOString();

    // The actual ground truth — only code files from the PR
    const actualFiles = validation.prFiles.filter(f => {
        const p = f.toLowerCase();
        const ext = "." + p.split(".").pop();
        const SUPPORTED_EXTENSIONS = new Set([
            ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"
        ]);
        const isDoc = [".md", ".mdx", ".txt", ".rst", ".adoc", ".wiki"].some(e => p.endsWith(e)) ||
                      ["docs/", "documentation/", ".github/", "changelog", "license", "readme"].some(path => p.includes(path));
        const isDep = ["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "go.sum", "go.mod", "gemfile.lock", "cargo.lock", "poetry.lock"].some(
            n => p.endsWith(n)
        );
        const isGenerated = [/\.generated\.(ts|js|go|py)$/i, /\/migrations\//, /\/generated\//, /\.pb\.go$/, /\.pb\.ts$/, /_pb\.d\.ts$/, /vendor\//].some(
            pat => pat.test(f)
        );
        return SUPPORTED_EXTENSIONS.has(ext) && !isDoc && !isDep && !isGenerated;
    });

    // Step 1: Ensure graph is cached for this repo
    const graphFiles = await loadGraphFiles(entry.owner, entry.repo);
    if (!graphFiles || graphFiles.length === 0) {
        return makeErrorResult(entry, validation, timestamp, start, 
            `Repo ${entry.owner}/${entry.repo} has no graph in Redis. Run CodeMap AI analysis first.`
        );
    }

    const commitSha = await loadCommitSha(entry.owner, entry.repo);
    if (!commitSha) {
        return makeErrorResult(entry, validation, timestamp, start,
            `Could not recover commitSha for ${entry.owner}/${entry.repo}`
        );
    }

    // Step 2: Fetch issue from GitHub — ONLY issue text, no PR info
    let issue;
    try {
        issue = await fetchIssue(entry.owner, entry.repo, entry.issueNumber);
    } catch (err: any) {
        return makeErrorResult(entry, validation, timestamp, start,
            `Failed to fetch issue #${entry.issueNumber}: ${err?.message}`
        );
    }

    const comments = await fetchIssueComments(entry.owner, entry.repo, entry.issueNumber, 20)
        .catch(() => []);

    // Step 3: Run the pipeline — deliberately NO linked PRs (simulates pre-PR state)
    const graphFileIds = new Set(graphFiles.map(f => f.id));

    let pipelineResult;
    try {
        pipelineResult = await runIssueMappingPipeline({
            owner: entry.owner,
            repo: entry.repo,
            commitSha,
            issue: {
                title: issue.title,
                body: issue.body,
                comments,
                linkedPRs: [], // NEVER pass real PR — this simulates real usage
            },
            linkedPRs: [],
            graphFileIds,
            legacyFiles: graphFiles,
        });
    } catch (err: any) {
        return makeErrorResult(entry, validation, timestamp, start,
            `Pipeline threw: ${err?.message}`
        );
    }

    // Step 4: Extract predicted files
    const affectedFiles = pipelineResult.geminiResult?.affectedFiles ?? [];
    const predictedFiles = affectedFiles.map(f => ({
        fileId: f.fileId,
        confidence: f.confidence,
        reason: f.reason,
    }));

    // Step 5: Compute metrics
    const metrics = computeMetrics(predictedFiles, actualFiles);

    // Step 6: Classify missed files
    const classifiedMisses = classifyMisses(metrics.missedFiles);

    const source = pipelineResult.geminiResult
        ? (pipelineResult.usedNewPipeline ? "ai" : "deterministic")
        : "error";

    return {
        entry,
        issueTitle: issue.title,
        issueUrl: issue.htmlUrl,

        predictedFiles,
        actualFiles,

        matchedFiles: metrics.matchedFiles,
        missedFiles: metrics.missedFiles,
        extraFiles: metrics.extraFiles,

        precision: metrics.precision,
        recall: metrics.recall,
        f1: metrics.f1,
        recallAt5: metrics.recallAt5,
        recallAt10: metrics.recallAt10,
        recallAt20: metrics.recallAt20,

        classifiedMisses,

        pipelineSource: source as any,
        snippetCount: pipelineResult.snippetCount,
        usedNewPipeline: pipelineResult.usedNewPipeline,

        durationMs: Date.now() - start,
        timestamp,
    };
}

// ── Batch runner ──────────────────────────────────────────────────────────────

export async function runBatchEval(
    validatedEntries: PRValidationResult[],
    onProgress?: (done: number, total: number, result: IssueEvalResult | { error: string; entry: DatasetEntry }) => void
): Promise<Array<IssueEvalResult | { error: string; entry: DatasetEntry }>> {
    const validEntries = validatedEntries.filter(v => v.valid);
    const results: Array<IssueEvalResult | { error: string; entry: DatasetEntry }> = [];

    console.log(`[evalRunner] Running evaluation on ${validEntries.length} valid entries`);

    for (let i = 0; i < validEntries.length; i++) {
        const validation = validEntries[i];
        const entry = validation.entry;

        console.log(`[evalRunner] [${i + 1}/${validEntries.length}] ${entry.id}: ${entry.owner}/${entry.repo} #${entry.issueNumber}`);

        try {
            const result = await runSingleEval(entry, validation);
            results.push(result);
            console.log(
                `[evalRunner] ✓ ${entry.id} — P=${result.precision.toFixed(2)} R=${result.recall.toFixed(2)} F1=${result.f1.toFixed(2)}`
            );
        } catch (err: any) {
            const errResult = { error: err?.message ?? "Unknown error", entry };
            results.push(errResult);
            console.error(`[evalRunner] ✗ ${entry.id} — ${err?.message}`);
        }

        onProgress?.(i + 1, validEntries.length, results[results.length - 1]);

        // Pause between issues to avoid hammering GitHub API and Vertex AI
        if (i < validEntries.length - 1) {
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    return results;
}

// ── Error result helper ───────────────────────────────────────────────────────

function makeErrorResult(
    entry: DatasetEntry,
    validation: PRValidationResult,
    timestamp: string,
    startMs: number,
    errorMessage: string
): IssueEvalResult {
    return {
        entry,
        issueTitle: "",
        issueUrl: `https://github.com/${entry.owner}/${entry.repo}/issues/${entry.issueNumber}`,
        predictedFiles: [],
        actualFiles: validation.prFiles,
        matchedFiles: [],
        missedFiles: validation.prFiles,
        extraFiles: [],
        precision: 0,
        recall: 0,
        f1: 0,
        recallAt5: 0,
        recallAt10: 0,
        recallAt20: 0,
        classifiedMisses: classifyMisses(validation.prFiles),
        pipelineSource: "error",
        snippetCount: 0,
        usedNewPipeline: false,
        errorMessage,
        durationMs: Date.now() - startMs,
        timestamp,
    };
}
