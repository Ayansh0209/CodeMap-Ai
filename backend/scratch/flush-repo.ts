// One-off dev helper: flush a SINGLE repo's cached analysis from Redis so the
// next /analyze does a full fresh run (re-parse + re-store) — for timing tests.
// Scoped to specific key patterns for one owner/repo; never a flushall.
//   run: npx ts-node -T scratch/flush-repo.ts
import { redisConnection } from "../src/queue/redis";

const OWNER = "trpc";
const REPO = "trpc";

async function delPattern(pattern: string): Promise<number> {
    const keys: string[] = [];
    const stream = redisConnection.scanStream({ match: pattern, count: 250 });
    for await (const batch of stream) for (const k of batch as string[]) keys.push(k);
    for (let i = 0; i < keys.length; i += 500) {
        await redisConnection.del(...keys.slice(i, i + 500));
    }
    console.log(`  ${pattern.padEnd(40)} → ${keys.length} keys`);
    return keys.length;
}

(async () => {
    console.log(`Flushing Redis for ${OWNER}/${REPO} (result cache + parse checkpoints + indexes)…`);
    const patterns = [
        `repo:${OWNER}:${REPO}:*`,          // SHA-keyed result cache (forces re-run)
        `checkpoint:${OWNER}:${REPO}:*`,    // per-chunk parse checkpoints (forces re-parse)
        `latest-sha:${OWNER}:${REPO}`,
        `retrieval:${OWNER}:${REPO}`,
        `search:${OWNER}:${REPO}`,
        `artifact:graphs/${OWNER}/${REPO}/*`,    // only present on the Redis fallback
        `artifact:functions/${OWNER}/${REPO}/*`, // (you're on R2, so these are 0)
    ];
    let total = 0;
    for (const p of patterns) total += await delPattern(p);
    console.log(`Done — ${total} Redis keys removed for ${OWNER}/${REPO}. (R2 artifacts overwrite on re-analysis.)`);
    await redisConnection.quit();
    process.exit(0);
})();
