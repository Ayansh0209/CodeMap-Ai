// src/parser/aiTelemetry.ts
// ─────────────────────────────────────────────────────────────────────────────
// Per-run AI telemetry accumulator.
//
// PURPOSE:
//   A tiny, dependency-free in-memory counter so the issue-mapping pipeline
//   (and the eval harness) can measure how many Gemini calls were made and how
//   many tokens/$ were spent for a single issue map — without threading a meter
//   object through every function.
//
//   issueAnalyzer.logUsage() records into the active run after every Gemini
//   call. The eval harness (or the route) wraps a single map in
//   beginAiRun()/endAiRun() to get an isolated tally.
//
//   This is intentionally simple: a single module-level "current run". It is
//   NOT concurrency-safe across overlapping maps in the same process. The eval
//   harness runs cases sequentially, and the production route can opt in per
//   request when it wants a meter. For concurrent production metering, prefer
//   the existing Redis counters in routes/issueMap.ts.
// ─────────────────────────────────────────────────────────────────────────────

export interface AiCallRecord {
    /** Operation label, e.g. "mapping-round1", "mapping-final", "graph-navigation" */
    operation: string;
    promptTokens: number;
    candidateTokens: number;
    costUsd: number;
}

export interface AiRunTotals {
    calls: number;
    promptTokens: number;
    candidateTokens: number;
    totalTokens: number;
    costUsd: number;
    /** Per-operation call counts, e.g. { "mapping-round1": 1, "mapping-final": 1 } */
    byOperation: Record<string, number>;
    records: AiCallRecord[];
}

let currentRun: AiRunTotals | null = null;

function emptyTotals(): AiRunTotals {
    return {
        calls: 0,
        promptTokens: 0,
        candidateTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        byOperation: {},
        records: [],
    };
}

/** Start a fresh telemetry run. Any previous run is discarded. */
export function beginAiRun(): void {
    currentRun = emptyTotals();
}

/**
 * Record one Gemini call into the active run.
 * No-op when no run is active (production default — zero overhead).
 */
export function recordAiCall(rec: AiCallRecord): void {
    if (!currentRun) return;
    currentRun.calls += 1;
    currentRun.promptTokens += rec.promptTokens;
    currentRun.candidateTokens += rec.candidateTokens;
    currentRun.totalTokens += rec.promptTokens + rec.candidateTokens;
    currentRun.costUsd += rec.costUsd;
    currentRun.byOperation[rec.operation] =
        (currentRun.byOperation[rec.operation] ?? 0) + 1;
    currentRun.records.push(rec);
}

/** End the active run and return its totals (or zeros if none was active). */
export function endAiRun(): AiRunTotals {
    const totals = currentRun ?? emptyTotals();
    currentRun = null;
    return totals;
}

/** Peek at the active run's totals without ending it (null if none active). */
export function peekAiRun(): AiRunTotals | null {
    return currentRun;
}
