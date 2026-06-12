// src/parser/treesitter/resolvers/pythonResolver.ts
// ─────────────────────────────────────────────────────────────────────────────
// Python import → file resolution.
//
// Edge cases handled (the Python equivalents of your TS ".js→.ts" bug):
//   1. Relative imports:  from .utils import x / from ..pkg.mod import y
//   2. Regular packages:  import a.b.c → a/b/c.py OR a/b/c/__init__.py
//   3. src/ layout:       import mypkg resolves to src/mypkg/... — source
//                         roots are DERIVED (parents of top-level packages),
//                         not hardcoded.
//   4. Namespace pkgs:    PEP 420 — directories WITHOUT __init__.py still count
//   5. from X import Y:   Y may be a SUBMODULE (a/b.py) or a symbol in a/__init__.py
//                         — try submodule first, fall back to the package itself
//   6. import a.b.c as d: resolves a.b.c, alias irrelevant for the edge
//   7. stdlib detection:  known stdlib names → external, never "unresolved"
// ─────────────────────────────────────────────────────────────────────────────

import { RepoFileIndex } from "../fileIndex";
import { LangRawImport, LangResolvedImport, LangImportResolver } from "../types";

// Python 3 stdlib top-level modules (sys.stdlib_module_names, abridged to common ones)
const PY_STDLIB = new Set([
    "abc", "argparse", "array", "ast", "asyncio", "atexit", "base64", "bisect",
    "builtins", "calendar", "cmath", "codecs", "collections", "concurrent",
    "configparser", "contextlib", "contextvars", "copy", "copyreg", "csv",
    "ctypes", "dataclasses", "datetime", "decimal", "difflib", "dis", "email",
    "enum", "errno", "faulthandler", "fcntl", "filecmp", "fileinput", "fnmatch",
    "fractions", "functools", "gc", "getopt", "getpass", "gettext", "glob",
    "gzip", "hashlib", "heapq", "hmac", "html", "http", "imaplib", "importlib",
    "inspect", "io", "ipaddress", "itertools", "json", "keyword", "linecache",
    "locale", "logging", "lzma", "marshal", "math", "mimetypes", "mmap",
    "multiprocessing", "numbers", "operator", "os", "pathlib", "pickle",
    "pickletools", "pkgutil", "platform", "plistlib", "poplib", "posixpath",
    "pprint", "profile", "pstats", "pty", "pwd", "py_compile", "pyclbr",
    "pydoc", "queue", "quopri", "random", "re", "readline", "reprlib",
    "resource", "runpy", "sched", "secrets", "select", "selectors", "shelve",
    "shlex", "shutil", "signal", "site", "smtplib", "socket", "socketserver",
    "sqlite3", "ssl", "stat", "statistics", "string", "stringprep", "struct",
    "subprocess", "symtable", "sys", "sysconfig", "tarfile", "tempfile",
    "termios", "textwrap", "threading", "time", "timeit", "token", "tokenize",
    "tomllib", "trace", "traceback", "tracemalloc", "types", "typing",
    "unicodedata", "unittest", "urllib", "uuid", "venv", "warnings", "wave",
    "weakref", "webbrowser", "wsgiref", "xml", "xmlrpc", "zipapp", "zipfile",
    "zipimport", "zlib", "zoneinfo", "__future__",
]);

export class PythonImportResolver implements LangImportResolver {
    private readonly index: RepoFileIndex;
    /** derived source roots, e.g. ["", "src", "backend"] — tried in order */
    private readonly sourceRoots: string[];
    private readonly cache = new Map<string, LangResolvedImport>();

    constructor(index: RepoFileIndex) {
        this.index = index;
        this.sourceRoots = this.deriveSourceRoots();
        console.log(`[pythonResolver] source roots: ${this.sourceRoots.map(r => r || "(root)").join(", ")}`);
    }

