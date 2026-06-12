// src/parser/treesitter/fileIndex.ts
// ─────────────────────────────────────────────────────────────────────────────
// RepoFileIndex — a one-pass index of every file path in the repo, built once
// per job BEFORE parsing starts. All language resolvers share it.
//
// Why: import resolution for Python/Go/C++ needs global knowledge:
//   - Python: where are the package roots? (src/ layout, __init__.py chains)
//   - Go:     which directory does the go.mod module path map to?
//   - C/C++:  which header matches "utils/helpers.h" by path suffix?
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";

export interface IndexedFile {
    relativePath: string;   // normalized with forward slashes
    absolutePath: string;
}

export class RepoFileIndex {
    readonly repoRoot: string;

    /** all repo-relative paths (forward slashes) */
    readonly allPaths = new Set<string>();

    /** dir (relative, "" = root) → files directly inside it */
    readonly filesByDir = new Map<string, string[]>();

    /** basename → all relative paths with that basename */
    readonly filesByBasename = new Map<string, string[]>();

    /** extension (with dot, lowercase) → count — used e.g. to decide C vs C++ for .h */
    readonly extensionCounts = new Map<string, number>();

    /** go.mod module path → directory containing it ("" = repo root) */
    readonly goModules = new Map<string, string>();

    constructor(repoRoot: string, files: IndexedFile[]) {
        this.repoRoot = repoRoot;

        for (const f of files) {
            const rel = f.relativePath.replace(/\\/g, "/");
            this.allPaths.add(rel);

            const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
            const inDir = this.filesByDir.get(dir) ?? [];
            inDir.push(rel);
            this.filesByDir.set(dir, inDir);

            const base = rel.slice(rel.lastIndexOf("/") + 1);
            const byBase = this.filesByBasename.get(base) ?? [];
            byBase.push(rel);
            this.filesByBasename.set(base, byBase);

            const ext = path.extname(rel).toLowerCase();
            this.extensionCounts.set(ext, (this.extensionCounts.get(ext) ?? 0) + 1);
        }

        this.loadGoModules();
    }

    has(rel: string): boolean {
        return this.allPaths.has(rel);
    }

    /** files directly in a directory, filtered by extension list */
    filesInDir(dir: string, extensions?: string[]): string[] {
        const files = this.filesByDir.get(dir) ?? [];
        if (!extensions) return files;
        return files.filter((f) => extensions.includes(path.extname(f).toLowerCase()));
    }

    /**
     * Find files whose path ends with the given suffix (segment-aligned).
     * "utils/helpers.h" matches "src/utils/helpers.h" but NOT "src/myutils/helpers.h".
     */
    findBySuffix(suffix: string): string[] {
        const normalized = suffix.replace(/\\/g, "/").replace(/^\.\//, "");
        const base = normalized.slice(normalized.lastIndexOf("/") + 1);
        const candidates = this.filesByBasename.get(base) ?? [];
        if (!normalized.includes("/")) return candidates;
        return candidates.filter(
            (c) => c === normalized || c.endsWith("/" + normalized)
        );
    }

    /** detect every go.mod in the repo (multi-module repos supported) */
    private loadGoModules(): void {
        for (const rel of this.allPaths) {
            // go.mod won't be in allPaths (not a parsed file) — scan disk instead
            break;
        }
        // Walk the repo for go.mod files (bounded: skip huge/vendored dirs)
        const skip = new Set(["node_modules", ".git", "vendor", "dist", "build", "__pycache__"]);
        const walk = (dir: string, depth: number) => {
            if (depth > 6) return;
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const e of entries) {
                if (e.isDirectory()) {
                    if (!skip.has(e.name)) walk(path.join(dir, e.name), depth + 1);
                } else if (e.name === "go.mod") {
                    try {
                        const content = fs.readFileSync(path.join(dir, e.name), "utf-8");
                        const m = content.match(/^module\s+(\S+)/m);
                        if (m) {
                            const relDir = path
                                .relative(this.repoRoot, dir)
                                .replace(/\\/g, "/");
                            this.goModules.set(m[1], relDir === "." ? "" : relDir);
                        }
                    } catch {
                        /* unreadable go.mod — ignore */
                    }
                }
            }
        };
        walk(this.repoRoot, 0);

        if (this.goModules.size > 0) {
            console.log(
                `[fileIndex] go modules: ${[...this.goModules.entries()]
                    .map(([m, d]) => `${m} → ${d || "(root)"}`)
                    .join(", ")}`
            );
        }
    }
}
