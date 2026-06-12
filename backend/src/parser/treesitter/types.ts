// src/parser/treesitter/types.ts
// ─────────────────────────────────────────────────────────────────────────────
// Shared contracts for the tree-sitter multi-language layer.
//
// Design (mirrors the aider repo-map approach):
//   - One adapter per language: extracts functions, structures, raw imports
//     and raw call NAMES from the tree-sitter AST.
//   - One resolver per language: turns raw import specifiers into repo-relative
//     file paths. This is where ALL the per-language edge cases live.
//   - Everything emits the exact same FileNode / ImportEdge / FunctionNode
//     schema the JS/TS (ts-morph) pipeline emits — builder, search index,
//     issue mapper, AI chat and frontend need zero special-casing.
// ─────────────────────────────────────────────────────────────────────────────

import type { Node as TSNode, Tree } from "web-tree-sitter";
import { FunctionNode, StructureNode, Language, FileKind } from "../../models/graph";

/** Raw import as written in source — before resolution. */
export interface LangRawImport {
    /** raw specifier: "os.path", "github.com/x/y/pkg", "utils/helpers.h" */
    specifier: string;
    /** imported symbols if the syntax names them: from x import a, b → [a, b] */
    symbols: string[];
    kind: "static" | "dynamic" | "re-export";
    /** language-specific resolution hints */
    meta?: {
        /** Python: number of leading dots in a relative import (0 = absolute) */
        relativeDots?: number;
        /** C/C++: true for #include <...> (system style), false for "..." */
        isSystemInclude?: boolean;
        /** Python: true for `from X import ...` (symbols may be submodules) */
        isFromImport?: boolean;
    };
}

/** Everything an adapter extracts from one parsed file. */
export interface ExtractResult {
    functions: FunctionNode[];     // calls[] holds RAW NAMES — builder resolves to IDs
    structures: StructureNode[];
    rawImports: LangRawImport[];
    /** test suite/case names when the file looks like a test file */
    testSuites: string[];
    testCases: string[];
    /** entry point signals (main functions, __main__ guard, etc.) */
    hasStartupSignals: boolean;
}

/** One language adapter — pure AST → ExtractResult, no filesystem access. */
export interface LanguageAdapter {
    /** value stored on FileNode.language */
    languageId: Language;
    /** file extensions this adapter handles, lowercase with dot */
    extensions: string[];
    /** wasm grammar name inside tree-sitter-wasms, e.g. "python" → tree-sitter-python.wasm */
    wasmName: string;
    /** walk the AST and extract everything */
    extract(rootNode: TSNode, content: string, relativePath: string): ExtractResult;
    /** language-specific file kind detection (test files etc.) */
    detectFileKind(relativePath: string): FileKind;
}

/** Result of resolving one raw import. */
export type LangResolvedImport =
    | { kind: "internal"; targets: string[] }    // repo-relative file paths (Go: all files of a package)
    | { kind: "external"; packageName: string }  // stdlib / third-party
    | { kind: "unresolved"; specifier: string };

/** One language resolver — owns the per-language path index + edge cases. */
export interface LangImportResolver {
    resolve(raw: LangRawImport, fromRelativePath: string): LangResolvedImport;
}

/** Parsed tree wrapper so callers remember to free WASM memory. */
export interface ParsedTree {
    tree: Tree;
    dispose(): void;
}
