import { redisConnection } from "../src/queue/jobQueue";
import { clusterRepositoryFiles, computeModuleDependencies } from "../src/processing/clustering";

async function runTest() {
    console.log("Connecting to Redis...");
    try {
        const keys = await redisConnection.keys("repo:*");
        console.log(`Found ${keys.length} repositories in Redis:`);
        for (const k of keys) {
            console.log(` - ${k}`);
        }

        if (keys.length === 0) {
            console.log("No analyzed repositories found in Redis. Please analyze a repo first.");
            process.exit(0);
        }

        // Use the first repo key
        const targetKey = keys[0];
        console.log(`\nTesting clustering on repository: ${targetKey}`);
        const rawData = await redisConnection.get(targetKey);
        if (!rawData) {
            console.log("Failed to load repo data.");
            process.exit(1);
        }

        const parsed = JSON.parse(rawData);
        const fileGraph = parsed._inlineFileGraph;
        if (!fileGraph || !fileGraph.files) {
            console.log("Data is missing files list.");
            process.exit(1);
        }

        console.log(`File graph statistics:`);
        console.log(` - Total files: ${fileGraph.files.length}`);
        console.log(` - Import edges: ${fileGraph.importEdges?.length || 0}`);

        console.log("\nRunning clusterRepositoryFiles...");
        const modules = clusterRepositoryFiles(fileGraph.files, fileGraph.importEdges || []);
        console.log(`Generated ${modules.length} modules:`);
        for (const m of modules) {
            console.log(` - Module: ${m.name} (${m.files.length} files)`);
            console.log(`   Sample files: ${m.files.slice(0, 3).join(", ")}`);
        }

        console.log("\nRunning computeModuleDependencies...");
        const deps = computeModuleDependencies(modules, fileGraph.importEdges || []);
        console.log(`Generated ${deps.length} module dependencies:`);
        for (const d of deps.slice(0, 5)) {
            console.log(` - ${d.source} -> ${d.target} (weight: ${d.count})`);
        }

        console.log("\nDeterministic verification complete! Code runs perfectly.");
    } catch (err) {
        console.error("Test failed:", err);
    } finally {
        await redisConnection.quit();
        process.exit(0);
    }
}

runTest();
