// src/scripts/evalIssueMapper.ts
// ─────────────────────────────────────────────────────────────────────────────
// Offline accuracy + cost eval for the issue-mapping pipeline.
//
// WHAT IT MEASURES (per issue, then aggregated):
//   - precision@k / recall@k for k ∈ {1,3,5,10}
//   - MRR (reciprocal rank of the first correct file)
//   - Gemini calls, tokens, and $ per map (via aiTelemetry)
//   - Round-2 rate (how often the expensive second Pro call fires)
//   - new-pipeline vs legacy, snippet count, vagueness
//
// GROUND TRUTH:
//   The files changed by the merged PR(s) that closed the issue — i.e. what a
//   human actually edited. We FETCH the linked PRs only to build ground truth;
//   by default we DO NOT pass them into the pipeline (usePrContext=false), so
//   the mapper cannot "cheat" by being handed the answer. Recall is measured
//   against the subset of changed files that exist in the analyzed graph (the
//   achievable ceiling); coverage of out-of-graph truth is reported separately.
//
// PREREQUISITES (run against your dev backend's data):
//   - The repo must already be analyzed (so retrieval:{owner}:{repo} and the
//     file graph exist). Run an analysis first, then run this.
//   - backend/.env must have REDIS_URL, GITHUB_TOKEN, and GCP creds (api.json
//     or GCP_SA_KEY) for the live Gemini calls.
//
// USAGE:
//   npm run eval:issues                       # uses src/scripts/evalCases.json
//   npm run eval:issues -- path/to/cases.json # custom dataset
//   npm run eval:issues -- --use-pr-context   # allow PR context (sanity ceiling)
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from "fs";
import * as path from "path";

import { runIssueMappingPipeline, type PipelineInput } from "../parser/issuePipeline";
import { fetchIssue, fetchIssueComments, fetchLinkedPRs } from "../github/issueClient";
import type { LinkedPR } from "../github/issueClient";
import { getFileGraph, getLatestSha } from "../storage/artifactStore";
import { redisConnection } from "../queue/jobQueue";
import { beginAiRun, endAiRun, type AiRunTotals } from "../parser/aiTelemetry";

// ── Dataset ───────────────────────────────────────────────────────────────────

interface EvalCase {
    owner: string;
    repo: string;
    issueNumber: number;
    /** Optional explicit ground truth; overrides linked-PR derivation. */
    expectedFiles?: string[];
    /** Allow the pipeline to see the linked PRs for this case (default false). */
    usePrContext?: boolean;
    note?: string;
}

const K_VALUES = [1, 3, 5, 10];

// Source extensions the parser indexes — used only for diagnostics.
const SUPPORTED_EXT = new Set([
    ".js", ".ts", ".jsx", ".tsx", ".py", ".go",
    ".c", ".cpp", ".cc", ".cxx", ".c++",
    ".h", ".hpp", ".hh", ".hxx",
]);

