#!/usr/bin/env tsx
// src/scripts/runEval.ts
// ─────────────────────────────────────────────────────────────────────────────
// Main CLI entrypoint for the CodeMap AI Issue Mapping Evaluation Framework.
//
// Usage:
//   npx tsx src/scripts/runEval.ts
//   npx tsx src/scripts/runEval.ts --id talawa-1
//   npx tsx src/scripts/runEval.ts --size small
//   npx tsx src/scripts/runEval.ts --skip-validation
//   npx tsx src/scripts/runEval.ts --output ./reports
//
// Workflow:
//   1. Validate all benchmark entries against GitHub API (unless --skip-validation)
//   2. Run evaluation on valid entries only
//   3. Write evaluation-report.json and evaluation-report.md to --output dir
//
// Prerequisites:
//   - GITHUB_TOKEN must be set in .env
//   - GCP_PROJECT_ID must be set in .env (for Vertex AI)
//   - Repos must be analyzed in CodeMap AI (graph must exist in Redis)
//
// IMPORTANT: This tool never passes PR data to the pipeline.
//   It simulates a real user who has only the issue text.
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import path from "path";
import { BENCHMARK_DATASET } from "../eval/dataset";
import { validateAll } from "../eval/prValidator";
import { runBatchEval } from "../eval/evalRunner";
import { buildReport, writeReports } from "../eval/reportGenerator";
import type { DatasetEntry, IssueEvalResult } from "../eval/types";

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const filterById       = args.includes("--id")     ? args[args.indexOf("--id")     + 1] : null;
const filterBySize     = args.includes("--size")   ? args[args.indexOf("--size")   + 1] : null;
const skipValidation   = args.includes("--skip-validation");
const outputDir        = args.includes("--output") ? args[args.indexOf("--output") + 1] : process.cwd();

// ── Dataset filter ────────────────────────────────────────────────────────────

function filterDataset(dataset: DatasetEntry[]): DatasetEntry[] {
    let filtered = dataset;
    if (filterById)   filtered = filtered.filter(e => e.id === filterById);
    if (filterBySize) filtered = filtered.filter(e => e.size === filterBySize);
    return filtered;
}

// ── Banner ────────────────────────────────────────────────────────────────────

