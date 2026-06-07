import IORedis from "ioredis";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.join(__dirname, "../.env") });

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
    console.error("REDIS_URL is not set in environment");
    process.exit(1);
}

console.log(`Connecting to Redis at ${redisUrl}...`);
const redis = new IORedis(redisUrl);

redis.on("connect", async () => {
    console.log("Connected! Flushing Redis...");
    try {
        const result = await redis.flushall();
        console.log(`Redis flushed successfully: ${result}`);
    } catch (err) {
        console.error("Failed to flush Redis:", err);
    } finally {
        redis.disconnect();
        process.exit(0);
    }
});

redis.on("error", (err) => {
    console.error("Redis connection error:", err);
    process.exit(1);
});
