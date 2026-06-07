#!/usr/bin/env tsx
// src/scripts/validateDataset.ts
// ─────────────────────────────────────────────────────────────────────────────
// CLI: Validate all benchmark dataset entries against live GitHub API.
//
// Usage:
//   npx tsx src/scripts/validateDataset.ts
//   npx tsx src/scripts/validateDataset.ts --id talawa-1
//   npx tsx src/scripts/validateDataset.ts --size small
//
// Output:
//   - Console table with validation results
//   - Exits with code 1 if any entries fail validation
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { BENCHMARK_DATASET } from "../eval/dataset";
import { validateAll, validateEntry } from "../eval/prValidator";
import type { DatasetEntry } from "../eval/types";

const args = process.argv.slice(2);
const filterById   = args.includes("--id")   ? args[args.indexOf("--id")   + 1] : null;
const filterBySize = args.includes("--size") ? args[args.indexOf("--size") + 1] : null;

function filterDataset(dataset: DatasetEntry[]): DatasetEntry[] {
    let filtered = dataset;
    if (filterById)   filtered = filtered.filter(e => e.id === filterById);
    if (filterBySize) filtered = filtered.filter(e => e.size === filterBySize);
    return filtered;
}

async function main() {
    const dataset = filterDataset(BENCHMARK_DATASET);

    console.log(`\n╔══════════════════════════════════════════════════════════╗`);
    console.log(`║  CodeMap AI — Benchmark Dataset Validation               ║`);
    console.log(`╚══════════════════════════════════════════════════════════╝\n`);
    console.log(`Validating ${dataset.length} dataset entries against GitHub API...\n`);

    const results = await validateAll(dataset, (done, total, result) => {
        const icon = result.valid ? "✅" : "❌";
        const reason = result.valid ? "" : ` [${result.rejectionReason}]`;
        console.log(
            `  [${done}/${total}] ${icon} ${result.entry.id} (${result.entry.owner}/${result.entry.repo} #${result.entry.issueNumber})${reason}`
        );
        if (!result.valid) {
            console.log(`         → ${result.summary}`);
        }
    });

    const valid   = results.filter(r => r.valid);
    const invalid = results.filter(r => !r.valid);

    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    console.log(`Results: ${valid.length} valid, ${invalid.length} rejected\n`);

    if (valid.length > 0) {
        console.log(`Valid entries (${valid.length}):`);
        for (const r of valid) {
            console.log(
                `  ✅ ${r.entry.id.padEnd(16)} ${(`${r.entry.owner}/${r.entry.repo}`).padEnd(40)} ` +
                `issue=#${r.entry.issueNumber} pr=#${r.entry.prNumber} ` +
                `files=${r.codeFileCount}`
            );
        }
    }

    if (invalid.length > 0) {
        console.log(`\nRejected entries (${invalid.length}):`);
        for (const r of invalid) {
            console.log(`  ❌ ${r.entry.id.padEnd(16)} [${r.rejectionReason}] ${r.summary}`);
        }

        console.log(`\n⚠  ${invalid.length} entries will be SKIPPED during evaluation.`);
        console.log(`   Update dataset.ts with correct issue/PR pairs to fix this.\n`);
    }

    // Size breakdown
    const sizes = ["small", "medium", "large", "very_large"] as const;
    console.log(`\nValid entries by size:`);
    for (const size of sizes) {
        const count = valid.filter(r => r.entry.size === size).length;
        const total = dataset.filter(e => e.size === size).length;
        const bar = "█".repeat(count) + "░".repeat(Math.max(0, total - count));
        console.log(`  ${size.padEnd(12)} ${bar} ${count}/${total}`);
    }

    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    process.exit(invalid.length > 0 ? 1 : 0);
}

main().catch(err => {
    console.error("Validation failed:", err);
    process.exit(1);
});
