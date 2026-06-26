// backend/src/routes/status.ts

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { jobQueue } from "../queue/jobQueue";

const router = Router();

// Job IDs are now deterministic "owner--repo" (may contain dots/underscores)
const jobIdSchema = z.string().regex(/^[a-zA-Z0-9._-]{1,120}$/, "Invalid jobId");

router.get("/:jobId", async (req: Request, res: Response, next: NextFunction) => {
    try {
        const jobId = jobIdSchema.parse(req.params.jobId);

        const job = await jobQueue.getJob(jobId);

        if (!job) {
            return res.status(404).json({ error: "Job not found" });
        }

        const state = await job.getState();

        switch (state) {
            case "waiting":
            case "delayed": {
                // BullMQ does not have a native job.getPosition() method.
                // For "waiting" jobs, we can find the index in the waiting list.
                let position = 0;
                if (state === "waiting") {
                    const waitingJobs = await jobQueue.getWaiting();
                    const index = waitingJobs.findIndex(j => j.id === jobId);
                    position = index !== -1 ? index + 1 : 0;
                }

                return res.json({
                    status: state === "waiting" ? "queued" : "delayed",
                    position,
                });
            }

            case "active": {
                // progress is { percent, step } (object form survives the
                // sandboxed-processor boundary; job.updateData does not)
                const p = job.progress as any;
                // The worker can mark the graph "ready" — handing over the result
                // via progress — before the job fully completes; it keeps writing
                // the lazy-loaded per-file function artifacts afterwards. Surface
                // that as "done" so the UI renders the graph without waiting on
                // the remaining storage.
                if (p && typeof p === "object" && p.ready && p.result) {
                    return res.json({ status: "done", ...(p.result as object) });
                }
                const percent = typeof p === "number" ? p : (p?.percent ?? 0);
                const step = typeof p === "object" && p?.step ? p.step : "processing";
                return res.json({
                    status: "processing",
                    progress: percent,
                    step,
                });
            }

            case "completed": {
                return res.json({
                    status: "done",
                    ...(job.returnvalue as object),
                });
            }

            case "failed": {
                return res.json({
                    status: "failed",
                    error: job.failedReason ?? "Unknown error",
                });
            }

            default:
                return res.json({ status: state });
        }
    } catch (err) {
        if (err instanceof z.ZodError) {
            return res.status(400).json({ error: "Invalid job ID" });
        }
        next(err);
    }
});

export default router;
