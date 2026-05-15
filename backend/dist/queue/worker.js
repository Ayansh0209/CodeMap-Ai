"use strict";
// backend/src/queue/worker.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.analysisWorker = void 0;
const bullmq_1 = require("bullmq");
const jobQueue_1 = require("./jobQueue");
const config_1 = require("../config/config");
const client_1 = require("../github/client");
const downlaod_1 = require("../github/downlaod");
const parseDecider_1 = require("../processing/parseDecider");
const chunkProcessor_1 = require("../parser/chunkProcessor");
const builder_1 = require("../parser/builder");
const retrievalBuilder_1 = require("../parser/retrievalBuilder");
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
// ── Cache helpers (uses same Railway Redis, no extra file needed yet) ──────────
async function getCachedResult(cacheKey) {
    try {
        const cached = await jobQueue_1.redisConnection.get(cacheKey);
        if (cached)
            return JSON.parse(cached);
        return null;
    }
    catch {
        return null; // cache miss is never fatal
    }
}
async function setCachedResult(cacheKey, result) {
    try {
        // No TTL — SHA is immutable, result never changes
        await jobQueue_1.redisConnection.set(cacheKey, JSON.stringify(result));
    }
    catch (err) {
        // Cache write failure is never fatal — job still succeeds
        console.warn("[cache] Failed to write cache:", err.message);
    }
}
// ── Progress helper ────────────────────────────────────────────────────────────
async function updateProgress(job, percent, step) {
    await job.updateProgress(percent);
    await job.updateData({ ...job.data, currentStep: step });
    console.log(`[worker] ${job.data.owner}/${job.data.repo} — ${percent}% — ${step}`);
}
// ── Main processor ─────────────────────────────────────────────────────────────
async function processJob(job) {
    const { owner, repo, jobId } = job.data;
    console.log(`[worker] Job received: ${owner}/${repo} (jobId: ${jobId})`);
    await updateProgress(job, 0, "starting");
    // ── Step 1: Fetch repo metadata ──────────────────────────────────────────
    await updateProgress(job, 5, "fetching repository metadata");
    const metadata = await (0, client_1.fetchRepoMetadata)(owner, repo);
    // ── Step 2: Size check — abort early before downloading anything ─────────
    if (metadata.sizeMB > 500) {
        throw new Error(`Repository too large: ${metadata.sizeMB}MB (limit: 500MB)`);
    }
    console.log(`[worker] Metadata OK → branch=${metadata.defaultBranch}, ` +
        `sha=${metadata.commitSha.slice(0, 7)}, size=${metadata.sizeMB}MB`);
    // ── Step 3: Redis cache check by SHA ─────────────────────────────────────
    // Same SHA always produces same graph — never reprocess
    const cacheKey = `repo:${owner}:${repo}:${metadata.commitSha}`;
    const cached = await getCachedResult(cacheKey);
    if (cached) {
        console.log(`[worker] Cache hit for ${owner}/${repo}@${metadata.commitSha.slice(0, 7)}`);
        await updateProgress(job, 100, "done (from cache)");
        return cached;
    }
    console.log(`[worker] Cache miss — starting full analysis`);
    // ── Steps 4-8 run inside try/finally so cleanup ALWAYS happens ───────────
    try {
        // ── Step 4: Download tarball (streaming, never loads into RAM) ───────
        await updateProgress(job, 10, "downloading repository");
        await (0, downlaod_1.downloadTarball)(owner, repo, metadata.defaultBranch, jobId);
        // ── Step 5: Extract tarball ───────────────────────────────────────────
        await updateProgress(job, 25, "extracting files");
        await (0, downlaod_1.extractTarball)(jobId);
        // ── Step 6: Walk file tree ────────────────────────────────────────────
        await updateProgress(job, 30, "walking file tree");
        const allFiles = (0, downlaod_1.walkFileTree)(jobId);
        console.log(`[worker] Found ${allFiles.length} total files`);
        // ── Step 7: Filter + decide parse mode per file ───────────────────────
        await updateProgress(job, 35, "filtering and classifying files");
        const { decisions, stats } = (0, parseDecider_1.decideParsing)(allFiles);
        console.log(`[worker] Parse decisions → ` +
            `full: ${stats.full}, ` +
            `imports-only: ${stats.importsOnly}, ` +
            `skipped: ${stats.skipped}, ` +
            `filtered: ${stats.filtered}`);
        // Guard: abort if no parseable files found
        if (stats.full === 0 && stats.importsOnly === 0) {
            throw new Error("No parseable files found after filtering. " +
                "Repository may contain no JS/TS source files.");
        }
        // Guard: abort if file count is unreasonably large
        const parseableCount = stats.full + stats.importsOnly;
        if (parseableCount > 10000) {
            throw new Error(`Too many files to parse: ${parseableCount} (limit: 10,000). ` +
                "Repository may be a monorepo — support coming in Phase 2.");
        }
        // ── Steps 8-10 added in Layer 5 (ts-morph) and Layer 6 (graph builder)
        // ── Step 8: Parse all files with ts-morph ────────────────────────────────
        await updateProgress(job, 50, "parsing files");
        // repoRoot is the extracted folder — needed for import resolution
        const repoRoot = path_1.default.join(os_1.default.tmpdir(), "codemap", jobId);
        const { fileNodes, importEdges, allFunctions, startupSignals, routeHandlers } = await (0, chunkProcessor_1.processAllFiles)(decisions, repoRoot, (done, total) => {
            // map 50→75% progress across parsing
            const percent = 50 + Math.floor((done / total) * 25);
            job.updateProgress(percent);
        });
        await updateProgress(job, 75, "building graph");
        // ── Step 9: Build graph ─────────────────────────────────────────────
        const { graphData, fileGraph, functionFiles, searchIndex } = (0, builder_1.buildGraph)({
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
            const retrievalIndex = (0, retrievalBuilder_1.buildRetrievalIndex)(owner, repo, metadata.commitSha, fileNodes, importEdges, allFunctions);
            const retrievalKey = `retrieval:${owner}:${repo}`;
            await jobQueue_1.redisConnection.set(retrievalKey, JSON.stringify(retrievalIndex));
            console.log(`[worker] retrieval index stored in Redis ` +
                `(${retrievalIndex.files.length} files, key: ${retrievalKey})`);
        }
        catch (err) {
            console.warn("[worker] Failed to build or store retrieval index (non-fatal):", err.message);
        }
        // ── Persist search index to Redis for instant retrieval ───────────────
        if (searchIndex) {
            try {
                const searchKey = `search:${owner}:${repo}`;
                await jobQueue_1.redisConnection.set(searchKey, JSON.stringify(searchIndex));
                console.log(`[worker] search index persisted to Redis (${searchIndex.entries.length} entries)`);
            }
            catch (err) {
                console.warn("[worker] Failed to persist search index:", err.message);
            }
        }
        // ── Persist file graph for issue mapping context ──────────────────────
        try {
            const graphKey = `graph:${owner}:${repo}`;
            await jobQueue_1.redisConnection.set(graphKey, JSON.stringify(fileGraph));
            console.log(`[worker] file graph persisted to Redis for issue mapper`);
        }
        catch (err) {
            console.warn("[worker] Failed to persist file graph:", err.message);
        }
        // ── Persist per-file functions to Redis ──────────────────────────────
        try {
            let funcCount = 0;
            for (const [fileId, payload] of functionFiles.entries()) {
                const funcKey = `functions:${owner}:${repo}:${metadata.commitSha}:${fileId}`;
                await jobQueue_1.redisConnection.set(funcKey, JSON.stringify(payload));
                funcCount++;
            }
            console.log(`[worker] persisted ${funcCount} per-file functions to Redis`);
        }
        catch (err) {
            console.warn("[worker] Failed to persist per-file functions:", err.message);
        }
        let functionFilesObj = Object.fromEntries(functionFiles);
        const functionsJsonStr = JSON.stringify(functionFilesObj);
        const functionsSizeMB = Buffer.byteLength(functionsJsonStr, 'utf8') / 1024 / 1024;
        if (functionsSizeMB > 4) {
            console.log(`[worker] _functionFiles is ${functionsSizeMB.toFixed(2)}MB (>4MB), omitting from inline result to save memory and avoid OOM. Frontend will lazy load.`);
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
        const resultJson = JSON.stringify(result);
        const resultSizeMB = (Buffer.byteLength(resultJson, 'utf8') / 1024 / 1024).toFixed(2);
        console.log(`[worker] result size: ${resultSizeMB}MB`);
        if (parseFloat(resultSizeMB) > 10) {
            console.warn(`[worker] WARNING: result is ${resultSizeMB}MB — may exceed limits`);
            console.warn(`[worker] _inlineFileGraph files: ${result._inlineFileGraph?.files?.length}`);
        }
        // ── Cache the result so same SHA is never reprocessed ─────────────────
        await setCachedResult(cacheKey, result);
        await updateProgress(job, 100, "done");
        return result;
    }
    finally {
        // ── Cleanup ALWAYS runs — even if job throws halfway through ──────────
        // Disk never fills up regardless of what goes wrong
        (0, downlaod_1.cleanup)(jobId);
    }
}
// ── Worker setup ──────────────────────────────────────────────────────────────
exports.analysisWorker = new bullmq_1.Worker("repo-analysis", processJob, {
    connection: jobQueue_1.redisConnection,
    concurrency: config_1.config.queue.maxConcurrentJobs,
});
exports.analysisWorker.on("active", (job) => {
    console.log(`[worker] Job active: ${job.id} — ${job.data.owner}/${job.data.repo}`);
});
exports.analysisWorker.on("completed", (job, result) => {
    console.log(`[worker] Job completed: ${job.id}`);
    console.log(`[worker] Stats:`, JSON.stringify(result.stats, null, 2));
    // ── TEMP DEBUG — remove after verifying graph data ──────────────────────
    const graph = result._inlineFileGraph;
    if (graph) {
        console.log(`[worker] Sample import edges (first 3):`);
        graph.importEdges?.slice(0, 3).forEach((e) => {
            console.log(`  ${e.source} → ${e.target} [${e.kind}] isTypeOnly=${e.isTypeOnly}`);
        });
        console.log(`[worker] Sample files (first 3):`);
        graph.files?.slice(0, 3).forEach((f) => {
            console.log(`  ${f.id} | kind=${f.kind} | entry=${f.isEntryPoint} | lines=${f.lineCount}`);
        });
    }
    else {
        console.log(`[worker] No _inlineFileGraph in result — graph may not be wired yet`);
    }
    // ── END TEMP DEBUG ───────────────────────────────────────────────────────
});
exports.analysisWorker.on("failed", (job, err) => {
    console.error(`[worker] Job failed: ${job?.id} — ${err.message}`);
});
exports.analysisWorker.on("error", (err) => {
    console.error(`[worker] Worker error: ${err.message}`);
});
// ── Graceful shutdown ─────────────────────────────────────────────────────────
// Waits for active jobs to finish before process exits
// Railway sends SIGTERM before killing the container
async function shutdown() {
    console.log("[worker] Shutting down gracefully...");
    await exports.analysisWorker.close();
    await jobQueue_1.redisConnection.quit();
    process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
console.log(`[worker] Started — concurrency: ${config_1.config.queue.maxConcurrentJobs}`);
