import { redisConnection } from "../src/queue/jobQueue";

async function run() {
    const keys = await redisConnection.keys("repo:PalisadoesFoundation:talawa-api:*");
    if (keys.length === 0) {
        console.error("No Talawa API cache found in Redis.");
        process.exit(1);
    }
    const key = keys[0];
    console.log("Loading cache key:", key);
    const rawData = await redisConnection.get(key);
    if (!rawData) {
        console.error("Failed to load repo data.");
        process.exit(1);
    }

    const parsed = JSON.parse(rawData);
    const files = parsed._inlineFileGraph?.files || [];
    console.log(`Total files in graph: ${files.length}`);

    const entryPoints = files.filter((f: any) => f.isEntryPoint);
    console.log(`Total entry points detected: ${entryPoints.length}`);

    // Sort by score descending
    entryPoints.sort((a: any, b: any) => (b.entryScore ?? 0) - (a.entryScore ?? 0));

    console.log("\n=== TOP 30 ENTRY POINTS ===");
    for (const f of entryPoints.slice(0, 30)) {
        console.log(`File: ${f.id}`);
        console.log(`  Score: ${f.entryScore}`);
        console.log(`  Reasons: ${f.entryReasons?.join(", ")}`);
        console.log(`  isBarrel: ${f.isBarrel}`);
        console.log("--------------------------------------------------");
    }

    // Inspect some index/barrel files specifically
    console.log("\n=== TARGETED FILE AUDIT ===");
    const targets = [
        "src/graphql/types/AssignUserTag/index.ts",
        "src/server.ts",
        "src/index.ts",
        "src/app.ts"
    ];
    for (const t of targets) {
        const f = files.find((x: any) => x.id === t);
        if (f) {
            console.log(`File: ${f.id}`);
            console.log(`  isEntryPoint: ${f.isEntryPoint}`);
            console.log(`  Score: ${f.entryScore}`);
            console.log(`  Reasons: ${f.entryReasons?.join(", ")}`);
            console.log(`  isBarrel: ${f.isBarrel}`);
        } else {
            console.log(`File ${t} not found in graph.`);
        }
        console.log("--------------------------------------------------");
    }

    await redisConnection.quit();
}

run().catch(console.error);
