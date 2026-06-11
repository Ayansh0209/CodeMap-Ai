// src/routes/functions.ts
// ─────────────────────────────────────────────────────────────────────────────
// Returns parsed function metadata for a given file in a repo.
//
//   - Look up function data: artifact store first (R2 / gzipped Redis),
//     then the legacy raw Redis key for repos analyzed before the migration
//   - If the requested file is a barrel (re-export only), redirect the lookup
//     to its barrelTargets using the RetrievalIndex, and merge results
//
// GRACEFUL DEGRADATION:
//   - RetrievalIndex missing (old repo) → fall back to direct lookup only
//   - barrelTargets not in cache → return empty list (same as before)
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import { redisConnection } from "../queue/jobQueue";
import { getArtifact, artifactKeys } from "../storage/artifactStore";
import type { RetrievalIndex } from "../models/retrieval";

const router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Legacy Redis cache key for function data (pre-artifact-store analyses).
 */
function functionsCacheKey(owner: string, repo: string, commitSha: string, fileId: string): string {
    const sanitized = fileId.replace(/[/\\]/g, "-").replace(/[^a-zA-Z0-9.\-_]/g, "_");
    return `functions:${owner}:${repo}:${commitSha}:${sanitized}`;
}

/**
 * Fetch one file's function payload.
 * 1. Artifact store (R2 or gzipped Redis) — where new analyses write
 * 2. Legacy raw Redis key — repos analyzed before the storage migration
 */
async function loadFunctionPayload(
    owner: string,
    repo: string,
    commitSha: string,
    fileId: string,
): Promise<any | null> {
    const fromStore = await getArtifact(artifactKeys.functions(owner, repo, commitSha, fileId));
    if (fromStore) return fromStore;

    try {
        const legacy = await redisConnection.get(functionsCacheKey(owner, repo, commitSha, fileId));
        if (legacy) return JSON.parse(legacy);
    } catch {
        // fall through
    }
    return null;
}

/**
 * Load the RetrievalIndex for a repo from Redis.
 * All failures return null — caller falls back to direct lookup.
 */
async function loadRetrievalIndex(owner: string, repo: string): Promise<RetrievalIndex | null> {
    try {
        const raw = await redisConnection.get(`retrieval:${owner}:${repo}`);
        if (!raw) return null;
        return JSON.parse(raw) as RetrievalIndex;
    } catch {
        return null;
    }
}

/**
 * Fetch and merge function data from multiple files (barrel expansion).
 */
async function fetchMergedFunctions(
    targets: string[],
    owner: string,
    repo: string,
    commitSha: string,
): Promise<any[]> {
    const merged: any[] = [];

    for (const target of targets.slice(0, 10)) { // cap at 10 targets to avoid explosion
        try {
            const data = await loadFunctionPayload(owner, repo, commitSha, target);
            if (!data) continue;

            // data may be an array of functions or an object with a functions field
            const functions = Array.isArray(data) ? data : (data.functions ?? data.nodes ?? []);

            // Tag each function with its source file for the frontend
            for (const fn of functions) {
                merged.push({ ...fn, _sourceFile: target });
            }
        } catch {
            // Cache miss or parse error for this target — skip it
        }
    }

    return merged;
}

// ── Route: POST /functions ────────────────────────────────────────────────────

router.post("/", async (req, res) => {
    try {
        const { owner, repo, commitSha, fileId } = req.body as {
            owner?: string;
            repo?: string;
            commitSha?: string;
            fileId?: string;
        };

        if (!owner || !repo || !commitSha || !fileId) {
            return res.status(400).json({ error: "missing parameters" });
        }

        // ── Step 1: Try direct lookup (artifact store, then legacy Redis) ─────
        // Most files are NOT barrels, so this is the common path.
        const direct = await loadFunctionPayload(owner, repo, commitSha, fileId);

        if (direct) {
            console.log(`[functions] hit: ${fileId}`);
            return res.json(direct);
        }

        // ── Step 2: Miss — check if this is a barrel file ──────────────────────
        const retrieval = await loadRetrievalIndex(owner, repo);

        if (!retrieval) {
            console.log(`[functions] miss, no retrieval index: ${fileId}`);
            return res.status(404).json({ error: "not found" });
        }

        const fileEntry = retrieval.files.find(f => f.fileId === fileId);

        if (!fileEntry) {
            console.log(`[functions] file not in retrieval index: ${fileId}`);
            return res.status(404).json({ error: "not found" });
        }

        if (!fileEntry.isBarrel || fileEntry.barrelTargets.length === 0) {
            // Not a barrel — just a miss for a real file (e.g. it has no functions)
            console.log(`[functions] miss (non-barrel, no functions): ${fileId}`);
            return res.json({ functions: [], fileId, source: "cache-miss" });
        }

        // ── Step 3: Barrel expansion ──────────────────────────────────────────
        console.log(
            `[functions] barrel detected: ${fileId} → ` +
            `[${fileEntry.barrelTargets.slice(0, 3).join(", ")}` +
            `${fileEntry.barrelTargets.length > 3 ? `, +${fileEntry.barrelTargets.length - 3} more` : ""}]`
        );

        const merged = await fetchMergedFunctions(
            fileEntry.barrelTargets,
            owner,
            repo,
            commitSha,
        );

        if (merged.length === 0) {
            console.log(`[functions] barrel targets have no cached functions: ${fileId}`);
            return res.json({ functions: [], fileId, isBarrel: true, barrelTargets: fileEntry.barrelTargets });
        }

        return res.json({
            functions:     merged,
            fileId,
            isBarrel:      true,
            barrelTargets: fileEntry.barrelTargets,
        });
    } catch (err) {
        console.error("[functionsRoute] error:", err);
        return res.status(500).json({ error: "Server error" });
    }
});

export default router;
