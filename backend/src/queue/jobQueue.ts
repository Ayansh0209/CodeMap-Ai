// backend/src/queue/jobQueue.ts

import { Queue } from "bullmq";
import { redisConnection } from "./redis";

// Re-export for backwards compatibility — many modules import it from here
export { redisConnection };

export const jobQueue = new Queue("repo-analysis", {
    connection: redisConnection,
    defaultJobOptions: {
        attempts: 2,
        backoff: {
            type: "fixed",
            delay: 5000,
        },
        removeOnComplete: { count: 100 },   // keep last 100 completed jobs
        removeOnFail: { count: 50 },        // keep last 50 failed jobs for debugging
    },
});
