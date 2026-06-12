// src/parser/treesitter/resolvers/cppResolver.ts
// ─────────────────────────────────────────────────────────────────────────────
// C / C++ #include → file resolution (no compile_commands.json available —
// we replicate what compilers do with -I flags using repo-derived heuristics).
//
// Resolution order for #include "x/y.h" (quoted):
//   1. relative to the including file's directory   (compiler behavior)
//   2. relative to derived include roots             (-I guesses: repo root,
//      any dir literally named include/inc/headers/src, and any dir that
//      headers were previously resolved into)
//   3. unique segment-aligned suffix match across the whole repo
//      ("utils/helpers.h" → "lib/utils/helpers.h" if unambiguous;
//       if ambiguous, prefer the candidate sharing the longest path prefix
//       with the includer — closest wins)
//
// #include <x> (angle): same internal search FIRST (many projects use angle
// includes for their own headers via -I), then → external/system.
//
// Also emits header↔source companion edges (foo.h ↔ foo.c/.cpp) so the call
// graph connects declarations to definitions even when the .c doesn't
// re-include its own header (rare but happens).
// ─────────────────────────────────────────────────────────────────────────────

import { RepoFileIndex } from "../fileIndex";
import { LangRawImport, LangResolvedImport, LangImportResolver } from "../types";

const INCLUDE_ROOT_NAMES = new Set(["include", "inc", "includes", "headers", "src", "lib", "source"]);

export class CppImportResolver implements LangImportResolver {
    private readonly index: RepoFileIndex;
    private readonly includeRoots: string[];
    private readonly cache = new Map<string, LangResolvedImport>();

    constructor(index: RepoFileIndex) {
        this.index = index;
        this.includeRoots = this.deriveIncludeRoots();
        if (this.includeRoots.length > 0) {
            console.log(`[cppResolver] include roots: ${this.includeRoots.map(r => r || "(root)").join(", ")}`);
        }
    }

    /** every directory in the repo named like an include root, plus repo root */
    private deriveIncludeRoots(): string[] {
        const roots = new Set<string>([""]);
        for (const dir of this.index.filesByDir.keys()) {
            const segments = dir.split("/");
            for (let i = 0; i < segments.length; i++) {
                if (INCLUDE_ROOT_NAMES.has(segments[i].toLowerCase())) {
                    roots.add(segments.slice(0, i + 1).join("/"));
                }
            }
        }
        // shallow roots first
        return [...roots].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
    }

    resolve(raw: LangRawImport, fromRelativePath: string): LangResolvedImport {
        const cacheKey = `${fromRelativePath}|${raw.specifier}`;
        const cached = this.cache.get(cacheKey);
        if (cached) return cached;
        const result = this.resolveUncached(raw, fromRelativePath);
        this.cache.set(cacheKey, result);
        return result;
    }

    private resolveUncached(raw: LangRawImport, fromRelativePath: string): LangResolvedImport {
        const spec = raw.specifier.replace(/\\/g, "/");
        const fromDir = fromRelativePath.includes("/")
            ? fromRelativePath.slice(0, fromRelativePath.lastIndexOf("/"))
            : "";

        // 1. relative to includer (handles "./x.h", "../inc/x.h", "x.h")
        const relative = this.normalizeJoin(fromDir, spec);
        if (this.index.has(relative)) {
            return { kind: "internal", targets: [relative] };
        }

        // 2. include roots
        for (const root of this.includeRoots) {
            const candidate = root ? this.normalizeJoin(root, spec) : this.normalizeJoin("", spec);
            if (this.index.has(candidate)) {
                return { kind: "internal", targets: [candidate] };
            }
        }

        // 3. suffix match
        const matches = this.index.findBySuffix(spec);
        if (matches.length === 1) {
            return { kind: "internal", targets: [matches[0]] };
        }
        if (matches.length > 1) {
            // ambiguous — prefer candidate sharing the longest path prefix with includer
            const best = matches
                .map((m) => ({ m, score: this.sharedPrefixLength(m, fromRelativePath) }))
                .sort((a, b) => b.score - a.score)[0];
            return { kind: "internal", targets: [best.m] };
        }

        // not in repo → external (system / third-party lib)
        const libName = spec.split("/")[0].replace(/\.(h|hpp|hh|hxx)$/i, "");
        return { kind: "external", packageName: libName };
    }

    /** companion header/source pairing: foo.c ↔ foo.h (same dir, or src↔include swap) */
    companionFor(relativePath: string): string | null {
        const m = relativePath.match(/^(.*)\.(c|cc|cpp|cxx)$/i);
        if (!m) return null;
        const stem = m[1];

        for (const ext of [".h", ".hpp", ".hh", ".hxx"]) {
            // same directory
            if (this.index.has(stem + ext)) return stem + ext;
            // src/ ↔ include/ swap: src/foo.c → include/foo.h
            const swapped = stem.replace(/(^|\/)(src|source)\//, "$1include/");
            if (swapped !== stem && this.index.has(swapped + ext)) return swapped + ext;
        }

        // suffix match on basename: unique foo.h anywhere
        const base = stem.slice(stem.lastIndexOf("/") + 1);
        for (const ext of [".h", ".hpp", ".hh", ".hxx"]) {
            const candidates = this.index.findBySuffix(base + ext);
            if (candidates.length === 1) return candidates[0];
        }
        return null;
    }

    private sharedPrefixLength(a: string, b: string): number {
        const as = a.split("/");
        const bs = b.split("/");
        let i = 0;
        while (i < as.length && i < bs.length && as[i] === bs[i]) i++;
        return i;
    }

    private normalizeJoin(baseDir: string, rel: string): string {
        const parts = baseDir ? baseDir.split("/") : [];
        for (const seg of rel.split("/")) {
            if (seg === "." || seg === "") continue;
            if (seg === "..") parts.pop();
            else parts.push(seg);
        }
        return parts.join("/");
    }
}
