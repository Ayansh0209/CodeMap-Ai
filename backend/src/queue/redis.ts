// backend/src/queue/redis.ts
// Single shared IORedis connection factory.
// Lives in its own module (NOT jobQueue.ts) so the sandboxed processor child
// process can import a Redis connection without also instantiating a Queue.

import IORedis from "ioredis";
import { config } from "../config/config";

export const redisConnection = new IORedis(config.redis.url, {
    maxRetriesPerRequest: null,   // required by BullMQ
    enableReadyCheck: false,      // required by BullMQ
    lazyConnect: false,
    retryStrategy() {
        // Wait 5 seconds between reconnect attempts to avoid spam
        return 5000;
    },
});

let lastErrorTime = 0;
redisConnection.on("error", () => {
    // Only print the error once every 5 seconds to prevent infinite terminal spam
    if (Date.now() - lastErrorTime >= 5000) {
        console.error(`\x1b[31m[redis] Connection error: could not reach Redis\x1b[0m`);
        console.error(`\x1b[33m-> If running locally, start Redis first (e.g. docker run -p 6379:6379 redis)\x1b[0m`);
        lastErrorTime = Date.now();
    }
});

redisConnection.on("connect", () => {
    // NOTE: never log the URL — it contains the password
    console.log(`[redis] connected`);
});
