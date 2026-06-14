// backend/src/routes/analyze.ts

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { jobQueue } from "../queue/jobQueue";
import { config } from "../config/config";

const router = Router();

// ── Rate limit: protect the CPU-heavy endpoint from spam ─────────────────────
const analyzeLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    limit: Number(process.env.ANALYZE_RATE_LIMIT || 10),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many analyze requests. Try again later." },
});

const analyzeSchema = z.object({
    repoUrl: z
        .string()
        .regex(
            /^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/,
            "Must be a valid GitHub repo URL: https://github.com/{owner}/{repo}"
        ),
});

function parseOwnerRepo(repoUrl: string): { owner: string; repo: string } {
    const parts = repoUrl.replace("https://github.com/", "").split("/");
    return { owner: parts[0], repo: parts[1] };
}

/**
 * Deterministic job ID per repo.
 * The exact same repo submitted twice (double-click, two tabs, retry spam)
 * must NEVER run as two parallel jobs — that was doubling RAM usage in
 * production. NOTE: no ":" allowed in BullMQ custom job IDs.
 */
function repoJobId(owner: string, repo: string): string {
    return `${owner}--${repo}`.toLowerCase();
}

router.post("/", analyzeLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { repoUrl } = analyzeSchema.parse(req.body);
        const { owner, repo } = parseOwnerRepo(repoUrl);
        const jobId = repoJobId(owner, repo);

        // ── Dedup: same repo already queued or running? Return that job. ──────
        const existing = await jobQueue.getJob(jobId);
        if (existing) {
            const state = await existing.getState();

            if (state === "waiting" || state === "active" || state === "delayed" || state === "prioritized") {
                return res.status(202).json({
                    jobId,
                    deduped: true,
                    message: "This repository is already being analyzed.",
                });
            }

            // completed/failed → remove the old record so we can re-add.
            // (Re-analysis of an unchanged repo is still instant via the SHA cache.)
            try {
                await existing.remove();
            } catch {
                // If removal races with something else, fall through — add() with
                // a duplicate ID is a no-op that returns the existing job.
            }
        }

        // ── Queue depth check ─────────────────────────────────────────────────
        const counts = await jobQueue.getJobCounts("waiting", "active");
        const totalActive = (counts.waiting ?? 0) + (counts.active ?? 0);

        if (totalActive >= config.queue.maxQueueSize) {
            return res.status(503).json({
                error: "Server is busy. Try again in a few minutes.",
                queueDepth: totalActive,
            });
        }

        const job = await jobQueue.add(
            "analyze",
            { repoUrl, owner, repo, jobId },
            { jobId }
        );

        const waitingCount = counts.waiting ?? 0;

        return res.status(202).json({
            jobId: job.id,
            position: waitingCount + 1,
            estimatedWaitMs: (waitingCount + 1) * 60000,
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            return res.status(400).json({
                error: "Invalid request",
                details: err.flatten().fieldErrors,
            });
        }
        next(err);
    }
});

export default router;
