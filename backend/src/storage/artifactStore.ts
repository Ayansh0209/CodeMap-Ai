// backend/src/storage/artifactStore.ts
// ─────────────────────────────────────────────────────────────────────────────
// Storage layer for large analysis artifacts (file graphs, per-file functions).
//
// WHY THIS EXISTS:
//   Graph JSONs can be tens of MB. Stuffing them raw into Redis (small managed
//   instance, volatile-lru eviction) fills it up and gets BullMQ keys evicted.
//
// BACKENDS (picked automatically):
//   1. Cloudflare R2 (S3 API) — used when R2_* env vars are set. Free tier:
//      10GB storage, free egress. This is the canonical store.
//   2. Redis fallback — gzipped + TTL'd. Used when R2 is not configured so
//      local dev works with zero setup. ~85-90% smaller than the raw JSON
//      that used to be stored.
//
// All artifacts are stored as gzipped JSON. Keys look like S3 object keys:
//   graphs/{owner}/{repo}/{sha}/filegraph.json.gz
//   functions/{owner}/{repo}/{sha}/{fileId}.json.gz
// ─────────────────────────────────────────────────────────────────────────────

import { gzipSync, gunzipSync } from "zlib";
import { config } from "../config/config";
import { redisConnection } from "../queue/redis";

// ── R2 client (lazy, optional) ────────────────────────────────────────────────

let s3Client: any = null;
let s3Checked = false;

function r2Configured(): boolean {
    return Boolean(
        config.r2.accountId &&
        config.r2.accessKeyId &&
        config.r2.secretAccessKey &&
        config.r2.bucketName
    );
}

function getS3(): any | null {
    if (s3Checked) return s3Client;
    s3Checked = true;

    if (!r2Configured()) {
        console.log("[artifactStore] R2 not configured — using Redis fallback (gzipped, TTL)");
        return null;
    }

    try {
        // Lazy require so the dependency is only needed when R2 is actually used
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { S3Client } = require("@aws-sdk/client-s3");
        s3Client = new S3Client({
            region: "auto",
            endpoint: `https://${config.r2.accountId}.r2.cloudflarestorage.com`,
            credentials: {
                accessKeyId: config.r2.accessKeyId,
                secretAccessKey: config.r2.secretAccessKey,
            },
        });
        console.log("[artifactStore] R2 configured — artifacts go to bucket:", config.r2.bucketName);
        return s3Client;
    } catch (err) {
        console.warn(
            "[artifactStore] R2 env vars set but @aws-sdk/client-s3 not installed — " +
            "run `npm install` in backend/. Falling back to Redis.",
            (err as Error).message
        );
        return null;
    }
}

function redisKey(key: string): string {
    return `artifact:${key}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function storageBackend(): "r2" | "redis" {
    return getS3() ? "r2" : "redis";
}

/** Store a JSON-serializable object, gzipped. */
export async function putArtifact(key: string, data: object): Promise<void> {
    const gz = gzipSync(Buffer.from(JSON.stringify(data)));
    const s3 = getS3();

    if (s3) {
        const { PutObjectCommand } = require("@aws-sdk/client-s3");
        await s3.send(new PutObjectCommand({
            Bucket: config.r2.bucketName,
            Key: key,
            Body: gz,
            ContentType: "application/json",
            ContentEncoding: "gzip",
        }));
        return;
    }

    // Redis fallback: store gzipped buffer with TTL so it can't grow unbounded
    await redisConnection.set(redisKey(key), gz, "EX", config.artifacts.ttlSeconds);
}

/** Fetch the raw gzipped bytes (for streaming straight to a browser). */
export async function getArtifactGzip(key: string): Promise<Buffer | null> {
    const s3 = getS3();

    if (s3) {
        try {
            const { GetObjectCommand } = require("@aws-sdk/client-s3");
            const res = await s3.send(new GetObjectCommand({
                Bucket: config.r2.bucketName,
                Key: key,
            }));
            const chunks: Buffer[] = [];
            for await (const chunk of res.Body as AsyncIterable<Buffer>) {
                chunks.push(Buffer.from(chunk));
            }
            return Buffer.concat(chunks);
        } catch (err: any) {
            if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) return null;
            throw err;
        }
    }

    return redisConnection.getBuffer(redisKey(key));
}

/** Fetch and parse an artifact. Returns null when missing. */
export async function getArtifact<T = unknown>(key: string): Promise<T | null> {
    const gz = await getArtifactGzip(key);
    if (!gz) return null;
    try {
        return JSON.parse(gunzipSync(gz).toString("utf-8")) as T;
    } catch (err) {
        console.warn(`[artifactStore] failed to decode artifact ${key}:`, (err as Error).message);
        return null;
    }
}

/** Delete an artifact (best-effort). */
export async function deleteArtifact(key: string): Promise<void> {
    try {
        const s3 = getS3();
        if (s3) {
            const { DeleteObjectCommand } = require("@aws-sdk/client-s3");
            await s3.send(new DeleteObjectCommand({ Bucket: config.r2.bucketName, Key: key }));
            return;
        }
        await redisConnection.del(redisKey(key));
    } catch {
        // best-effort
    }
}

// ── Key builders (single source of truth for artifact key shapes) ────────────

export function sanitizeFileId(fileId: string): string {
    return fileId.replace(/[/\\]/g, "-").replace(/[^a-zA-Z0-9.\-_]/g, "_");
}

export const artifactKeys = {
    fileGraph: (owner: string, repo: string, sha: string) =>
        `graphs/${owner}/${repo}/${sha}/filegraph.json.gz`,
    functions: (owner: string, repo: string, sha: string, fileId: string) =>
        `functions/${owner}/${repo}/${sha}/${sanitizeFileId(fileId)}.json.gz`,
};

/** Redis pointer so routes can resolve "latest analyzed sha" for a repo. */
export async function setLatestSha(owner: string, repo: string, sha: string): Promise<void> {
    await redisConnection.set(`latest-sha:${owner}:${repo}`, sha);
}

export async function getLatestSha(owner: string, repo: string): Promise<string | null> {
    return redisConnection.get(`latest-sha:${owner}:${repo}`);
}