function normPath(p: string): string {
    return p.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

function ext(p: string): string {
    const i = p.lastIndexOf(".");
    return i < 0 ? "" : p.slice(i).toLowerCase();
}

// ── Metrics ───────────────────────────────────────────────────────────────────

interface CaseMetrics {
    label: string;
    skipped?: string;
    truthRaw: number;
    truthInGraph: number;
    predicted: number;
    precisionAtK: Record<number, number>;
    recallAtK: Record<number, number>;
    mrr: number;
    usedNewPipeline: boolean;
    isVague: boolean;
    snippetCount: number;
    ai: AiRunTotals;
    round2: boolean;
}

/** Case-insensitive membership against a normalized truth set. */
function makeMatcher(truth: Set<string>) {
    const lower = new Set([...truth].map(t => t.toLowerCase()));
    return (fileId: string) => {
        const n = normPath(fileId);
        return truth.has(n) || lower.has(n.toLowerCase());
    };
}

function scoreRanking(predicted: string[], truth: Set<string>): {
    precisionAtK: Record<number, number>;
    recallAtK: Record<number, number>;
    mrr: number;
} {
    const isHit = makeMatcher(truth);
    const precisionAtK: Record<number, number> = {};
    const recallAtK: Record<number, number> = {};
    const truthCount = truth.size || 1;

    for (const k of K_VALUES) {
        const top = predicted.slice(0, k);
        const hits = top.filter(isHit).length;
        precisionAtK[k] = top.length ? hits / top.length : 0;
        recallAtK[k] = hits / truthCount;
    }

    let mrr = 0;
    for (let i = 0; i < predicted.length; i++) {
        if (isHit(predicted[i])) { mrr = 1 / (i + 1); break; }
    }
    return { precisionAtK, recallAtK, mrr };
}

// ── Ground truth from linked PRs ──────────────────────────────────────────────

function deriveTruth(linkedPRs: LinkedPR[]): string[] {
    const merged = linkedPRs.filter(pr => pr.merged);
    const pool = merged.length > 0 ? merged : linkedPRs.filter(pr => pr.state === "closed");
    const out = new Set<string>();
    for (const pr of pool) {
        for (const f of pr.changedFiles) out.add(normPath(f));
    }
    return [...out];
}

// ── Per-case eval ─────────────────────────────────────────────────────────────

async function evalCase(c: EvalCase, forcePrContext: boolean): Promise<CaseMetrics> {
    const label = `${c.owner}/${c.repo}#${c.issueNumber}`;
    const base: CaseMetrics = {
        label, truthRaw: 0, truthInGraph: 0, predicted: 0,
        precisionAtK: {}, recallAtK: {}, mrr: 0,
        usedNewPipeline: false, isVague: false, snippetCount: 0,
        ai: { calls: 0, promptTokens: 0, candidateTokens: 0, totalTokens: 0, costUsd: 0, byOperation: {}, records: [] },
        round2: false,
    };

    const commitSha = await getLatestSha(c.owner, c.repo);
    if (!commitSha) return { ...base, skipped: "repo not analyzed (no latest-sha) — analyze it first" };

    const graph = await getFileGraph<{ files?: Array<{ id: string; label: string; architecturalImportance?: number }> }>(
        c.owner, c.repo, commitSha,
    );
    const files = graph?.files ?? [];
    if (files.length === 0) return { ...base, skipped: "file graph empty/missing in store" };
    const graphFileIds = new Set(files.map(f => normPath(f.id)));

    const issue = await fetchIssue(c.owner, c.repo, c.issueNumber);
    const comments = await fetchIssueComments(c.owner, c.repo, c.issueNumber, 20).catch(() => []);
    const linkedPRs = await fetchLinkedPRs(c.owner, c.repo, c.issueNumber).catch(() => []);

    // Ground truth
    const truthList = (c.expectedFiles?.map(normPath)) ?? deriveTruth(linkedPRs);
    const truthRaw = truthList.length;
    const truthInGraphList = truthList.filter(t =>
        graphFileIds.has(t) || [...graphFileIds].some(g => g.toLowerCase() === t.toLowerCase()),
    );
    const truth = new Set(truthInGraphList);

    if (truthRaw === 0) return { ...base, skipped: "no ground truth (no merged/closed linked PR and no expectedFiles)" };
    if (truth.size === 0) {
        return { ...base, truthRaw, skipped: `${truthRaw} truth file(s) but none in analyzed graph — re-analyze at the PR's base SHA` };
    }

    // Pipeline input — withhold PR context by default so we don't leak the answer.
    const usePr = forcePrContext || c.usePrContext === true;
    const prForPipeline = usePr ? linkedPRs : [];
    const input: PipelineInput = {
        owner: c.owner,
        repo: c.repo,
        commitSha,
        issue: { title: issue.title, body: issue.body, comments, linkedPRs: prForPipeline },
        linkedPRs: prForPipeline,
        graphFileIds: new Set(files.map(f => f.id)), // pipeline expects original ids
        legacyFiles: files,
    };

    beginAiRun();
    const result = await runIssueMappingPipeline(input);
    const ai = endAiRun();

    const predicted = (result.geminiResult?.affectedFiles ?? [])
        .slice()
        .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
        .map(f => normPath(f.fileId));

    const { precisionAtK, recallAtK, mrr } = scoreRanking(predicted, truth);

    return {
        label,
        truthRaw,
        truthInGraph: truth.size,
        predicted: predicted.length,
        precisionAtK,
        recallAtK,
        mrr,
        usedNewPipeline: result.usedNewPipeline,
        isVague: result.isVague,
        snippetCount: result.snippetCount,
        ai,
        round2: (ai.byOperation["mapping-final"] ?? 0) >= 1,
    };
}

// ── Reporting ─────────────────────────────────────────────────────────────────

function pct(x: number): string { return (x * 100).toFixed(1).padStart(5) + "%"; }

function printCase(m: CaseMetrics): void {
    if (m.skipped) {
        console.log(`\x1b[33m⊘ ${m.label} — SKIPPED: ${m.skipped}\x1b[0m`);
        return;
    }
    const pAt = K_VALUES.map(k => `P@${k}=${pct(m.precisionAtK[k])}`).join("  ");
    const rAt = K_VALUES.map(k => `R@${k}=${pct(m.recallAtK[k])}`).join("  ");
    console.log(
        `\x1b[36m> ${m.label}\x1b[0m\n` +
        `   truth=${m.truthInGraph}/${m.truthRaw} in-graph  predicted=${m.predicted}  ` +
        `MRR=${m.mrr.toFixed(3)}  ${m.usedNewPipeline ? "new" : "LEGACY"}${m.isVague ? " vague" : ""}\n` +
        `   ${pAt}\n   ${rAt}\n` +
        `   AI: ${m.ai.calls} call(s) [${Object.entries(m.ai.byOperation).map(([k, v]) => `${k}×${v}`).join(", ") || "none"}]  ` +
        `${m.ai.totalTokens} tok  $${m.ai.costUsd.toFixed(5)}  ${m.round2 ? "\x1b[31mROUND2\x1b[0m" : ""}`,
    );
}

function printAggregate(metrics: CaseMetrics[]): void {
    const scored = metrics.filter(m => !m.skipped);
    if (scored.length === 0) { console.log("\nNo scorable cases."); return; }

    const avg = (f: (m: CaseMetrics) => number) => scored.reduce((s, m) => s + f(m), 0) / scored.length;

    console.log("\n\x1b[1;35m══════════════════ AGGREGATE (" + scored.length + " scored cases) ══════════════════\x1b[0m");
    for (const k of K_VALUES) {
        console.log(`  P@${k}=${pct(avg(m => m.precisionAtK[k]))}   R@${k}=${pct(avg(m => m.recallAtK[k]))}`);
    }
    console.log(`  MRR (mean)          ${avg(m => m.mrr).toFixed(3)}`);
    console.log(`  Gemini calls / map  ${avg(m => m.ai.calls).toFixed(2)}`);
    console.log(`  Tokens / map        ${Math.round(avg(m => m.ai.totalTokens))}`);
    console.log(`  Cost / map          $${avg(m => m.ai.costUsd).toFixed(5)}`);
    console.log(`  Round-2 rate        ${pct(scored.filter(m => m.round2).length / scored.length)}`);
    console.log(`  New-pipeline rate   ${pct(scored.filter(m => m.usedNewPipeline).length / scored.length)}`);
    console.log(`  Total spend         $${scored.reduce((s, m) => s + m.ai.costUsd, 0).toFixed(4)}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const forcePrContext = args.includes("--use-pr-context");
    const datasetArg = args.find(a => !a.startsWith("--"));
    const datasetPath = datasetArg
        ? path.resolve(process.cwd(), datasetArg)
        : path.join(__dirname, "evalCases.json");

    if (!fs.existsSync(datasetPath)) {
        console.error(`\x1b[31mDataset not found: ${datasetPath}\x1b[0m`);
        process.exit(1);
    }

    const cases = JSON.parse(fs.readFileSync(datasetPath, "utf8")) as EvalCase[];
    console.log(`\x1b[1mLoaded ${cases.length} eval case(s) from ${datasetPath}\x1b[0m`);
    console.log(forcePrContext
        ? "\x1b[33mPR context: ENABLED (ceiling/sanity mode — answers may leak)\x1b[0m"
        : "PR context: withheld (honest mode)");

    const metrics: CaseMetrics[] = [];
    for (const c of cases) {
        try {
            const m = await evalCase(c, forcePrContext);
            printCase(m);
            metrics.push(m);
        } catch (err) {
            console.error(`\x1b[31m✗ ${c.owner}/${c.repo}#${c.issueNumber} threw:\x1b[0m`, (err as Error).message);
            metrics.push({
                label: `${c.owner}/${c.repo}#${c.issueNumber}`, skipped: `error: ${(err as Error).message}`,
                truthRaw: 0, truthInGraph: 0, predicted: 0, precisionAtK: {}, recallAtK: {}, mrr: 0,
                usedNewPipeline: false, isVague: false, snippetCount: 0,
                ai: { calls: 0, promptTokens: 0, candidateTokens: 0, totalTokens: 0, costUsd: 0, byOperation: {}, records: [] },
                round2: false,
            });
        }
    }

    printAggregate(metrics);

    try { await redisConnection.quit(); } catch { /* ignore */ }
    process.exit(0);
}

void SUPPORTED_EXT; void ext; // reserved for future per-extension breakdown

main().catch(err => {
    console.error("\x1b[31mEval harness fatal:\x1b[0m", err);
    process.exit(1);
});
