"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.downloadTarball = downloadTarball;
exports.extractTarball = extractTarball;
exports.walkFileTree = walkFileTree;
exports.cleanup = cleanup;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const promises_1 = require("stream/promises");
const stream_1 = require("stream");
const tar = __importStar(require("tar"));
const config_1 = require("../config/config");
const os_1 = __importDefault(require("os"));
const TMP_BASE = path_1.default.join(os_1.default.tmpdir(), "codemap");
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes max download time
// ── Helpers ─────────────────────────────────────────────
function getTarPath(jobId) {
    return path_1.default.join(TMP_BASE, `${jobId}.tar.gz`);
}
function getExtractPath(jobId) {
    return path_1.default.join(TMP_BASE, jobId);
}
function ensureDir(dirPath) {
    fs_1.default.mkdirSync(dirPath, { recursive: true });
}
// ── Download ─────────────────────────────────────────────
async function downloadTarball(owner, repo, branch, jobId) {
    const tarPath = getTarPath(jobId);
    ensureDir(TMP_BASE); // make sure /tmp/codemap exists
    const url = `https://api.github.com/repos/${owner}/${repo}/tarball/${branch}`;
    // abort controller gives us download timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => {
        controller.abort();
    }, DOWNLOAD_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            headers: {
                Authorization: `Bearer ${config_1.config.github.token}`,
                Accept: "application/vnd.github+json",
                "User-Agent": "codemap-ai",
            },
            signal: controller.signal,
        });
        if (!res.ok) {
            throw new Error(`GitHub tarball download failed: ${res.status} ${res.statusText}`);
        }
        if (!res.body) {
            throw new Error("No response body from GitHub");
        }
        // stream directly to disk - never loads into RAM
        // pipeline() handles backpressure automatically
        await (0, promises_1.pipeline)(stream_1.Readable.fromWeb(res.body), fs_1.default.createWriteStream(tarPath));
        return tarPath;
    }
    catch (err) {
        // clean up partial file if download failed
        if (fs_1.default.existsSync(tarPath)) {
            fs_1.default.unlinkSync(tarPath);
        }
        if (err.name === "AbortError") {
            throw new Error("Tarball download timed out after 5 minutes");
        }
        throw err;
    }
    finally {
        clearTimeout(timeout);
    }
}
// ── Extract ──────────────────────────────────────────────
async function extractTarball(jobId) {
    const tarPath = getTarPath(jobId);
    const extractPath = getExtractPath(jobId);
    // create extract directory
    ensureDir(extractPath);
    try {
        // strip: 1 removes the top level github folder
        // github tarballs have format: owner-repo-sha/...files
        // strip: 1 makes it just: ...files
        await tar.x({
            file: tarPath,
            cwd: extractPath,
            strip: 1,
        });
        // delete tar.gz immediately after extraction
        // no point keeping it, saves disk space
        fs_1.default.unlinkSync(tarPath);
        return extractPath;
    }
    catch (err) {
        // clean up on failure
        cleanup(jobId);
        throw new Error(`Failed to extract tarball: ${err.message}`);
    }
}
function walkFileTree(jobId) {
    const extractPath = getExtractPath(jobId);
    const results = [];
    function walk(currentDir) {
        let items;
        try {
            items = fs_1.default.readdirSync(currentDir);
        }
        catch {
            // skip unreadable directories silently
            return;
        }
        for (const item of items) {
            const fullPath = path_1.default.join(currentDir, item);
            let stat;
            try {
                stat = fs_1.default.statSync(fullPath);
            }
            catch {
                // skip broken symlinks or unreadable files
                continue;
            }
            // skip symlinks - can cause infinite loops
            if (stat.isSymbolicLink())
                continue;
            if (stat.isDirectory()) {
                walk(fullPath);
            }
            else if (stat.isFile()) {
                results.push({
                    absolutePath: fullPath,
                    // relative path from repo root - used as node ID in graph
                    relativePath: path_1.default.relative(extractPath, fullPath),
                    sizeBytes: stat.size,
                });
            }
        }
    }
    walk(extractPath);
    return results;
}
// ── Cleanup ──────────────────────────────────────────────
function cleanup(jobId) {
    const extractPath = getExtractPath(jobId);
    const tarPath = getTarPath(jobId);
    // remove extracted folder
    if (fs_1.default.existsSync(extractPath)) {
        fs_1.default.rmSync(extractPath, { recursive: true, force: true });
    }
    // remove tar if somehow still exists
    if (fs_1.default.existsSync(tarPath)) {
        fs_1.default.unlinkSync(tarPath);
    }
    console.log(`[cleanup] ${jobId} removed from disk`);
}
