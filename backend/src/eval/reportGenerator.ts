// src/eval/reportGenerator.ts
// ─────────────────────────────────────────────────────────────────────────────
// Generates evaluation-report.json and evaluation-report.md from eval results.
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";
import { aggregateMetrics } from "./metricsCalculator";
import { aggregateMissPatterns } from "./missClassifier";
import type {
    IssueEvalResult,
    EvaluationReport,
    AggregateMetrics,
    MissPattern,
    Recommendation,
    DatasetEntry,
    RepoSize,
} from "./types";
import type { PRValidationResult } from "./types";

// ── Recommendation engine ─────────────────────────────────────────────────────

function generateRecommendations(
    missPatterns: MissPattern[],
    overall: AggregateMetrics,
    results: IssueEvalResult[]
): Recommendation[] {
    const recs: Recommendation[] = [];

    // Low recall overall
    if (overall.avgRecall < 0.3) {
        recs.push({
            rank: 1,
            title: "Retrieval index is missing most relevant files",
            description: "Overall recall is below 30%. The Stage 1 token traversal is not surfacing enough candidates. Consider expanding token extraction from issue bodies and lowering MIN_CANDIDATES_FOR_STAGE1 threshold.",
            impactedMetric: "recall",
            estimatedImpact: "high",
            evidenceSummary: `Average recall=${overall.avgRecall.toFixed(2)} across ${results.length} issues`,
        });
    }

    // High miss rate for schema/model files
    const schemaMiss = missPatterns.find(m => m.category === "schema_model");
    if (schemaMiss && schemaMiss.percentage > 20) {
        recs.push({
            rank: recs.length + 1,
            title: "Schema and model files are systematically missed",
            description: `${schemaMiss.percentage}% of all missed files are schema/model files (.graphql, .prisma, *.entity.ts, *.model.ts). The retrieval index needs to better surface schema files when issues mention data fields or model names.`,
            impactedMetric: "recall",
            estimatedImpact: "high",
            evidenceSummary: `${schemaMiss.count} schema/model files missed (${schemaMiss.percentage}%)`,
        });
    }

    // High miss rate for config files
    const configMiss = missPatterns.find(m => m.category === "config");
    if (configMiss && configMiss.percentage > 15) {
        recs.push({
            rank: recs.length + 1,
            title: "Config files are systematically missed",
            description: "Configuration files are rarely surfaced by token matching. Adding explicit config-file patterns to Stage 1 traversal would help.",
            impactedMetric: "recall",
            estimatedImpact: "medium",
            evidenceSummary: `${configMiss.count} config files missed (${configMiss.percentage}%)`,
        });
    }

    // High miss rate for test files
    const testMiss = missPatterns.find(m => m.category === "test");
    if (testMiss && testMiss.percentage > 15) {
        recs.push({
            rank: recs.length + 1,
            title: "Test files are not surfaced alongside implementation",
            description: "When a bug fix changes an implementation file, the corresponding test file is often missed. Consider adding neighbouring test-file expansion to Stage 1 graph traversal.",
            impactedMetric: "recall",
            estimatedImpact: "medium",
            evidenceSummary: `${testMiss.count} test files missed (${testMiss.percentage}%)`,
        });
    }

    // Low Recall@5 — top predictions are wrong
    if (overall.avgRecallAt5 < 0.2) {
        recs.push({
            rank: recs.length + 1,
            title: "Top-5 predictions are poorly ranked",
            description: "Recall@5 is below 20%, meaning the highest-confidence predictions rarely contain the real files. Improving confidence scoring in Stage 3 (e.g. considering architectural importance) would help.",
            impactedMetric: "recall@k",
            estimatedImpact: "high",
            evidenceSummary: `Average Recall@5=${overall.avgRecallAt5.toFixed(2)}`,
        });
    }

    // Low precision — too many extra files
    if (overall.avgPrecision < 0.2) {
        recs.push({
            rank: recs.length + 1,
            title: "Precision is too low — too many false positives",
            description: "Many predicted files are not in the actual PR. Consider tightening Stage 1 token matching and implementing a post-processing re-ranking step that filters low-confidence results.",
            impactedMetric: "precision",
            estimatedImpact: "medium",
            evidenceSummary: `Average precision=${overall.avgPrecision.toFixed(2)}`,
        });
    }

    // Legacy pipeline used
    const legacyCount = results.filter(r => !r.usedNewPipeline).length;
    if (legacyCount > 0) {
        recs.push({
            rank: recs.length + 1,
            title: `${legacyCount} issues fell through to legacy pipeline`,
            description: "These repos had no RetrievalIndex in Redis, so the new pipeline with graph traversal + snippets was not used. Re-analyzing these repos will unlock the full pipeline quality.",
            impactedMetric: "recall",
            estimatedImpact: "high",
            evidenceSummary: `${legacyCount}/${results.length} issues used the legacy pipeline (no retrieval index)`,
        });
    }

    return recs.sort((a, b) => a.rank - b.rank);
}

