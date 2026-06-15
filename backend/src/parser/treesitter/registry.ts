// src/parser/treesitter/registry.ts
// ─────────────────────────────────────────────────────────────────────────────
// LanguageRegistry — extension → adapter + resolver wiring, per repo.
//
// Built once per job AFTER the file list is known, because some decisions are
// repo-dependent:
//   - .h files: parsed with the C grammar in a pure-C repo, C++ otherwise
//     (the ".ts imported as .js" class of bug, avoided by design)
// ─────────────────────────────────────────────────────────────────────────────

import path from "path";
import { RepoFileIndex } from "./fileIndex";
import { LanguageAdapter, LangImportResolver } from "./types";
import { PythonAdapter } from "./adapters/pythonAdapter";
import { GoAdapter } from "./adapters/goAdapter";
import { CAdapter, CppAdapter, HeaderAdapter } from "./adapters/cFamilyAdapter";
import { PythonImportResolver } from "./resolvers/pythonResolver";
import { GoImportResolver } from "./resolvers/goResolver";
import { CppImportResolver } from "./resolvers/cppResolver";

/** every extension the tree-sitter layer can handle */
export const TREE_SITTER_EXTENSIONS = new Set([
    ".py",
    ".go",
    ".c", ".cpp", ".cc", ".cxx", ".c++",
    ".h", ".hpp", ".hh", ".hxx",
]);

export function isTreeSitterFile(relativePath: string): boolean {
    return TREE_SITTER_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

export class LanguageRegistry {
    private adapters = new Map<string, LanguageAdapter>();      // ext → adapter
    private resolvers = new Map<string, LangImportResolver>();  // languageId → resolver
    readonly cppResolver: CppImportResolver | null = null;      // exposed for companion edges

    constructor(index: RepoFileIndex) {
        const count = (exts: string[]) =>
            exts.reduce((sum, e) => sum + (index.extensionCounts.get(e) ?? 0), 0);

        const pyCount = count([".py"]);
        const goCount = count([".go"]);
        const cCount = count([".c"]);
        const cppCount = count([".cpp", ".cc", ".cxx", ".c++", ".hpp", ".hh", ".hxx"]);
        const headerCount = count([".h"]);

        // ── Python ────────────────────────────────────────────────────────────
        if (pyCount > 0) {
            const adapter = new PythonAdapter();
            for (const ext of adapter.extensions) this.adapters.set(ext, adapter);
            this.resolvers.set("python", new PythonImportResolver(index));
        }

        // ── Go ────────────────────────────────────────────────────────────────
        if (goCount > 0) {
            const adapter = new GoAdapter();
            for (const ext of adapter.extensions) this.adapters.set(ext, adapter);
            this.resolvers.set("go", new GoImportResolver(index));
        }

        // ── C / C++ ───────────────────────────────────────────────────────────
        if (cCount > 0 || cppCount > 0 || headerCount > 0) {
            const sharedResolver = new CppImportResolver(index);
            (this as any).cppResolver = sharedResolver;

            if (cCount > 0) {
                const c = new CAdapter();
                for (const ext of c.extensions) this.adapters.set(ext, c);
                this.resolvers.set("c", sharedResolver as any);
            }
            if (cppCount > 0) {
                const cpp = new CppAdapter();
                for (const ext of cpp.extensions) this.adapters.set(ext, cpp);
                this.resolvers.set("cpp", sharedResolver as any);
            }

            // .h grammar choice: pick the MAJORITY C-family language, not "any C++
            // present". A predominantly-C repo (e.g. curl, with a few C++ test/util
            // files) keeps its .h headers parsed and labeled as C; a C++-dominant
            // repo uses the C++ grammar. The C++ grammar is a near-superset, so the
            // worst case for a stray C++ header in a C repo is the ERROR-tolerant
            // fallback — far better than mislabeling every header as cpp.
            const headerMode: "c" | "cpp" = cppCount > cCount ? "cpp" : "c";
            const header = new HeaderAdapter(headerMode, [".h"]);
            this.adapters.set(".h", header);
            this.resolvers.set(headerMode, sharedResolver as any);

            // C++-only header extensions always go to C++ grammar
            const cppHeader = new HeaderAdapter("cpp", [".hpp", ".hh", ".hxx"]);
            for (const ext of cppHeader.extensions) this.adapters.set(ext, cppHeader);

            console.log(
                `[registry] C-family: ${cCount} .c, ${cppCount} c++ sources/headers, ` +
                `${headerCount} .h → .h parsed as ${headerMode.toUpperCase()}`
            );
        }
    }

    adapterFor(relativePath: string): LanguageAdapter | null {
        return this.adapters.get(path.extname(relativePath).toLowerCase()) ?? null;
    }

    resolverFor(languageId: string): LangImportResolver | null {
        return this.resolvers.get(languageId) ?? null;
    }

    get isEmpty(): boolean {
        return this.adapters.size === 0;
    }
}
