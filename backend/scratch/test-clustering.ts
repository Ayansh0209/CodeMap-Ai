import { redisConnection } from "../src/queue/jobQueue";
import { clusterRepositoryFiles } from "../src/processing/clustering";

async function run() {
    // 1. Find Talawa API key
    const talawaKeys = await redisConnection.keys("repo:PalisadoesFoundation:talawa-api:*");
    if (talawaKeys.length === 0) {
        console.error("No Talawa API cache found in Redis.");
    } else {
        const key = talawaKeys[0];
        console.log("\n=== TESTING CLUSTERING ON TALAWA API ===");
        console.log("Loading cache key:", key);
        const rawData = await redisConnection.get(key);
        if (rawData) {
            const parsed = JSON.parse(rawData);
            const fileGraph = parsed._inlineFileGraph;
            if (fileGraph && fileGraph.files) {
                const modules = clusterRepositoryFiles(fileGraph.files, fileGraph.importEdges || []);
                console.log(`Total modules generated: ${modules.length}`);
                for (const m of modules) {
                    console.log(`\nModule: ${m.name}`);
                    console.log(`  Description: ${m.description}`);
                    console.log(`  Files count: ${m.files.length}`);
                    console.log(`  Sample files:`, m.files.slice(0, 5));
                    
                    // Audit: Check if any config/doc files are in this module
                    const infraFilesInSrcModule = m.files.filter(f => {
                        const path = f.toLowerCase();
                        return path.endsWith(".md") || path.endsWith(".json") || path.endsWith(".yml") || path.endsWith(".yaml") || path.includes(".github") || path.includes("docs/");
                    });
                    if (infraFilesInSrcModule.length > 0 && m.name !== "Project Infrastructure & Docs") {
                        console.log(`  [WARNING] Non-source files found in source module:`, infraFilesInSrcModule);
                    }
                }
            }
        }
    }

    // 2. Find Hono key
    const honoKeys = await redisConnection.keys("repo:honojs:hono:*");
    if (honoKeys.length === 0) {
        console.log("\nNo Hono cache found in Redis.");
    } else {
        const key = honoKeys[0];
        console.log("\n=== TESTING CLUSTERING ON HONO ===");
        console.log("Loading cache key:", key);
        const rawData = await redisConnection.get(key);
        if (rawData) {
            const parsed = JSON.parse(rawData);
            const fileGraph = parsed._inlineFileGraph;
            if (fileGraph && fileGraph.files) {
                const modules = clusterRepositoryFiles(fileGraph.files, fileGraph.importEdges || []);
                console.log(`Total modules generated: ${modules.length}`);
                for (const m of modules) {
                    console.log(`\nModule: ${m.name}`);
                    console.log(`  Description: ${m.description}`);
                    console.log(`  Files count: ${m.files.length}`);
                    console.log(`  Sample files:`, m.files.slice(0, 5));
                    
                    const infraFilesInSrcModule = m.files.filter(f => {
                        const path = f.toLowerCase();
                        return path.endsWith(".md") || path.endsWith(".json") || path.endsWith(".yml") || path.endsWith(".yaml") || path.includes(".github") || path.includes("docs/");
                    });
                    if (infraFilesInSrcModule.length > 0 && m.name !== "Project Infrastructure & Docs") {
                        console.log(`  [WARNING] Non-source files found in source module:`, infraFilesInSrcModule);
                    }
                }
            }
        }
    }

    await redisConnection.quit();
}

run().catch(console.error);
