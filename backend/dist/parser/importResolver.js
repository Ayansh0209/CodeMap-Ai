"use strict";
// src/parser/importResolver.ts
// ─────────────────────────────────────────────────────────────────────────────
// Resolves raw import specifiers to typed results.
//
// Resolution order for every specifier:
//   1. Relative paths (./foo, ../bar) → disk lookup from fromFile directory
//   2. Node.js builtins (fs, path, node:*)  → always external
//   3. AliasResolver (tsconfig/jsconfig/package.json/workspace/fallback) → internal or external
//   4. Anything else → external (npm package)
//
// The AliasResolver owns the alias cache, so repeated imports in a chunk are O(1).
// ─────────────────────────────────────────────────────────────────────────────
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ImportResolver = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const aliasResolver_1 = require("./aliasResolver");
// ── File-system extension resolution ─────────────────────────────────────────
const EXTENSIONS_TO_TRY = [
    "",
    ".ts", ".tsx",
    ".js", ".jsx",
    ".mjs", ".cjs",
    "/index.ts", "/index.tsx",
    "/index.js", "/index.jsx",
];
function tryResolveOnDisk(candidate) {
    for (const ext of EXTENSIONS_TO_TRY) {
        if (fs_1.default.existsSync(candidate + ext))
            return candidate + ext;
    }
    return null;
}
// ── ImportResolver class ──────────────────────────────────────────────────────
class ImportResolver {
    constructor(repoRoot) {
        this.repoRoot = repoRoot;
        // AliasResolver loads all configs (tsconfig/jsconfig/package.json) once
        // and caches every resolution — safe to construct once per repo
        this.alias = new aliasResolver_1.AliasResolver(repoRoot);
    }
    /**
     * Resolve a single import specifier to its kind + path/name.
     *
     * @param specifier   Raw import string as written in source ("./utils", "@/redux/slice")
     * @param fromAbsFile Absolute disk path of the file containing the import
     */
    resolve(specifier, fromAbsFile) {
        // ── 1. Relative path ─────────────────────────────────────────────────
        if (specifier.startsWith(".") || specifier.startsWith("/")) {
            return this.resolveRelative(specifier, fromAbsFile);
        }
        // ── 2. Node.js built-in ──────────────────────────────────────────────
        if ((0, aliasResolver_1.isNodeBuiltin)(specifier)) {
            const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
            return { kind: "external", packageName: bare };
        }
        // ── 3. Alias / internal package resolution (cached) ──────────────────
        const aliasResult = this.alias.resolve(specifier, fromAbsFile);
        if (aliasResult) {
            if (aliasResult.kind === "internal")
                return aliasResult;
            if (aliasResult.kind === "external")
                return aliasResult;
            if (aliasResult.kind === "unresolved")
                return { kind: "unresolved", specifier };
        }
        // ── 4. Everything else is an external npm package ────────────────────
        const packageName = specifier.startsWith("@")
            ? specifier.split("/").slice(0, 2).join("/") // @scope/package
            : specifier.split("/")[0]; // package
        return { kind: "external", packageName };
    }
    // ── Relative import resolution ────────────────────────────────────────────
    resolveRelative(specifier, fromAbsFile) {
        const fromDir = path_1.default.dirname(fromAbsFile);
        const candidate = path_1.default.resolve(fromDir, specifier);
        const resolved = tryResolveOnDisk(candidate);
        if (!resolved) {
            // File missing on disk — could be generated, deleted, or outside repo.
            // Return unresolved so the caller can record it without creating phantom edges.
            return { kind: "unresolved", specifier };
        }
        // Normalise to repo-relative forward-slash path (used as graph node ID)
        const relativePath = path_1.default.relative(this.repoRoot, resolved).replace(/\\/g, "/");
        return { kind: "internal", resolvedPath: relativePath };
    }
}
exports.ImportResolver = ImportResolver;
