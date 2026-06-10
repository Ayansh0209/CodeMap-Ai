// backend/src/queue/worker.ts

import { Worker, Job } from "bullmq";
import { redisConnection } from "./jobQueue";
import { config } from "../config/config";
import { fetchRepoMetadata } from "../github/client";
import {
    downloadTarball,
    extractTarball,
    walkFileTree,
    cleanup,
} from "../github/downlaod";
import { decideParsing } from "../processing/parseDecider";
import { processAllFiles } from "../parser/chunkProcessor";
import { buildGraph } from "../parser/builder";
import { buildRetrievalIndex } from "../parser/retrievalBuilder";
import path from "path";
import os from "os";
type AnalyzeJobData = {
    repoUrl: string;
    owner: string;
    repo: string;
    jobId: string;
    currentStep?: string;
};

// ── Cache helpers (uses same Railway Redis, no extra file needed yet) ──────────

async function getCachedResult(cacheKey: string): Promise<object | null> {
    try {
        const cached = await redisConnection.get(cacheKey);
        if (cached) return JSON.parse(cached);
        return null;
    } catch {
        return null; // cache miss is never fatal
    }
}

async function setCachedResult(cacheKey: string, result: object): Promise<void> {
    try {
        // No TTL — SHA is immutable, result never changes
        await redisConnection.set(cacheKey, JSON.stringify(result));
    } catch (err) {
        // Cache write failure is never fatal — job still succeeds
        console.warn("[cache] Failed to write cache:", (err as Error).message);
    }
}

// ── Progress helper ────────────────────────────────────────────────────────────

async function updateProgress(
    job: Job<AnalyzeJobData>,
    percent: number,
    step: string
): Promise<void> {
    await job.updateProgress(percent);
    await job.updateData({ ...job.data, currentStep: step });
}

// ── Main processor ─────────────────────────────────────────────────────────────

