"use strict";
// backend/src/routes/analyze.ts
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const crypto_1 = require("crypto");
const jobQueue_1 = require("../queue/jobQueue");
const config_1 = require("../config/config");
const router = (0, express_1.Router)();
const analyzeSchema = zod_1.z.object({
    repoUrl: zod_1.z
        .string()
        .regex(/^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, "Must be a valid GitHub repo URL: https://github.com/{owner}/{repo}"),
});
function parseOwnerRepo(repoUrl) {
    const parts = repoUrl.replace("https://github.com/", "").split("/");
    return { owner: parts[0], repo: parts[1] };
}
router.post("/", async (req, res, next) => {
    try {
        const { repoUrl } = analyzeSchema.parse(req.body);
        // Check queue depth — no network calls, just Redis
        const counts = await jobQueue_1.jobQueue.getJobCounts("waiting", "active");
        const totalActive = (counts.waiting ?? 0) + (counts.active ?? 0);
        if (totalActive >= config_1.config.queue.maxQueueSize) {
            return res.status(503).json({
                error: "Server is busy. Try again in a few minutes.",
                queueDepth: totalActive,
            });
        }
        const { owner, repo } = parseOwnerRepo(repoUrl);
        const jobId = (0, crypto_1.randomUUID)();
        const job = await jobQueue_1.jobQueue.add("analyze", { repoUrl, owner, repo, jobId }, { jobId } // use our own UUID as BullMQ job ID
        );
        const waitingCount = counts.waiting ?? 0;
        return res.status(202).json({
            jobId: job.id,
            position: waitingCount + 1,
            estimatedWaitMs: (waitingCount + 1) * 60000, // rough estimate
        });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            return res.status(400).json({
                error: "Invalid request",
                details: err.flatten().fieldErrors,
            });
        }
        next(err);
    }
});
exports.default = router;
