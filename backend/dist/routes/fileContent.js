"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const ioredis_1 = __importDefault(require("ioredis"));
const config_1 = require("../config/config");
const router = (0, express_1.Router)();
const redis = new ioredis_1.default(config_1.config.redis.url, { maxRetriesPerRequest: 3 });
const FileContentSchema = zod_1.z.object({
    owner: zod_1.z.string().min(1),
    repo: zod_1.z.string().min(1),
    commitSha: zod_1.z.string().min(6),
    filePath: zod_1.z.string().min(1),
});
router.post("/", async (req, res) => {
    const parsed = FileContentSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
        return;
    }
    const { owner, repo, commitSha, filePath } = parsed.data;
    const cacheKey = `file-content:${owner}:${repo}:${commitSha}:${filePath}`;
    try {
        // Check Redis cache first
        const cached = await redis.get(cacheKey);
        if (cached !== null) {
            const lines = cached.split("\n").length;
            res.json({ content: cached, lines });
            return;
        }
        // Fetch from GitHub raw
        const url = `https://raw.githubusercontent.com/${owner}/${repo}/${commitSha}/${filePath}`;
        const headers = {};
        if (config_1.config.github.token) {
            headers["Authorization"] = `Bearer ${config_1.config.github.token}`;
        }
        const ghRes = await fetch(url, { headers });
        if (ghRes.status === 404) {
            res.json({ content: null, lines: 0 });
            return;
        }
        if (!ghRes.ok) {
            res.status(502).json({ error: `GitHub returned ${ghRes.status}` });
            return;
        }
        const content = await ghRes.text();
        const lines = content.split("\n").length;
        // Cache forever (commitSha is immutable)
        await redis.set(cacheKey, content).catch(() => { });
        res.json({ content, lines });
    }
    catch (err) {
        console.error("[fileContent] Error:", err);
        res.status(500).json({ error: "Failed to fetch file content" });
    }
});
exports.default = router;