// ── Report builder ────────────────────────────────────────────────────────────

export function buildReport(
    results: IssueEvalResult[],
    validations: PRValidationResult[],
    failedEntries: Array<{ entry: DatasetEntry; errorMessage: string }>
): EvaluationReport {
    const allMetrics = results.map(r => ({
        precision: r.precision,
        recall: r.recall,
        f1: r.f1,
        recallAt5: r.recallAt5,
        recallAt10: r.recallAt10,
        recallAt20: r.recallAt20,
        matchedFiles: r.matchedFiles,
        missedFiles: r.missedFiles,
        extraFiles: r.extraFiles,
    }));

    const overall = {
        issueCount: results.length,
        ...aggregateMetrics(allMetrics),
    };

    // Per-size breakdown
    const sizes: RepoSize[] = ["small", "medium", "large", "very_large"];
    const bySize = {} as EvaluationReport["bySize"];
    for (const size of sizes) {
        const sizeResults = results.filter(r => r.entry.size === size);
        const sizeMetrics = sizeResults.map(r => ({
            precision: r.precision, recall: r.recall, f1: r.f1,
            recallAt5: r.recallAt5, recallAt10: r.recallAt10, recallAt20: r.recallAt20,
            matchedFiles: r.matchedFiles, missedFiles: r.missedFiles, extraFiles: r.extraFiles,
        }));
        bySize[size] = { issueCount: sizeResults.length, ...aggregateMetrics(sizeMetrics) };
    }

    // Per-repo breakdown
    const byRepo: EvaluationReport["byRepo"] = {};
    const repoKeys = [...new Set(results.map(r => `${r.entry.owner}/${r.entry.repo}`))];
    for (const key of repoKeys) {
        const repoResults = results.filter(r => `${r.entry.owner}/${r.entry.repo}` === key);
        const repoMetrics = repoResults.map(r => ({
            precision: r.precision, recall: r.recall, f1: r.f1,
            recallAt5: r.recallAt5, recallAt10: r.recallAt10, recallAt20: r.recallAt20,
            matchedFiles: r.matchedFiles, missedFiles: r.missedFiles, extraFiles: r.extraFiles,
        }));
        byRepo[key] = { issueCount: repoResults.length, ...aggregateMetrics(repoMetrics) };
    }

    // Miss patterns
    const allMisses = results.flatMap(r => r.classifiedMisses);
    const missPatterns = aggregateMissPatterns(allMisses);

    // Recommendations
    const recommendations = generateRecommendations(missPatterns, overall, results);

    const validCount = validations.filter(v => v.valid).length;
    const skippedCount = validations.length - validCount;

    return {
        generatedAt: new Date().toISOString(),
        totalIssuesEvaluated: results.length,
        totalIssuesInDataset: validations.length,
        validDatasetEntries: validCount,
        skippedEntries: skippedCount,
        overall,
        bySize,
        byRepo,
        missPatterns,
        recommendations,
        perIssue: results,
        failedIssues: failedEntries,
    };
}

// ── Markdown renderer ─────────────────────────────────────────────────────────

