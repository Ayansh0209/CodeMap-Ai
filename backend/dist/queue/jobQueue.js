"use strict";
// backend/src/queue/jobQueue.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.jobQueue = exports.redisConnection = void 0;
const bullmq_1 = require("bullmq");
const ioredis_1 = __importDefault(require("ioredis"));
const config_1 = require("../config/config");
// Shared IORedis connection — reuse across Queue + Worker
// BullMQ requires Redis binary protocol, NOT Upstash REST
exports.redisConnection = new ioredis_1.default(config_1.config.redis.url, {
    maxRetriesPerRequest: null, // required by BullMQ
    enableReadyCheck: false, // required by BullMQ
    lazyConnect: false,
    retryStrategy(times) {
        // Wait 5 seconds between reconnect attempts to avoid spam
        return 5000;
    }
});
let lastErrorTime = 0;
exports.redisConnection.on("error", (err) => {
    // Only print the error once every 5 seconds to prevent infinite terminal spam
    if (Date.now() - lastErrorTime >= 5000) {
        console.error(`\x1b[31m[redis] Connection Refused: Could not connect to Redis at ${config_1.config.redis.url}\x1b[0m`);
        console.error(`\x1b[33m-> If running locally, make sure you have started a Redis server (e.g. docker run -p 6379:6379 redis)\x1b[0m`);
        lastErrorTime = Date.now();
    }
});
exports.redisConnection.on("connect", () => {
    console.log(`[redis] connected to ${config_1.config.redis.url}`);
});
exports.jobQueue = new bullmq_1.Queue("repo-analysis", {
    connection: exports.redisConnection,
    defaultJobOptions: {
        attempts: 2,
        backoff: {
            type: "fixed",
            delay: 5000,
        },
        removeOnComplete: { count: 100 }, // keep last 100 completed jobs
        removeOnFail: { count: 50 }, // keep last 50 failed jobs for debugging
    },
});