    // ── Source root derivation ────────────────────────────────────────────────
    // A "source root" is any directory from which absolute imports make sense.
    // For each .py file, walk UP while the directory has an __init__.py — the
    // parent of the topmost package dir is a root. Files not inside a package
    // contribute their own directory. This naturally discovers src/ layouts,
    // backend/ subfolders, monorepo sub-projects, etc.
    private deriveSourceRoots(): string[] {
        const roots = new Set<string>([""]);

        for (const rel of this.index.allPaths) {
            if (!rel.endsWith(".py")) continue;

            let dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";

            // walk up while parent chain has __init__.py
            let top = dir;
            while (top) {
                const parent = top.includes("/") ? top.slice(0, top.lastIndexOf("/")) : "";
                if (this.index.has(top + "/__init__.py")) {
                    top = parent;
                } else {
                    break;
                }
            }
            // `top` is now the first dir WITHOUT __init__.py above the package chain
            roots.add(top);
        }

        // deterministic ordering: shallow roots first ("" before "src" before "a/b")
        return [...roots].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
    }

    // ── Module path → file ────────────────────────────────────────────────────
    /** try to resolve a dotted module path from a given root dir */
    private moduleToFile(rootDir: string, dotted: string): string | null {
        const slashPath = dotted.split(".").join("/");
        const prefix = rootDir ? rootDir + "/" : "";

        const asModule = prefix + slashPath + ".py";
        if (this.index.has(asModule)) return asModule;

        const asPackage = prefix + slashPath + "/__init__.py";
        if (this.index.has(asPackage)) return asPackage;

        // PEP 420 namespace package: directory exists with .py files but no __init__.py
        // → no single file to link; link to nothing here (children resolve individually)
        return null;
    }

    /** try all source roots in order */
    private resolveAbsolute(dotted: string): string | null {
        for (const root of this.sourceRoots) {
            const hit = this.moduleToFile(root, dotted);
            if (hit) return hit;
        }
        return null;
    }

    // ── Main entry ────────────────────────────────────────────────────────────
    resolve(raw: LangRawImport, fromRelativePath: string): LangResolvedImport {
        const cacheKey = `${fromRelativePath}|${raw.specifier}|${raw.meta?.relativeDots ?? 0}|${(raw.symbols ?? []).join(",")}`;
        const cached = this.cache.get(cacheKey);
        if (cached) return cached;

        const result = this.resolveUncached(raw, fromRelativePath);
        this.cache.set(cacheKey, result);
        return result;
    }