function printBanner() {
    console.log(`\n╔════════════════════════════════════════════════════════════════╗`);
    console.log(`║  CodeMap AI — Issue Mapping Evaluation Framework               ║`);
    console.log(`║  Honest benchmarking. No shortcuts.                            ║`);
    console.log(`╚════════════════════════════════════════════════════════════════╝\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    printBanner();

    const dataset = filterDataset(BENCHMARK_DATASET);
    console.log(`Dataset: ${dataset.length} entries (${BENCHMARK_DATASET.length} total)\n`);

    // ── Phase 1: Validation ────────────────────────────────────────────────────
    let validations;

    if (skipValidation) {
        console.log(`⚠ Skipping PR validation (--skip-validation)\n`);
        // Mark everything as valid with empty prFiles (will fail in evalRunner if missing from graph)
        validations = dataset.map(entry => ({
            entry,
            valid: true,
            prFiles: [] as string[],
            codeFileCount: 0,
            summary: "Validation skipped",
        }));
    } else {
        console.log(`Phase 1: Validating ${dataset.length} dataset entries against GitHub API...\n`);
        validations = await validateAll(dataset, (done, total, result) => {
            const icon = result.valid ? "✅" : "❌";
            console.log(
                `  [${done}/${total}] ${icon} ${result.entry.id} — ${result.summary}`
            );
        });
    }

    const validEntries = validations.filter(v => v.valid);
    const rejectedEntries = validations.filter(v => !v.valid);

    console.log(`\n→ Validation complete: ${validEntries.length} valid, ${rejectedEntries.length} rejected\n`);

    if (validEntries.length === 0) {
        console.error("No valid entries to evaluate. Check dataset.ts issue/PR numbers and GitHub API access.");
        process.exit(1);
    }

    if (rejectedEntries.length > 0) {
        console.log("Rejected entries:");
        for (const r of rejectedEntries) {
            console.log(`  ❌ ${r.entry.id}: ${r.summary}`);
        }
        console.log();
    }

    // ── Phase 2: Evaluation ────────────────────────────────────────────────────
    console.log(`Phase 2: Running issue mapping evaluation on ${validEntries.length} entries...\n`);
    console.log(`⚠ This calls the real CodeMap AI pipeline. Ensure repos are analyzed in Redis.\n`);

    const allResults = await runBatchEval(validations, (done, total, result) => {
        if ("error" in result) {
            console.log(`  [${done}/${total}] ⛔ ${result.entry.id}: ${result.error}`);
        } else {
            const r = result as IssueEvalResult;
            const f1Bar = "█".repeat(Math.round(r.f1 * 10)) + "░".repeat(10 - Math.round(r.f1 * 10));
            console.log(
                `  [${done}/${total}] ${r.f1 >= 0.5 ? "✅" : r.f1 > 0 ? "⚠️" : "❌"} ${r.entry.id.padEnd(16)} ` +
                `P=${r.precision.toFixed(2)} R=${r.recall.toFixed(2)} F1=${r.f1.toFixed(2)} [${f1Bar}]`
            );
        }
    });

    // Separate successful results from errors
    const successfulResults = allResults.filter((r): r is IssueEvalResult => !("error" in r));
    const failedResults = allResults
        .filter(r => "error" in r)
        .map(r => ({ entry: (r as any).entry, errorMessage: (r as any).error }));

    // ── Phase 3: Report generation ─────────────────────────────────────────────
    console.log(`\nPhase 3: Generating reports...\n`);

    const report = buildReport(successfulResults, validations, failedResults);
    const { jsonPath, mdPath } = writeReports(report, outputDir);

    // ── Summary ────────────────────────────────────────────────────────────────
    console.log(`\n╔════════════════════════════════════════════════════════════════╗`);
    console.log(`║  EVALUATION COMPLETE                                           ║`);
    console.log(`╚════════════════════════════════════════════════════════════════╝\n`);
    console.log(`  Issues evaluated:  ${report.totalIssuesEvaluated}`);
    console.log(`  Failed/skipped:    ${failedResults.length + rejectedEntries.length}`);
    console.log(`\n  ┌─────────────────────────────────────┐`);
    console.log(`  │ Avg Precision:  ${report.overall.avgPrecision.toFixed(3).padStart(6)}               │`);
    console.log(`  │ Avg Recall:     ${report.overall.avgRecall.toFixed(3).padStart(6)}               │`);
    console.log(`  │ Avg F1:         ${report.overall.avgF1.toFixed(3).padStart(6)}               │`);
    console.log(`  │ Recall@5:       ${report.overall.avgRecallAt5.toFixed(3).padStart(6)}               │`);
    console.log(`  │ Recall@10:      ${report.overall.avgRecallAt10.toFixed(3).padStart(6)}               │`);
    console.log(`  │ Recall@20:      ${report.overall.avgRecallAt20.toFixed(3).padStart(6)}               │`);
    console.log(`  └─────────────────────────────────────┘\n`);
    console.log(`  Reports written to:`);
    console.log(`    JSON: ${jsonPath}`);
    console.log(`    MD:   ${mdPath}\n`);

    if (report.recommendations.length > 0) {
        console.log(`  Top recommendation:`);
        console.log(`    #1: ${report.recommendations[0].title}`);
        console.log(`    ${report.recommendations[0].evidenceSummary}\n`);
    }

    // Disconnect Redis
    try {
        const { redisConnection } = await import("../queue/jobQueue");
        await redisConnection.quit();
    } catch { /* non-fatal */ }

    process.exit(0);
}

main().catch(err => {
    console.error("\n[runEval] Fatal error:", err);
    process.exit(1);
});
