process.env.REDIS_URL = "redis://localhost:6379";
import Redis from "ioredis";
import * as dotenv from "dotenv";
import * as path from "path";
import { config } from "../src/config/config";
import { buildChatContext } from "../src/parser/chatContextBuilder";

dotenv.config({ path: path.join(__dirname, "../.env") });

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

async function main() {
    console.log("=== Testing Iterative Retrieval ===");

    // Force enable the iterative chat retrieval config flag
    config.chat.enableIterativeRetrieval = true;

    const owner = "test-owner";
    const repo = "test-repo";
    const commitSha = "test-sha";
    const currentFileId = "src/routes/user.ts";

    console.log("Populating mock retrieval index and graph data in Redis...");

    const mockRetrievalIndex = {
        repoId: `${owner}/${repo}`,
        commitSha,
        generatedAt: new Date().toISOString(),
        files: [
            {
                fileId: "src/server.ts",
                isBarrel: false,
                barrelTargets: [],
                semanticRole: "unknown",
                importedBy: [],
                imports: ["src/db/connection.ts", "src/routes/user.ts"],
                functions: [],
                structures: []
            },
            {
                fileId: "src/db/connection.ts",
                isBarrel: false,
                barrelTargets: [],
                semanticRole: "unknown",
                importedBy: ["src/server.ts"],
                imports: ["src/db/schema.ts"],
                functions: [],
                structures: []
            },
            {
                fileId: "src/db/schema.ts",
                isBarrel: false,
                barrelTargets: [],
                semanticRole: "unknown", // we'll let our heuristic detect it's a schema
                importedBy: ["src/db/connection.ts"],
                imports: [],
                functions: [],
                structures: [{ name: "UserTable", startLine: 1, endLine: 20 }]
            },
            {
                fileId: "src/routes/user.ts",
                isBarrel: false,
                barrelTargets: [],
                semanticRole: "unknown",
                importedBy: ["src/server.ts"],
                imports: ["src/db/connection.ts"],
                functions: [
                    {
                        id: "src/routes/user.ts::getUser",
                        name: "getUser",
                        filePath: "src/routes/user.ts",
                        startLine: 5,
                        endLine: 15,
                        kind: "function",
                        isExported: true,
                        isAsync: true,
                        hasAuthCheck: true,
                        hasDatabaseCall: true,
                        calls: []
                    }
                ],
                structures: []
            },
            {
                fileId: "src/tests/user.test.ts",
                isBarrel: false,
                barrelTargets: [],
                semanticRole: "test",
                importedBy: [],
                imports: ["src/routes/user.ts"],
                functions: [],
                structures: []
            }
        ]
    };

    const mockGraph = {
        files: [
            { id: "src/server.ts" },
            { id: "src/db/connection.ts" },
            { id: "src/db/schema.ts" },
            { id: "src/routes/user.ts" },
            { id: "src/tests/user.test.ts" }
        ]
    };

    await redis.set(`retrieval:${owner}:${repo}`, JSON.stringify(mockRetrievalIndex));
    await redis.set(`graph:${owner}:${repo}`, JSON.stringify(mockGraph));

    console.log("Mock data populated successfully.");

    // Resolve graphFileIds
    const graphFileIds = new Set<string>();
    for (const file of mockGraph.files) {
        graphFileIds.add(file.id);
    }

    // We want a user message that triggers missing categories
    const userMessage = `What tests and schemas exist for the user routes file (${currentFileId})? Please check usages too.`;

    // Clear chat context cache to force execution
    const cacheKey = `issue-chat-ctx:v2:${owner}:${repo}:no-issue:${currentFileId}:${commitSha}`;
    console.log(`Deleting cache key: ${cacheKey}`);
    await redis.del(cacheKey);

    console.log("\nCalling buildChatContext...");
    const context = await buildChatContext({
        currentFileId,
        userMessage,
        owner,
        repo,
        commitSha,
        graphFileIds
    });

    console.log("\n=== CONTEXT BUILD COMPLETED ===");
    console.log(`Candidate count: ${context.candidateCount}`);
    console.log(`Snippet count: ${context.snippets.length}`);
    console.log("Snippet files:");
    const fileSnippetCounts = new Map<string, number>();
    for (const snip of context.snippets) {
        fileSnippetCounts.set(snip.fileId, (fileSnippetCounts.get(snip.fileId) ?? 0) + 1);
    }
    for (const [file, count] of fileSnippetCounts.entries()) {
        console.log(`  - ${file}: ${count} snippets`);
    }

    console.log("\nSystem Instruction output:");
    console.log(context.systemInstruction.slice(0, 1000) + "...\n[TRUNCATED]");

    await redis.quit();
}

main().catch(err => {
    console.error("Test error:", err);
});
