import IORedis from "ioredis";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.join(__dirname, "../.env") });

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
    console.error("Missing REDIS_URL in .env");
    process.exit(1);
}

const redis = new IORedis(redisUrl);
const issueNumber = process.argv[2];

if (!issueNumber) {
    console.error("Please provide an issue number or 'all'");
    process.exit(1);
}

async function clearCache() {
    let keys: string[] = [];
    if (issueNumber.toLowerCase() === "all") {
        console.log("Searching for all issue-map and issue-chat-ctx keys...");
        const pattern1 = "issue-map:*";
        const pattern2 = "issue-chat-ctx:*";
        const keys1 = await redis.keys(pattern1);
        const keys2 = await redis.keys(pattern2);
        keys = [...keys1, ...keys2];
    } else {
        console.log(`Searching for keys related to issue #${issueNumber}...`);
        
        // Pattern: issue-map:*:*:issueNumber:*
        const pattern = `issue-map:*:*:${issueNumber}:*`;
        keys = await redis.keys(pattern);
    }

    if (keys.length === 0) {
        console.log("No cached data found.");
    } else {
        console.log(`Found ${keys.length} keys:`);
        keys.forEach(k => console.log(`  - ${k}`));
        
        await redis.del(...keys);
        console.log("\x1b[32mSuccessfully deleted cached data.\x1b[0m");
    }

    process.exit(0);
}

clearCache().catch(err => {
    console.error("Error:", err);
    process.exit(1);
});
