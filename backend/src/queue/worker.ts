// backend/src/queue/worker.ts
// ─────────────────────────────────────────────────────────────────────────────
// Worker setup. The actual job logic lives in processor.ts.
//
// PRODUCTION (compiled JS): the processor runs SANDBOXED in a child process.
//   → CPU-heavy ts-morph parsing can never block lock renewal again, which is
//     what caused "job stalled more than allowable limit".
//   → If the child OOMs, only that job fails; the API server stays alive and
//     the retry resumes from parse checkpoints.
//
// DEV (ts-node): sandboxing a .ts file requires a ts runtime in the child, so
// locally we run the processor inline. Your laptop has the RAM/CPU for it and
// the generous lock settings below prevent dev stalls too.
// ─────────────────────────────────────────────────────────────────────────────

import path from "path";
import fs from "fs";
import { Worker } from "bullmq";
import { redisConnection } from "./redis";
import { config } from "../config/config";
import type { AnalyzeJobData } from "./processor";

// Compiled? → __filename ends with .js and a sibling processor.js exists.
const compiledProcessorPath = path.join(__dirname, "processor.js");
const isCompiled = __filename.endsWith(".js") && fs.existsSync(compiledProcessorPath);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const processor = isCompiled
    ? compiledProcessorPath                       // sandboxed child process
    : require("./processor").default;             // inline (dev / ts-node)

export const analysisWorker = new Worker<AnalyzeJobData>(
    "repo-analysis",
    processor,
    {
        connection: redisConnection,
        concurrency: config.queue.maxConcurrentJobs,
        // ── Stall protection ──────────────────────────────────────────────
        // Generous lock + tolerant stall counting. With the sandboxed
        // processor these should never trigger, but they are the safety net
        // for slow disks / GC pauses on tiny containers.
        lockDuration: config.queue.lockDurationMs,        // default 120s (was 30s)
        stalledInterval: config.queue.stalledIntervalMs,  // default 60s
        maxStalledCount: config.queue.maxStalledCount,    // default 2 (was 1)
        // Child processes (not worker threads): full memory isolation
        useWorkerThreads: false,
    }
);

console.log(
    `[worker] Started — mode: ${isCompiled ? "sandboxed (child process)" : "inline (dev)"}, ` +
    `concurrency: ${config.queue.maxConcurrentJobs}, ` +
    `lockDuration: ${config.queue.lockDurationMs}ms`
);

analysisWorker.on("active", (job) => {
    console.log(`[worker] Job active: ${job.id} — ${job.data.owner}/${job.data.repo}`);
});

analysisWorker.on("completed", (job, result) => {
    console.log(`[worker] Job completed: ${job.id}`);
    const stats = (result as any)?.stats;
    if (stats) console.log(`[worker] Stats:`, JSON.stringify(stats));
});

analysisWorker.on("failed", (job, err) => {
    console.error(`[worker] Job failed: ${job?.id} — ${err.message}`);
});

analysisWorker.on("stalled", (jobId) => {
    console.warn(`[worker] Job stalled (will retry): ${jobId}`);
});

analysisWorker.on("error", (err) => {
    console.error(`[worker] Worker error: ${err.message}`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// Render sends SIGTERM before killing the container. close() waits for the
// active job's current lock to be released cleanly so the retry can resume
// from checkpoints instead of double-processing.

async function shutdown(): Promise<void> {
    console.log("[worker] Shutting down gracefully...");
    await analysisWorker.close();
    await redisConnection.quit();
    process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
