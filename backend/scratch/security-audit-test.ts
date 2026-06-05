import Redis from "ioredis";
import * as dotenv from "dotenv";
import * as path from "path";
import { getDateString } from "../src/middleware/rateLimiter";

dotenv.config({ path: path.join(__dirname, "../.env") });

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

async function runAuditTests() {
    console.log("=== STARTING SECURITY & ABUSE AUDIT TESTING ===");

    const owner = "test-owner";
    const repo = "test-repo";
    const commitSha = "test-sha";
    const currentFileId = "src/server.ts";

    const dateStr = getDateString();
    const deviceId = "device:test-device-123";
    const deviceReqKey = `rate-limit:req:${deviceId}:${dateStr}`;
    const deviceTokKey = `rate-limit:tok:${deviceId}:${dateStr}`;

    console.log("Cleaning rate limiting keys in Redis...");
    await redis.del(deviceReqKey);
    await redis.del(deviceTokKey);
    await redis.del("telemetry:chat");

    // 1. Perform a successful chat request
    console.log("\n--- TEST 1: Sending first valid request to POST /chat ---");
    try {
        const response = await fetch("http://localhost:5000/issue-map/chat", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-device-id": "test-device-123"
            },
            body: JSON.stringify({
                owner,
                repo,
                commitSha,
                currentFileId,
                messages: [
                    { role: "user", content: "Hello! This is a test request." }
                ]
            })
        });

        console.log("Response status:", response.status);
        console.log("Response headers content-type:", response.headers.get("content-type"));
        
        // Consume stream to ensure request completes
        if (response.body) {
            const reader = response.body.getReader();
            let done = false;
            while (!done) {
                const { done: d } = await reader.read();
                done = d;
            }
        }
        
        // Wait 1.5 seconds for async token tracking and telemetry to finish writing in backend
        await new Promise(resolve => setTimeout(resolve, 1500));

        // 2. Inspect Redis for requests count and tokens count
        console.log("\n--- TEST 2: Inspecting Redis for Rate Limiter state ---");
        const reqCount = await redis.get(deviceReqKey);
        const tokCount = await redis.get(deviceTokKey);
        console.log(`Redis Request Count for device: ${reqCount} (expected: 1)`);
        console.log(`Redis Token Count for device: ${tokCount} (expected: >0)`);

        // 3. Test Token Limit Exceeded Behavior
        console.log("\n--- TEST 3: Testing Rate Limiting (Requests limit) ---");
        // Simulate that request limit has been reached by setting key in Redis
        console.log("Mocking daily request limit (setting count to 100) in Redis...");
        await redis.set(deviceReqKey, "100");

        const blockedReqResponse = await fetch("http://localhost:5000/issue-map/chat", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-device-id": "test-device-123"
            },
            body: JSON.stringify({
                owner,
                repo,
                commitSha,
                currentFileId,
                messages: [
                    { role: "user", content: "This should be blocked." }
                ]
            })
        });

        if (blockedReqResponse.status === 429) {
            console.log("SUCCESS: Request was correctly blocked with 429 Too Many Requests!");
            const body = await blockedReqResponse.json();
            console.log("Error details:", body);
        } else {
            console.error("FAIL: Request succeeded or returned status:", blockedReqResponse.status);
        }

        // Test Token limit reached
        console.log("\n--- TEST 4: Testing Rate Limiting (Token limit) ---");
        console.log("Resetting request count but mocking token limit (setting tokens to 500000) in Redis...");
        await redis.set(deviceReqKey, "5"); // clear request block
        await redis.set(deviceTokKey, "500000"); // trigger token block

        const blockedTokResponse = await fetch("http://localhost:5000/issue-map/chat", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-device-id": "test-device-123"
            },
            body: JSON.stringify({
                owner,
                repo,
                commitSha,
                currentFileId,
                messages: [
                    { role: "user", content: "This should be blocked." }
                ]
            })
        });

        if (blockedTokResponse.status === 429) {
            console.log("SUCCESS: Request was correctly blocked with 429 by token limit!");
            const body = await blockedTokResponse.json();
            console.log("Error details:", body);
        } else {
            console.error("FAIL: Request succeeded or returned status:", blockedTokResponse.status);
        }

        // 4. Verify Telemetry collection
        console.log("\n--- TEST 5: Verifying Telemetry entry in Redis ---");
        const telemetryList = await redis.lrange("telemetry:chat", 0, -1);
        console.log(`Number of telemetry records: ${telemetryList.length} (expected: 1)`);
        if (telemetryList.length > 0) {
            const record = JSON.parse(telemetryList[0]);
            console.log("Telemetry Record:", JSON.stringify(record, null, 2));
            if (record.promptTokens && record.completionTokens && record.retrievalTimeMs && record.geminiExecutionTimeMs) {
                console.log("SUCCESS: All telemetry fields populated correctly!");
            } else {
                console.error("FAIL: Telemetry record is missing key fields!");
            }
        } else {
            console.error("FAIL: Telemetry record not found!");
        }

    } catch (err: any) {
        console.error("Error in tests:", err.message);
    } finally {
        // Cleanup after test
        console.log("\nCleaning up test keys in Redis...");
        await redis.del(deviceReqKey);
        await redis.del(deviceTokKey);
        await redis.del("telemetry:chat");
        
        redis.disconnect();
        console.log("=== TESTS COMPLETE ===");
    }
}

runAuditTests();
