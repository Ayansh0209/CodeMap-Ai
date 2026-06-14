// backend/src/routes/graph.ts
// ─────────────────────────────────────────────────────────────────────────────
// Serves the analyzed file graph as gzipped JSON.
//
// GET /graph/:owner/:repo[?sha=<commitSha>]
//
// The bytes come straight from the artifact store (R2 or Redis fallback)
// WITHOUT decompressing on the server — we just set Content-Encoding: gzip
// and let the browser inflate it. A 30MB graph travels as ~3MB.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import {
    getArtifactGzip,
    artifactKeys,
    getLatestSha,
} from "../storage/artifactStore";

const router = Router();

const nameSchema = z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/);
const shaSchema = z.string().regex(/^[a-f0-9]{7,40}$/i).optional();

router.get("/:owner/:repo", async (req: Request, res: Response, next: NextFunction) => {
    try {
        const owner = nameSchema.parse(req.params.owner);
        const repo = nameSchema.parse(req.params.repo);
        const shaParam = shaSchema.parse(req.query.sha as string | undefined);

        const sha = shaParam ?? (await getLatestSha(owner, repo));
        if (!sha) {
            return res.status(404).json({ error: "Repository not analyzed yet" });
        }

        const gz = await getArtifactGzip(artifactKeys.fileGraph(owner, repo, sha));
        if (!gz) {
            return res.status(404).json({ error: "Graph artifact not found (may have expired — re-analyze)" });
        }

        res.setHeader("Content-Type", "application/json");
        res.setHeader("Content-Encoding", "gzip");
        // SHA-addressed content is immutable — let the browser cache it hard
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        res.setHeader("X-Commit-Sha", sha);
        return res.send(gz);
    } catch (err) {
        if (err instanceof z.ZodError) {
            return res.status(400).json({ error: "Invalid parameters" });
        }
        next(err);
    }
});

export default router;
