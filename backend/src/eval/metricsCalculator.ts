// src/eval/metricsCalculator.ts
// ─────────────────────────────────────────────────────────────────────────────
// Computes Precision, Recall, F1, and Recall@K for a single issue prediction.
//
// Path normalization rules (critical for fair comparison):
//   - Strip leading slash
//   - Normalize backslashes to forward slashes
//   - Case-insensitive on Windows-style paths
//   - Strip trailing slashes
// ─────────────────────────────────────────────────────────────────────────────

// ── Path normalization ────────────────────────────────────────────────────────

function normalizePath(p: string): string {
    return p
        .replace(/\\/g, "/")
        .replace(/^\/+/, "")
        .replace(/\/+$/, "")
        .toLowerCase()
        .trim();
}

// ── Core metrics ──────────────────────────────────────────────────────────────

export interface MetricsResult {
    precision: number;
    recall: number;
    f1: number;
    recallAt5: number;
    recallAt10: number;
    recallAt20: number;
    matchedFiles: string[];
    missedFiles: string[];
    extraFiles: string[];
}

/**
 * Compute all metrics for one issue.
 *
 * @param predictedFiles - Array of { fileId, confidence } sorted by confidence descending
 * @param actualFiles    - Ground truth file paths from the merged PR
 */
export function computeMetrics(
    predictedFiles: Array<{ fileId: string; confidence: number }>,
    actualFiles: string[]
): MetricsResult {
    const actualSet = new Set(actualFiles.map(normalizePath));
    const predictedNorm = predictedFiles.map(f => ({
        fileId: f.fileId,
        normalizedId: normalizePath(f.fileId),
        confidence: f.confidence,
    }));

    // Sort by confidence descending (highest confidence first) for Recall@K
    const sortedPredicted = [...predictedNorm].sort((a, b) => b.confidence - a.confidence);

    // Matched files (predicted ∩ actual)
    const matchedNorm = new Set<string>();
    for (const p of predictedNorm) {
        if (actualSet.has(p.normalizedId)) {
            matchedNorm.add(p.normalizedId);
        }
    }

    const matchedFiles = predictedFiles
        .filter(f => actualSet.has(normalizePath(f.fileId)))
        .map(f => f.fileId);

    const missedFiles = actualFiles.filter(
        f => !predictedNorm.some(p => p.normalizedId === normalizePath(f))
    );

    const extraFiles = predictedFiles
        .filter(f => !actualSet.has(normalizePath(f.fileId)))
        .map(f => f.fileId);

    const predictedCount = predictedFiles.length;
    const actualCount = actualFiles.length;
    const matchedCount = matchedNorm.size;

    const precision = predictedCount === 0 ? 0 : matchedCount / predictedCount;
    const recall = actualCount === 0 ? 1 : matchedCount / actualCount;
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

    // Recall@K: how many actual files are in the top-K predictions?
    function recallAtK(k: number): number {
        if (actualCount === 0) return 1;
        const topK = sortedPredicted.slice(0, k);
        const topKSet = new Set(topK.map(p => p.normalizedId));
        const found = [...actualSet].filter(a => topKSet.has(a)).length;
        return found / actualCount;
    }

    return {
        precision: round(precision),
        recall: round(recall),
        f1: round(f1),
        recallAt5: round(recallAtK(5)),
        recallAt10: round(recallAtK(10)),
        recallAt20: round(recallAtK(20)),
        matchedFiles,
        missedFiles,
        extraFiles,
    };
}

// ── Aggregate metrics ─────────────────────────────────────────────────────────

export function aggregateMetrics(results: MetricsResult[]): {
    avgPrecision: number;
    avgRecall: number;
    avgF1: number;
    avgRecallAt5: number;
    avgRecallAt10: number;
    avgRecallAt20: number;
    nonZeroF1Rate: number;
    highRecallRate: number;
} {
    const n = results.length;
    if (n === 0) {
        return {
            avgPrecision: 0, avgRecall: 0, avgF1: 0,
            avgRecallAt5: 0, avgRecallAt10: 0, avgRecallAt20: 0,
            nonZeroF1Rate: 0, highRecallRate: 0,
        };
    }

    const avg = (arr: number[]) => round(arr.reduce((s, v) => s + v, 0) / arr.length);

    return {
        avgPrecision:    avg(results.map(r => r.precision)),
        avgRecall:       avg(results.map(r => r.recall)),
        avgF1:           avg(results.map(r => r.f1)),
        avgRecallAt5:    avg(results.map(r => r.recallAt5)),
        avgRecallAt10:   avg(results.map(r => r.recallAt10)),
        avgRecallAt20:   avg(results.map(r => r.recallAt20)),
        nonZeroF1Rate:   round(results.filter(r => r.f1 > 0).length / n),
        highRecallRate:  round(results.filter(r => r.recall >= 0.5).length / n),
    };
}

function round(v: number, decimals = 4): number {
    return Math.round(v * 10 ** decimals) / 10 ** decimals;
}