export function renderMarkdown(report: EvaluationReport): string {
    const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
    const fmt = (v: number) => v.toFixed(3);
    const bar = (v: number, width = 20) => {
        const filled = Math.round(v * width);
        return "█".repeat(filled) + "░".repeat(width - filled);
    };

    const lines: string[] = [];

    lines.push(`# CodeMap AI — Issue Mapping Evaluation Report`);
    lines.push(`\n> Generated: ${report.generatedAt}`);
    lines.push(`> Issues evaluated: **${report.totalIssuesEvaluated}** / ${report.validDatasetEntries} valid / ${report.totalIssuesInDataset} total in dataset`);
    if (report.skippedEntries > 0) {
        lines.push(`> ⚠ Skipped entries (failed validation): **${report.skippedEntries}**`);
    }

    // ── Overall Metrics ──
    lines.push(`\n---\n\n## Overall Metrics\n`);
    lines.push(`| Metric | Score | Bar |`);
    lines.push(`|--------|-------|-----|`);
    lines.push(`| Avg Precision | **${fmt(report.overall.avgPrecision)}** (${pct(report.overall.avgPrecision)}) | \`${bar(report.overall.avgPrecision)}\` |`);
    lines.push(`| Avg Recall | **${fmt(report.overall.avgRecall)}** (${pct(report.overall.avgRecall)}) | \`${bar(report.overall.avgRecall)}\` |`);
    lines.push(`| Avg F1 | **${fmt(report.overall.avgF1)}** (${pct(report.overall.avgF1)}) | \`${bar(report.overall.avgF1)}\` |`);
    lines.push(`| Recall@5 | **${fmt(report.overall.avgRecallAt5)}** | \`${bar(report.overall.avgRecallAt5)}\` |`);
    lines.push(`| Recall@10 | **${fmt(report.overall.avgRecallAt10)}** | \`${bar(report.overall.avgRecallAt10)}\` |`);
    lines.push(`| Recall@20 | **${fmt(report.overall.avgRecallAt20)}** | \`${bar(report.overall.avgRecallAt20)}\` |`);
    lines.push(`| Non-zero F1 Rate | **${pct(report.overall.nonZeroF1Rate)}** | \`${bar(report.overall.nonZeroF1Rate)}\` |`);
    lines.push(`| High Recall Rate (≥50%) | **${pct(report.overall.highRecallRate)}** | \`${bar(report.overall.highRecallRate)}\` |`);

    // ── Per-Size ──
    lines.push(`\n---\n\n## Performance by Repository Size\n`);
    lines.push(`| Size | Issues | Precision | Recall | F1 | Recall@5 | Recall@10 |`);
    lines.push(`|------|--------|-----------|--------|----|----------|-----------|`);
    for (const [size, m] of Object.entries(report.bySize)) {
        if (m.issueCount === 0) continue;
        lines.push(`| ${size} | ${m.issueCount} | ${fmt(m.avgPrecision)} | ${fmt(m.avgRecall)} | ${fmt(m.avgF1)} | ${fmt(m.avgRecallAt5)} | ${fmt(m.avgRecallAt10)} |`);
    }

    // ── Per-Repo ──
    lines.push(`\n---\n\n## Performance by Repository\n`);
    lines.push(`| Repository | Issues | Precision | Recall | F1 | Recall@10 |`);
    lines.push(`|------------|--------|-----------|--------|----|-----------|`);
    for (const [repo, m] of Object.entries(report.byRepo)) {
        if (m.issueCount === 0) continue;
        lines.push(`| \`${repo}\` | ${m.issueCount} | ${fmt(m.avgPrecision)} | ${fmt(m.avgRecall)} | ${fmt(m.avgF1)} | ${fmt(m.avgRecallAt10)} |`);
    }

    // ── Miss Patterns ──
    lines.push(`\n---\n\n## Miss Pattern Analysis\n`);
    lines.push(`| Category | Count | % of Misses | Example Files |`);
    lines.push(`|----------|-------|-------------|---------------|`);
    for (const m of report.missPatterns) {
        const examples = m.exampleFiles.slice(0, 2).map(f => `\`${f.split("/").pop()}\``).join(", ");
        lines.push(`| ${m.category} | ${m.count} | ${m.percentage}% | ${examples} |`);
    }

    // ── Recommendations ──
    lines.push(`\n---\n\n## Recommendations (Ranked by Impact)\n`);
    for (const rec of report.recommendations) {
        const impact = rec.estimatedImpact === "high" ? "🔴 HIGH" :
            rec.estimatedImpact === "medium" ? "🟡 MEDIUM" : "🟢 LOW";
        lines.push(`### ${rec.rank}. ${rec.title}`);
        lines.push(`\n**Impact:** ${impact} | **Metric:** ${rec.impactedMetric}\n`);
        lines.push(rec.description);
        lines.push(`\n> Evidence: *${rec.evidenceSummary}*\n`);
    }

    // ── Per-Issue Results ──
    lines.push(`\n---\n\n## Per-Issue Results\n`);
    for (const r of report.perIssue) {
        const emoji = r.f1 >= 0.5 ? "✅" : r.f1 > 0 ? "⚠️" : "❌";
        lines.push(`### ${emoji} ${r.entry.id} — [${r.issueTitle || `Issue #${r.entry.issueNumber}`}](${r.issueUrl})`);
        lines.push(`\n**Repo:** \`${r.entry.owner}/${r.entry.repo}\` | **Size:** ${r.entry.size} | **Source:** ${r.pipelineSource}`);
        lines.push(`\n| Metric | Value |`);
        lines.push(`|--------|-------|`);
        lines.push(`| Precision | ${fmt(r.precision)} |`);
        lines.push(`| Recall | ${fmt(r.recall)} |`);
        lines.push(`| F1 | ${fmt(r.f1)} |`);
        lines.push(`| Recall@5 | ${fmt(r.recallAt5)} |`);
        lines.push(`| Recall@10 | ${fmt(r.recallAt10)} |`);
        lines.push(`| Predicted files | ${r.predictedFiles.length} |`);
        lines.push(`| Actual PR files | ${r.actualFiles.length} |`);
        lines.push(`| Matched | ${r.matchedFiles.length} |`);
        lines.push(`| Missed | ${r.missedFiles.length} |`);
        lines.push(`| Extra | ${r.extraFiles.length} |`);
        lines.push(`| Snippets fetched | ${r.snippetCount} |`);
        lines.push(`| Duration | ${r.durationMs}ms |`);

        if (r.matchedFiles.length > 0) {
            lines.push(`\n**✓ Matched files:**\n${r.matchedFiles.map(f => `- \`${f}\``).join("\n")}`);
        }
        if (r.missedFiles.length > 0) {
            lines.push(`\n**✗ Missed files:**\n${r.missedFiles.map(f => `- \`${f}\``).join("\n")}`);
        }
        if (r.extraFiles.length > 0) {
            lines.push(`\n**+ Extra files (predicted but not in PR):**\n${r.extraFiles.slice(0, 5).map(f => `- \`${f}\``).join("\n")}`);
        }
        if (r.errorMessage) {
            lines.push(`\n> ⛔ Error: ${r.errorMessage}`);
        }
        lines.push("\n");
    }

    // ── Validation rejections ──
    if (report.skippedEntries > 0) {
        lines.push(`\n---\n\n## Dataset Validation — Skipped Entries\n`);
        lines.push(`These entries were rejected by the PR validator before evaluation.\n`);
        lines.push(`| Entry | Reason |`);
        lines.push(`|-------|--------|`);
    }

    return lines.join("\n");
}

// ── File writer ───────────────────────────────────────────────────────────────

export function writeReports(
    report: EvaluationReport,
    outputDir: string = process.cwd()
): { jsonPath: string; mdPath: string } {
    const jsonPath = path.join(outputDir, "evaluation-report.json");
    const mdPath   = path.join(outputDir, "evaluation-report.md");

    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf-8");
    fs.writeFileSync(mdPath, renderMarkdown(report), "utf-8");

    console.log(`[reportGenerator] JSON report written to ${jsonPath}`);
    console.log(`[reportGenerator] Markdown report written to ${mdPath}`);

    return { jsonPath, mdPath };
}
