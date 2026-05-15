"use strict";
// src/routes/issueMap.ts
// ─────────────────────────────────────────────────────────────────────────────
// Issue mapping routes — thin request/response wiring ONLY.
//
// WHAT THIS FILE DOES:
//   - Validate incoming requests (Zod schemas)
//   - Check and write the Redis result cache
//   - Fetch raw GitHub data (issue, comments, linked PRs)
//   - Delegate all business logic to issuePipeline.runIssueMappingPipeline()
//   - Build and return the response in the shape the frontend expects
//
// WHAT THIS FILE INTENTIONALLY DOES NOT DO:
//   - No deterministic keyword matching (lives in issueMapper.ts)
//   - No AI prompt building (lives in issueAnalyzer.ts)
//   - No graph traversal (lives in issueMapper.ts)
//   - No snippet fetching (lives in snippetFetcher.ts)
//   - No merging of results from different sources (lives in issuePipeline.ts)
//   - No inline search index building (lives in issueMapper.ts)
//
// GRACEFUL DEGRADATION (enforced at this layer):
//   - Redis down → skip cache, run pipeline, return result without caching
//   - GitHub issue 404 → return 404 to client (correct behavior, not degradation)
//   - GitHub comments/PRs fail → pass empty arrays to pipeline (pipeline handles)
//   - Pipeline throws → return empty result with source="deterministic", never 500
// ─────────────────────────────────────────────────────────────────────────────
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const jobQueue_1 = require("../queue/jobQueue");
const issueClient_1 = require("../github/issueClient");
const issueAnalyzer_1 = require("../parser/issueAnalyzer");
const issuePipeline_1 = require("../parser/issuePipeline");
const router = (0, express_1.Router)();
// ── Zod schemas ───────────────────────────────────────────────────────────────
// These are kept exactly as-is — the frontend depends on these shapes.
const FetchIssuesRequestSchema = zod_1.z.object({
    owner: zod_1.z.string().min(1).max(100),
    repo: zod_1.z.string().min(1).max(100),
});
const IssueMapRequestSchema = zod_1.z.object({
    owner: zod_1.z.string().min(1).max(100),
    repo: zod_1.z.string().min(1).max(100),
    commitSha: zod_1.z.string().min(1).max(200),
    issueNumber: zod_1.z.number().int().positive(),
    graphData: zod_1.z.object({
        files: zod_1.z.array(zod_1.z.object({
            id: zod_1.z.string(),
            label: zod_1.z.string(),
            architecturalImportance: zod_1.z.number().optional().default(0),
        })).max(3000),
        functions: zod_1.z.array(zod_1.z.object({
            id: zod_1.z.string(),
            name: zod_1.z.string(),
            filePath: zod_1.z.string(),
        })).max(5000).optional().default([]),
    }).optional(),
});
const SuggestFixRequestSchema = zod_1.z.object({
    owner: zod_1.z.string().min(1).max(100),
    repo: zod_1.z.string().min(1).max(100),
    commitSha: zod_1.z.string().min(1).max(200),
    issueNumber: zod_1.z.number().int().positive(),
    fileId: zod_1.z.string().min(1).max(500),
    connectedFileIds: zod_1.z.array(zod_1.z.string()).max(10).optional().default([]),
});
const ChatRequestSchema = zod_1.z.object({
    owner: zod_1.z.string().min(1).max(100),
    repo: zod_1.z.string().min(1).max(100),
    commitSha: zod_1.z.string().min(1).max(200),
    issueNumber: zod_1.z.number().int().positive().optional(),
    fileId: zod_1.z.string().min(1).max(500),
    connectedFileIds: zod_1.z.array(zod_1.z.string()).max(10).optional().default([]),
    messages: zod_1.z.array(zod_1.z.object({
        role: zod_1.z.enum(["user", "model", "assistant"]),
        content: zod_1.z.string().min(1)
    })).min(1).max(20),
});
// ── POST /issue-map/fetch-issues ──────────────────────────────────────────────
// Unchanged from Phase 1 — returns open issues list with 5-minute cache.
router.post("/fetch-issues", async (req, res, next) => {
    try {
        const { owner, repo } = FetchIssuesRequestSchema.parse(req.body);
        const cacheKey = `issues-list:${owner}:${repo}`;
        // Graceful Redis failure: if get() throws, treat as cache miss
        let cached = null;
        try {
            cached = await jobQueue_1.redisConnection.get(cacheKey);
        }
        catch {
            // Redis unavailable — skip cache, fetch fresh
        }
        if (cached) {
            return res.json({ source: "cache", issues: JSON.parse(cached) });
        }
        const issues = await (0, issueClient_1.fetchOpenIssues)(owner, repo, 100);
        const summaries = issues.map(issue => ({
            number: issue.number,
            title: issue.title,
            htmlUrl: issue.htmlUrl,
            labels: issue.labels,
            state: issue.state,
        }));
        // Cache write failure is never fatal
        try {
            await jobQueue_1.redisConnection.set(cacheKey, JSON.stringify(summaries), "EX", 300);
        }
        catch {
            // Redis down — continue without caching
        }
        return res.json({ source: "fresh", issues: summaries });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            return res.status(400).json({ error: "Invalid request", details: err.issues });
        }
        next(err);
    }
});
// ── POST /issue-map/map ────────────────────────────────────────────────────────
//
// Thin orchestration: validate → cache check → GitHub fetch → pipeline → cache write → respond.
//
// All business logic (deterministic matching, graph traversal, snippet fetching,
// AI reasoning, result merging) lives in runIssueMappingPipeline().
//
// FALLBACK CHAIN (documented for future maintainers):
//   1. Redis cache hit → return immediately, no pipeline run
//   2. Redis down → skip cache check, run pipeline anyway
//   3. RetrievalIndex in Redis → new pipeline (graph traversal + snippets + Gemini)
//   4. RetrievalIndex missing → legacy pipeline (inline index + Gemini with no snippets)
//   5. Gemini fails in pipeline → pipeline returns geminiResult=null
//   6. geminiResult=null → response has empty affectedFiles, source="deterministic"
//   7. Pipeline throws → same as step 6, log error, never 500
router.post("/map", async (req, res, next) => {
    try {
        // ── Step 1: Validate ──────────────────────────────────────────────────
        const { owner, repo, commitSha, issueNumber, graphData } = IssueMapRequestSchema.parse(req.body);
        // ── Step 2: Redis cache check ─────────────────────────────────────────
        // Cache key: (owner, repo, issueNumber, commitSha)
        // No TTL — same SHA means same code means same result, forever.
        // Degradation: Redis down → treat as cache miss, run pipeline.
        const cacheKey = `issue-map:${owner}:${repo}:${issueNumber}:${commitSha}`;
        try {
            const cached = await jobQueue_1.redisConnection.get(cacheKey);
            if (cached) {
                const result = JSON.parse(cached);
                return res.json({ ...result, source: "cache" });
            }
        }
        catch {
            console.warn("[issueMap] Redis unavailable for cache check — running pipeline");
        }
        // ── Step 3: Fetch issue from GitHub ───────────────────────────────────
        // Issue 404 → return 404 to client (correct behavior, not degradation).
        let issue;
        try {
            issue = await (0, issueClient_1.fetchIssue)(owner, repo, issueNumber);
        }
        catch (err) {
            const status = err.status;
            if (status === 404) {
                return res.status(404).json({
                    error: `Issue #${issueNumber} not found in ${owner}/${repo}`,
                });
            }
            throw err;
        }
        // Comments and linked PRs: failures are non-fatal — pass empty arrays.
        const comments = await (0, issueClient_1.fetchIssueComments)(owner, repo, issueNumber, 20).catch(() => []);
        const linkedPRs = await (0, issueClient_1.fetchLinkedPRs)(owner, repo, issueNumber).catch(() => []);
        console.log(`[issueMap] fetched issue #${issueNumber}: "${issue.title}" ` +
            `(${comments.length} comments, ${linkedPRs.length} linked PRs)`);
        // ── Step 3.5: Resolve graph data ──────────────────────────────────────
        // graphData comes from the request body (frontend sends it inline),
        // OR from Redis (when the frontend doesn't include it).
        // Degradation: if neither available, return 400 — cannot map without file list.
        let resolvedGraphData = graphData;
        if (!resolvedGraphData) {
            try {
                const cachedGraph = await jobQueue_1.redisConnection.get(`graph:${owner}:${repo}`);
                if (cachedGraph) {
                    const parsed = JSON.parse(cachedGraph);
                    resolvedGraphData = {
                        files: (parsed.files ?? []).map((f) => ({
                            id: f.id,
                            label: f.label,
                            architecturalImportance: (f.architecturalImportance ?? 0),
                        })),
                        functions: [],
                    };
                    console.log(`[issueMap] graph data recovered from Redis (${resolvedGraphData.files.length} files)`);
                }
            }
            catch {
                // Redis down — resolvedGraphData stays null
            }
        }
        if (!resolvedGraphData?.files.length) {
            return res.status(400).json({
                error: "Graph data missing and not found in cache. Please re-analyze the repo.",
            });
        }
        // ── Step 4: Run the pipeline ──────────────────────────────────────────
        // issuePipeline owns all business logic from here.
        // The route only provides: what files exist, what the issue is.
        const graphFileIds = new Set(resolvedGraphData.files.map(f => f.id));
        const pipelineInput = {
            owner,
            repo,
            commitSha,
            issue: {
                title: issue.title,
                body: issue.body,
                comments,
                linkedPRs,
            },
            linkedPRs,
            graphFileIds,
            legacyFiles: resolvedGraphData.files,
        };
        let pipelineResult;
        try {
            pipelineResult = await (0, issuePipeline_1.runIssueMappingPipeline)(pipelineInput);
        }
        catch (err) {
            // Pipeline threw unexpectedly — return graceful empty result, not 500.
            console.error("[issueMap] pipeline threw unexpectedly:", err.message);
            pipelineResult = {
                geminiResult: null,
                usedNewPipeline: false,
                snippetCount: 0,
                isVague: false,
                intent: null,
                fallbackFiles: [],
            };
        }
        // ── Step 5: Build response ────────────────────────────────────────────
        // Translate PipelineResult → IssueMapResponse (the frontend contract).
        const { geminiResult, usedNewPipeline, snippetCount, fallbackFiles } = pipelineResult;
        let affectedFiles = [];
        const affectedFunctions = []; // populated by future suggest-fix
        let source = "deterministic";
        let summary;
        if (geminiResult && geminiResult.affectedFiles.length > 0) {
            affectedFiles = geminiResult.affectedFiles;
            source = "ai";
            summary = geminiResult.summary;
            console.log(`[issueMap] mapping succeeded — ${affectedFiles.length} files, ` +
                `${snippetCount} snippets, new_pipeline=${usedNewPipeline}`);
        }
        else {
            affectedFiles = [];
            console.log(`\x1b[31m[issueMap] pipeline returned no AI result — 0 files found. ` +
                `new_pipeline=${usedNewPipeline}, snippets=${snippetCount}\x1b[0m`);
        }
        const overallConfidence = affectedFiles.length > 0
            ? Math.max(...affectedFiles.map(f => f.confidence))
            : 0;
        const response = {
            issueNumber,
            issueTitle: issue.title,
            issueBody: issue.body,
            issueUrl: issue.htmlUrl,
            affectedFiles,
            affectedFunctions,
            source,
            overallConfidence,
            summary,
        };
        // ── Step 6: Cache result ──────────────────────────────────────────────
        // Only cache when we have a useful result.
        // Cache failure is never fatal.
        if (affectedFiles.length > 0) {
            try {
                await jobQueue_1.redisConnection.set(cacheKey, JSON.stringify(response));
            }
            catch {
                console.warn("[issueMap] failed to write result to cache (Redis down)");
            }
        }
        return res.json(response);
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            return res.status(400).json({ error: "Invalid request", details: err.issues });
        }
        next(err);
    }
});
// ── POST /issue-map/suggest-fix (501 stub) ────────────────────────────────────
// Not implemented — stub kept so the frontend can show a "coming soon" state.
router.post("/suggest-fix", async (req, res) => {
    const result = SuggestFixRequestSchema.safeParse(req.body);
    if (!result.success) {
        return res.status(400).json({ error: "Invalid request", details: result.error.issues });
    }
    return res.status(501).json({ error: "Fix suggestions coming soon" });
});
// ── POST /issue-map/chat ──────────────────────────────────────────────────────
// Unchanged — this route has its own separate context pipeline that fetches
// raw file content and builds a system prompt for an interactive chat session.
// It does NOT use the issue mapping pipeline.
router.post("/chat", async (req, res, next) => {
    try {
        const { owner, repo, commitSha, issueNumber, fileId, connectedFileIds, messages, } = ChatRequestSchema.parse(req.body);
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        const cacheKey = `issue-chat-ctx:${owner}:${repo}:${issueNumber ?? "no-issue"}:${fileId}:${commitSha}`;
        let systemContext = null;
        try {
            systemContext = await jobQueue_1.redisConnection.get(cacheKey);
        }
        catch {
            // Redis down — build context fresh
        }
        if (!systemContext) {
            let issueData = null;
            let prData = [];
            let primaryFileContent = "";
            if (issueNumber) {
                const [fetchedIssue, comments, linkedPRs, content] = await Promise.all([
                    (0, issueClient_1.fetchIssue)(owner, repo, issueNumber),
                    (0, issueClient_1.fetchIssueComments)(owner, repo, issueNumber, 5),
                    (0, issueClient_1.fetchLinkedPRs)(owner, repo, issueNumber),
                    (0, issueClient_1.fetchRawFile)(owner, repo, commitSha, fileId),
                ]);
                issueData = fetchedIssue;
                prData = linkedPRs;
                primaryFileContent = content;
            }
            else {
                primaryFileContent = await (0, issueClient_1.fetchRawFile)(owner, repo, commitSha, fileId);
            }
            const connectedContents = await Promise.all(connectedFileIds.map((id) => (0, issueClient_1.fetchRawFile)(owner, repo, commitSha, id)
                .then((content) => ({ id, content }))));
            const issueTerms = issueData
                ? [...new Set((issueData.title + " " + issueData.body)
                        .match(/\b([a-z][a-zA-Z0-9_]{2,}|[A-Z][a-zA-Z0-9_]{2,})\b/g) ?? [])]
                : [];
            const primaryTruncated = (0, issueAnalyzer_1.smartTruncate)(primaryFileContent, issueTerms, 300);
            const connectedParts = connectedContents
                .filter((c) => c.content)
                .map((c) => `-- ${c.id} --\n${(0, issueAnalyzer_1.smartTruncate)(c.content, issueTerms, 80)}`)
                .join("\n\n");
            const prLines = prData.map((pr) => `  PR #${pr.number} [${pr.merged ? "MERGED" : pr.state.toUpperCase()}]: ${pr.title}\n` +
                `  Changed files: ${pr.changedFiles.slice(0, 10).join(", ")}`).join("\n");
            systemContext = [
                `REPOSITORY: ${owner}/${repo}`,
                issueData
                    ? `ISSUE #${issueNumber}: ${issueData.title}`
                    : "NO SPECIFIC ISSUE SELECTED",
                "",
                "ISSUE DESCRIPTION:",
                issueData ? issueData.body.slice(0, 600) : "N/A",
                "",
                "LINKED PULL REQUESTS:",
                prLines || "None",
                "",
                `PRIMARY FILE: ${fileId}`,
                primaryTruncated,
                "",
                connectedParts ? `CONNECTED FILES:\n${connectedParts}` : "",
            ].join("\n");
            try {
                await jobQueue_1.redisConnection.set(cacheKey, systemContext);
            }
            catch {
                // Redis down — context will be rebuilt on next request
            }
        }
        const result = await (0, issueAnalyzer_1.callGeminiForChatStream)(systemContext, messages);
        for await (const chunk of result.stream) {
            const text = chunk.text();
            res.write(`data: ${JSON.stringify(text)}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.write(`data: ${JSON.stringify("[Error] Invalid request: " + err.message)}\n\n`);
            res.write("data: [DONE]\n\n");
            return res.end();
        }
        console.error("[issueMap chat] Error:", err);
        res.write(`data: ${JSON.stringify("[Error] Failed to process chat request.")}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
    }
});
exports.default = router;
