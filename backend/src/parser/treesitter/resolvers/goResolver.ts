// src/parser/treesitter/resolvers/goResolver.ts
// ─────────────────────────────────────────────────────────────────────────────
// Go import → file resolution.
//
// Go's model is fundamentally different from JS/Python:
//   - imports name PACKAGES (directories), never files
//   - the import path is <module-path-from-go.mod>/<dir-path>
//   - every .go file in the imported directory belongs to the package
//
// Edge cases handled:
//   1. go.mod module path prefix (github.com/user/repo/pkg/x → pkg/x dir)
//   2. multi-module repos (multiple go.mod files — longest module prefix wins)
//   3. package → MULTIPLE file targets (edge fan-out to all files in the dir,
//      excluding _test.go files to avoid test-pollution of the dep graph)
//   4. stdlib detection: first path segment without a dot → stdlib (external)
//   5. relative imports "./x" (legacy, pre-modules — still seen in the wild)
// ─────────────────────────────────────────────────────────────────────────────

import { RepoFileIndex } from "../fileIndex";
import { LangRawImport, LangResolvedImport, LangImportResolver } from "../types";

const MAX_PACKAGE_FANOUT = 30; // safety cap for giant packages

export class GoImportResolver implements LangImportResolver {
    private readonly index: RepoFileIndex;
    /** module paths sorted longest-first so nested modules win */
    private readonly modulePaths: string[];
    private readonly cache = new Map<string, LangResolvedImport>();

    constructor(index: RepoFileIndex) {
        this.index = index;
        this.modulePaths = [...index.goModules.keys()].sort((a, b) => b.length - a.length);
    }

    resolve(raw: LangRawImport, fromRelativePath: string): LangResolvedImport {
        const cached = this.cache.get(raw.specifier);
        if (cached) return cached;
        const result = this.resolveUncached(raw, fromRelativePath);
        this.cache.set(raw.specifier, result);
        return result;
    }

    private resolveUncached(raw: LangRawImport, fromRelativePath: string): LangResolvedImport {
        const spec = raw.specifier;

        // ── Relative import (legacy GOPATH style) ─────────────────────────────
        if (spec.startsWith("./") || spec.startsWith("../")) {
            const fromDir = fromRelativePath.includes("/")
                ? fromRelativePath.slice(0, fromRelativePath.lastIndexOf("/"))
                : "";
            const dir = this.normalizeJoin(fromDir, spec);
            const files = this.packageFiles(dir);
            if (files.length > 0) return { kind: "internal", targets: files };
            return { kind: "unresolved", specifier: spec };
        }

        // ── Module-path match (longest prefix wins for nested modules) ────────
        for (const mod of this.modulePaths) {
            if (spec === mod || spec.startsWith(mod + "/")) {
                const modDir = this.index.goModules.get(mod)!;
                const sub = spec === mod ? "" : spec.slice(mod.length + 1);
                const dir = modDir ? (sub ? `${modDir}/${sub}` : modDir) : sub;
                const files = this.packageFiles(dir);
                if (files.length > 0) return { kind: "internal", targets: files };
                return { kind: "unresolved", specifier: spec };
            }
        }

        // ── No go.mod at all (rare): try the import path as a repo dir ────────
        if (this.modulePaths.length === 0) {
            // try suffix-matching the import path against repo dirs:
            // import "anything/foo/bar" → dir ".../foo/bar" if it has .go files
            const segments = spec.split("/");
            for (let i = 0; i < segments.length - 1; i++) {
                const candidate = segments.slice(i).join("/");
                const files = this.packageFiles(candidate);
                if (files.length > 0) return { kind: "internal", targets: files };
            }
        }

        // ── External ──────────────────────────────────────────────────────────
        // stdlib: first segment has no dot ("fmt", "net/http", "encoding/json")
        const first = spec.split("/")[0];
        if (!first.includes(".")) return { kind: "external", packageName: spec };

        // third-party module: report as host/org/repo
        return { kind: "external", packageName: spec.split("/").slice(0, 3).join("/") };
    }

    /** all non-test .go files directly in dir */
    private packageFiles(dir: string): string[] {
        const files = this.index
            .filesInDir(dir, [".go"])
            .filter((f) => !f.endsWith("_test.go"));
        return files.slice(0, MAX_PACKAGE_FANOUT);
    }

    private normalizeJoin(baseDir: string, rel: string): string {
        const parts = (baseDir ? baseDir.split("/") : []);
        for (const seg of rel.split("/")) {
            if (seg === "." || seg === "") continue;
            if (seg === "..") parts.pop();
            else parts.push(seg);
        }
        return parts.join("/");
    }
}
