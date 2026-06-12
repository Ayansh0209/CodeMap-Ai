// src/parser/treesitter/engine.ts
// ─────────────────────────────────────────────────────────────────────────────
// web-tree-sitter (WASM) loader — no native compilation, deploys anywhere.
//
// Grammars come prebuilt from the `tree-sitter-wasms` npm package:
//   node_modules/tree-sitter-wasms/out/tree-sitter-<lang>.wasm
//
// Parsers are created lazily (first file of that language) and cached for the
// process lifetime. Trees MUST be deleted after use — WASM memory is not GC'd.
// ─────────────────────────────────────────────────────────────────────────────

import path from "path";
import fs from "fs";

// web-tree-sitter v0.25+: { Parser, Language }, older: default export.
// Required lazily so the JS/TS-only path never pays the WASM init cost.
let ParserCtor: any = null;
let LanguageNS: any = null;
let initPromise: Promise<void> | null = null;

const languageCache = new Map<string, any>();   // wasmName → Language
const parserCache = new Map<string, any>();     // wasmName → Parser

async function ensureInit(): Promise<void> {
    if (!initPromise) {
        initPromise = (async () => {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const wts = require("web-tree-sitter");
            ParserCtor = wts.Parser ?? wts.default ?? wts;
            LanguageNS = wts.Language ?? ParserCtor.Language;
            await ParserCtor.init();
        })();
    }
    return initPromise;
}

function wasmPathFor(wasmName: string): string {
    // resolve from the tree-sitter-wasms package — works regardless of cwd
    const candidates = [
        `tree-sitter-wasms/out/tree-sitter-${wasmName}.wasm`,
    ];
    for (const c of candidates) {
        try {
            return require.resolve(c);
        } catch {
            /* try next */
        }
    }
    // last resort: walk from this file up to node_modules
    const local = path.join(
        __dirname, "..", "..", "..", "node_modules",
        "tree-sitter-wasms", "out", `tree-sitter-${wasmName}.wasm`
    );
    if (fs.existsSync(local)) return local;
    throw new Error(`[treesitter] wasm grammar not found: ${wasmName}`);
}

export async function getParser(wasmName: string): Promise<any> {
    await ensureInit();

    let parser = parserCache.get(wasmName);
    if (parser) return parser;

    let language = languageCache.get(wasmName);
    if (!language) {
        language = await LanguageNS.load(wasmPathFor(wasmName));
        languageCache.set(wasmName, language);
    }

    parser = new ParserCtor();
    parser.setLanguage(language);
    parserCache.set(wasmName, parser);
    return parser;
}

/**
 * Parse content with the grammar for `wasmName`.
 * Returns null on parse failure (caller adds a minimal FileNode, never crashes).
 * IMPORTANT: caller must call dispose() on the returned object.
 */
export async function parseContent(
    wasmName: string,
    content: string
): Promise<{ rootNode: any; dispose: () => void } | null> {
    try {
        const parser = await getParser(wasmName);
        const tree = parser.parse(content);
        if (!tree) return null;
        return {
            rootNode: tree.rootNode,
            dispose: () => {
                try { tree.delete(); } catch { /* already deleted */ }
            },
        };
    } catch (err) {
        console.warn(`[treesitter] parse failed (${wasmName}): ${(err as Error).message}`);
        return null;
    }
}