    private resolveUncached(raw: LangRawImport, fromRelativePath: string): LangResolvedImport {
        const dots = raw.meta?.relativeDots ?? 0;
        const fromDir = fromRelativePath.includes("/")
            ? fromRelativePath.slice(0, fromRelativePath.lastIndexOf("/"))
            : "";

        // ── Relative import: from .x import y / from ..a.b import c ──────────
        if (dots > 0) {
            // 1 dot = current package dir, each extra dot walks one level up
            let baseDir = fromDir;
            for (let i = 1; i < dots; i++) {
                baseDir = baseDir.includes("/") ? baseDir.slice(0, baseDir.lastIndexOf("/")) : "";
            }

            const targets: string[] = [];
            const dottedTail = raw.specifier; // may be "" for `from . import x`

            if (dottedTail) {
                const hit = this.relativeModuleToFile(baseDir, dottedTail);
                if (hit) {
                    // from .sub.mod import symbol — but symbols may also be submodules
                    const subHits = this.resolveFromSymbols(hit, baseDir, dottedTail, raw);
                    targets.push(...(subHits.length ? subHits : [hit]));
                }
            } else if (raw.meta?.isFromImport && raw.symbols.length > 0) {
                // from . import sibling_module, other_thing
                for (const sym of raw.symbols) {
                    const symName = sym.replace(/^\*\s*as\s*/, "").split(" as ")[0].trim();
                    const hit = this.relativeModuleToFile(baseDir, symName);
                    if (hit) targets.push(hit);
                }
                // none of the symbols were modules → they're symbols in the package __init__
                if (targets.length === 0) {
                    const initFile = (baseDir ? baseDir + "/" : "") + "__init__.py";
                    if (this.index.has(initFile)) targets.push(initFile);
                }
            }

            if (targets.length > 0) return { kind: "internal", targets: [...new Set(targets)] };
            return { kind: "unresolved", specifier: ".".repeat(dots) + raw.specifier };
        }

        // ── Absolute import ───────────────────────────────────────────────────
        const dotted = raw.specifier;
        if (!dotted) return { kind: "unresolved", specifier: "" };

        const topLevel = dotted.split(".")[0];

        const direct = this.resolveAbsolute(dotted);
        if (direct) {
            const subHits = raw.meta?.isFromImport
                ? this.resolveAbsoluteFromSymbols(dotted, raw)
                : [];
            return { kind: "internal", targets: [...new Set(subHits.length ? subHits : [direct])] };
        }

        // from a.b import c where a.b is a namespace package (no __init__.py):
        // try resolving each symbol as a submodule a/b/c.py
        if (raw.meta?.isFromImport && raw.symbols.length > 0) {
            const subHits = this.resolveAbsoluteFromSymbols(dotted, raw);
            if (subHits.length > 0) return { kind: "internal", targets: [...new Set(subHits)] };
        }

        // walk up the dotted path: import a.b.c where only a/b.py exists
        // (c is an attribute, not a module)
        const parts = dotted.split(".");
        for (let i = parts.length - 1; i >= 1; i--) {
            const parent = parts.slice(0, i).join(".");
            const hit = this.resolveAbsolute(parent);
            if (hit) return { kind: "internal", targets: [hit] };
        }

        // ── External ──────────────────────────────────────────────────────────
        if (PY_STDLIB.has(topLevel)) return { kind: "external", packageName: topLevel };

        // any internal file under a dir named like the top-level module? if not → 3rd party
        return { kind: "external", packageName: topLevel };
    }

    /** resolve dotted path relative to a base directory */
    private relativeModuleToFile(baseDir: string, dotted: string): string | null {
        const slashPath = dotted.split(".").join("/");
        const prefix = baseDir ? baseDir + "/" : "";

        const asModule = prefix + slashPath + ".py";
        if (this.index.has(asModule)) return asModule;

        const asPackage = prefix + slashPath + "/__init__.py";
        if (this.index.has(asPackage)) return asPackage;

        return null;
    }

    /** from .pkg import a, b — a/b may be submodules of pkg */
    private resolveFromSymbols(
        pkgHit: string,
        baseDir: string,
        dottedTail: string,
        raw: LangRawImport
    ): string[] {
        if (!raw.meta?.isFromImport || !pkgHit.endsWith("__init__.py")) return [];
        const hits: string[] = [];
        for (const sym of raw.symbols) {
            const symName = sym.split(" as ")[0].trim();
            if (symName === "*") continue;
            const hit = this.relativeModuleToFile(baseDir, dottedTail + "." + symName);
            if (hit) hits.push(hit);
        }
        // keep the package __init__ too — symbols not found as submodules live there
        if (hits.length > 0 && hits.length < raw.symbols.length) hits.push(pkgHit);
        return hits;
    }

    /** from a.b import c — c may be module a/b/c.py */
    private resolveAbsoluteFromSymbols(dotted: string, raw: LangRawImport): string[] {
        const hits: string[] = [];
        for (const sym of raw.symbols) {
            const symName = sym.split(" as ")[0].trim();
            if (symName === "*") continue;
            const hit = this.resolveAbsolute(dotted + "." + symName);
            if (hit) hits.push(hit);
        }
        if (hits.length > 0 && hits.length < raw.symbols.length) {
            const pkgItself = this.resolveAbsolute(dotted);
            if (pkgItself) hits.push(pkgItself);
        }
        return hits;
    }
}
