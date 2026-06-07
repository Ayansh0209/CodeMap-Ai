import "dotenv/config";
import { jobQueue, redisConnection } from "../queue/jobQueue";
import { randomUUID } from "crypto";

const repos = [
    { owner: "colinhacks", repo: "zod", url: "https://github.com/colinhacks/zod" },
    { owner: "trpc", repo: "trpc", url: "https://github.com/trpc/trpc" },
    { owner: "nestjs", repo: "nest", url: "https://github.com/nestjs/nest" },
];

async function main() {
    console.log("Queueing analysis jobs for repos...");
    
    for (const r of repos) {
        const jobId = randomUUID();
        console.log(`Adding ${r.owner}/${r.repo} to queue (jobId: ${jobId})...`);
        await jobQueue.add(
            "analyze",
            { repoUrl: r.url, owner: r.owner, repo: r.repo, jobId },
            { jobId }
        );
    }
    
    console.log("All jobs added successfully!");
    await redisConnection.quit();
}

main().catch(console.error);