async function processJob(job: Job<AnalyzeJobData>): Promise<object> {
    const { owner, repo, jobId } = job.data;
    await updateProgress(job, 0, "starting");

    // ── Step 1: Fetch repo metadata ──────────────────────────────────────────
    await updateProgress(job, 5, "fetching repository metadata");

    const metadata = await fetchRepoMetadata(owner, repo);

    // ── Step 2: Size check — abort early before downloading anything ─────────
    if (metadata.sizeMB > 500) {
        throw new Error(
            `Repository too large: ${metadata.sizeMB}MB (limit: 500MB)`
        );
    }
    // ── Step 3: Redis cache check by SHA ─────────────────────────────────────
    // Same SHA always produces same graph — never reprocess
    const cacheKey = `repo:${owner}:${repo}:${metadata.commitSha}`;
    const cached = await getCachedResult(cacheKey);

    if (cached) {
        await updateProgress(job, 100, "done (from cache)");
        return cached;
    }
    // ── Steps 4-8 run inside try/finally so cleanup ALWAYS happens ───────────
    try {
        // ── Step 4: Download tarball (streaming, never loads into RAM) ───────
        await updateProgress(job, 10, "downloading repository");

        await downloadTarball(owner, repo, metadata.defaultBranch, jobId);

        // ── Step 5: Extract tarball ───────────────────────────────────────────
        await updateProgress(job, 25, "extracting files");

        await extractTarball(jobId);

        // ── Step 6: Walk file tree ────────────────────────────────────────────
        await updateProgress(job, 30, "walking file tree");

        const allFiles = walkFileTree(jobId);
        // ── Step 7: Filter + decide parse mode per file ───────────────────────
        await updateProgress(job, 35, "filtering and classifying files");

        const { decisions, stats } = decideParsing(allFiles);
        // Guard: abort if no parseable files found
        if (stats.full === 0 && stats.importsOnly === 0) {
            throw new Error(
                "No parseable files found after filtering. " +
                "Repository may contain no JS/TS source files."
            );
        }

        // Guard: abort if file count is unreasonably large
        const parseableCount = stats.full + stats.importsOnly;
        if (parseableCount > 10000) {
            throw new Error(
                `Too many files to parse: ${parseableCount} (limit: 10,000). ` +
                "Repository may be a monorepo — support coming in Phase 2."
            );
        }

        // ── Steps 8-10 added in Layer 5 (ts-morph) and Layer 6 (graph builder)
        // ── Step 8: Parse all files with ts-morph ────────────────────────────────
        await updateProgress(job, 50, "parsing files");

        // repoRoot is the extracted folder — needed for import resolution
        const repoRoot = path.join(os.tmpdir(), "codemap", jobId);

        const { fileNodes, importEdges, allFunctions, startupSignals, routeHandlers } = await processAllFiles(
            decisions,
            repoRoot,
            (done, total) => {
                // map 50→75% progress across parsing
                const percent = 50 + Math.floor((done / total) * 25);
                job.updateProgress(percent);
            }
        );

        await updateProgress(job, 75, "building graph");

        // ── Step 9: Build graph ─────────────────────────────────────────────
        const { graphData, fileGraph, functionFiles, searchIndex } = buildGraph({
            owner,
            repo,
            commitSha: metadata.commitSha,
            fileNodes,
            importEdges,
            allFunctions,
            repoRoot,
            startupSignals,
            routeHandlers,
        });

        await updateProgress(job, 90, "graph built");

        // ── Build and store retrieval index ───────────────────────────────────────────────
        // Independent of the visualization graph — built from the same data.
        // Failure is non-fatal: warn and continue. The graph is the primary output.
        try {
            const retrievalIndex = buildRetrievalIndex(
                owner,
                repo,
                metadata.commitSha,
                fileNodes,
                importEdges,
                allFunctions,
            );
            const retrievalKey = `retrieval:${owner}:${repo}`;
            await redisConnection.set(retrievalKey, JSON.stringify(retrievalIndex));
        } catch (err) {
            console.warn(
                "[worker] Failed to build or store retrieval index (non-fatal):",
                (err as Error).message
            );
        }

        // ── Persist search index to Redis for instant retrieval ───────────────
        if (searchIndex) {
            try {
                const searchKey = `search:${owner}:${repo}`;
                await redisConnection.set(searchKey, JSON.stringify(searchIndex));
            } catch (err) {
                console.warn("[worker] Failed to persist search index:", (err as Error).message);
            }
        }

        // ── Persist file graph for issue mapping context ──────────────────────
        try {
            const graphKey = `graph:${owner}:${repo}`;
            await redisConnection.set(graphKey, JSON.stringify(fileGraph));
        } catch (err) {
            console.warn("[worker] Failed to persist file graph:", (err as Error).message);
        }

        // ── Persist per-file functions to Redis ──────────────────────────────
        try {
            let funcCount = 0;
            for (const [fileId, payload] of functionFiles.entries()) {
                const funcKey = `functions:${owner}:${repo}:${metadata.commitSha}:${fileId}`;
                await redisConnection.set(funcKey, JSON.stringify(payload));
                funcCount++;
            }
        } catch (err) {
            console.warn("[worker] Failed to persist per-file functions:", (err as Error).message);
        }

        let functionFilesObj = Object.fromEntries(functionFiles);
        const functionsJsonStr = JSON.stringify(functionFilesObj);
        const functionsSizeMB = Buffer.byteLength(functionsJsonStr, 'utf8') / 1024 / 1024;

        if (functionsSizeMB > 4) {
            functionFilesObj = {};
        }

        const result = {
            success: true,
            owner,
            repo,
            commitSha: metadata.commitSha,
            defaultBranch: metadata.defaultBranch,
            sizeMb: metadata.sizeMB,
            stats: graphData.stats,
            // These will be real R2 URLs once Layer 7 (storage) is built
            fileGraphUrl: null,
            functionsBaseUrl: null,
            // Inline for now so the completed handler + status route can inspect it
            _inlineFileGraph: fileGraph,
            // Per-file function data — Map converted to plain object for JSON serialization
            _functionFiles: functionFilesObj,
        };

        const resultJson = JSON.stringify(result)
        const resultSizeMB = (Buffer.byteLength(resultJson, 'utf8') / 1024 / 1024).toFixed(2)
        if (parseFloat(resultSizeMB) > 10) {
            console.warn(`[worker] WARNING: result is ${resultSizeMB}MB — may exceed limits`)
            console.warn(`[worker] _inlineFileGraph files: ${result._inlineFileGraph?.files?.length}`)
        }

        // ── Cache the result so same SHA is never reprocessed ─────────────────
        await setCachedResult(cacheKey, result);

        await updateProgress(job, 100, "done");

        return result;

    } finally {
        // ── Cleanup ALWAYS runs — even if job throws halfway through ──────────
        // Disk never fills up regardless of what goes wrong
        cleanup(jobId);
    }
}

// ── Worker setup ──────────────────────────────────────────────────────────────

export const analysisWorker = new Worker<AnalyzeJobData>(
    "repo-analysis",
    processJob,
    {
        connection: redisConnection,
        concurrency: config.queue.maxConcurrentJobs,
    }
);

analysisWorker.on("active", (job) => {
});

analysisWorker.on("completed", (job, result) => {
    // ── TEMP DEBUG — remove after verifying graph data ──────────────────────
    const graph = (result as any)._inlineFileGraph;
    if (graph) {
        graph.importEdges?.slice(0, 3).forEach((e: any) => {
        });
        graph.files?.slice(0, 3).forEach((f: any) => {
        });
    } else {
    }
    // ── END TEMP DEBUG ───────────────────────────────────────────────────────
});

analysisWorker.on("failed", (job, err) => {
    console.error(`[worker] Job failed: ${job?.id} — ${err.message}`);
});

analysisWorker.on("error", (err) => {
    console.error(`[worker] Worker error: ${err.message}`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// Waits for active jobs to finish before process exits
// Railway sends SIGTERM before killing the container

async function shutdown(): Promise<void> {
    await analysisWorker.close();
    await redisConnection.quit();
    process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);