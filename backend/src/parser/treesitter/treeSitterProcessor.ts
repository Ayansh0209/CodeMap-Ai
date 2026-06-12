// src/parser/treesitter/treeSitterProcessor.ts
// ─────────────────────────────────────────────────────────────────────────────
// Processes all non-JS/TS files through tree-sitter and emits EXACTLY the same
// shapes as the ts-morph pipeline (FileNode / ImportEdge / FunctionNode), so
// the builder, search index, issue mapper, AI chat and frontend work unchanged.
//
// Memory discipline mirrors chunkProcessor.ts: small chunks, trees freed
// immediately after extraction, pause between chunks for GC.
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";
import { ParseDecision } from "../../processing/sizeHandler";
import { FileNode, ImportEdge, FunctionNode } from "../../models/graph";
import { RepoFileIndex } from "./fileIndex";
import { LanguageRegistry } from "./registry";
import { parseContent } from "./engine";

const CHUNK_PAUSE_MS = 50;
const DEFAULT_CHUNK_SIZE = 40; // tree-sitter is far lighter than ts-morph

export interface TreeSitterResult {
    fileNodes: FileNode[];
    importEdges: ImportEdge[];
    allFunctions: FunctionNode[];
    startupSignals: Map<string, boolean>;
    routeHandlers: Map<string, boolean>;
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

function chunkArray<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

export async function processTreeSitterFiles(
    decisions: ParseDecision[],
    repoRoot: string,
    fileIndex: RepoFileIndex,
    registry: LanguageRegistry,
    onProgress?: (processed: number, total: number) => void,
    chunkSize: number = DEFAULT_CHUNK_SIZE
): Promise<TreeSitterResult> {
    const fileNodes: FileNode[] = [];
    const importEdges: ImportEdge[] = [];
    const allFunctions: FunctionNode[] = [];
    const startupSignals = new Map<string, boolean>();
    const routeHandlers = new Map<string, boolean>();

    const parseable = decisions.filter((d) => d.mode !== "skip");
    const skipped = decisions.filter((d) => d.mode === "skip");
    const chunks = chunkArray(parseable, chunkSize);

    console.log(
        `[treeSitterProcessor] ${parseable.length} files in ${chunks.length} chunks`
    );

    let processed = 0;

    for (let ci = 0; ci < chunks.length; ci++) {
        for (const decision of chunks[ci]) {
            const rel = decision.relativePath.replace(/\\/g, "/");
            const adapter = registry.adapterFor(rel);

            if (!adapter) {
                fileNodes.push(minimalNode(decision, rel));
                continue;
            }

            try {
                const content = fs.readFileSync(decision.absolutePath, "utf-8");
                const parsed = await parseContent(adapter.wasmName, content);

                if (!parsed) {
                    fileNodes.push(minimalNode(decision, rel, adapter.languageId));
                    continue;
                }

                let extracted;
                try {
                    extracted = adapter.extract(parsed.rootNode, content, rel);
                } finally {
                    parsed.dispose(); // ALWAYS free WASM tree memory
                }

                // imports-only mode: keep edges, drop function bodies
                const functions = decision.mode === "full" ? extracted.functions : [];

                // ── Resolve imports ────────────────────────────────────────────
                const resolver = registry.resolverFor(adapter.languageId);
                const externalImports: string[] = [];
                const unresolvedImports: string[] = [];

                for (const raw of extracted.rawImports) {
                    if (!resolver) {
                        unresolvedImports.push(raw.specifier);
                        continue;
                    }
                    const resolved = resolver.resolve(raw, rel);
                    if (resolved.kind === "internal") {
                        for (const target of resolved.targets) {
                            if (target === rel) continue; // self-include guard
                            importEdges.push({
                                source: rel,
                                target,
                                kind: raw.kind,
                                symbols: raw.symbols,
                                isTypeOnly: false,
                            });
                        }
                    } else if (resolved.kind === "external") {
                        externalImports.push(resolved.packageName);
                    } else {
                        unresolvedImports.push(resolved.specifier);
                    }
                }

                // ── C/C++ companion edge: foo.c → foo.h ────────────────────────
                if (
                    (adapter.languageId === "c" || adapter.languageId === "cpp") &&
                    registry.cppResolver
                ) {
                    const companion = registry.cppResolver.companionFor(rel);
                    if (
                        companion &&
                        companion !== rel &&
                        !importEdges.some((e) => e.source === rel && e.target === companion)
                    ) {
                        importEdges.push({
                            source: rel,
                            target: companion,
                            kind: "static",
                            symbols: [],
                            isTypeOnly: false,
                        });
                    }
                }

                const kind = adapter.detectFileKind(rel);

                allFunctions.push(...functions);
                startupSignals.set(rel, extracted.hasStartupSignals);
                routeHandlers.set(rel, false);

                fileNodes.push({
                    id: rel,
                    label: path.basename(rel),
                    language: adapter.languageId,
                    path: rel,
                    sizeBytes: decision.sizeBytes,
                    lineCount: content.split("\n").length,
                    parseStatus: decision.mode === "skip" ? "skipped" : decision.mode,
                    kind,
                    isEntryPoint: false,
                    functions,
                    structures: extracted.structures,
                    externalImports: [...new Set(externalImports)],
                    unresolvedImports,
                    testSuites: extracted.testSuites,
                    testCases: extracted.testCases,
                });
            } catch (err) {
                console.warn(
                    `[treeSitterProcessor] error in ${rel}: ${(err as Error).message}`
                );
                fileNodes.push(minimalNode(decision, rel, adapter.languageId));
            }
        }

        processed += chunks[ci].length;
        onProgress?.(processed, parseable.length);

        if (ci < chunks.length - 1) await sleep(CHUNK_PAUSE_MS);
    }

    // skipped files still appear in the graph
    for (const decision of skipped) {
        const rel = decision.relativePath.replace(/\\/g, "/");
        fileNodes.push(minimalNode(decision, rel));
    }

    console.log(
        `[treeSitterProcessor] done — ${fileNodes.length} files, ` +
        `${importEdges.length} import edges, ${allFunctions.length} functions`
    );

    return { fileNodes, importEdges, allFunctions, startupSignals, routeHandlers };
}

function minimalNode(
    decision: ParseDecision,
    rel: string,
    language: FileNode["language"] = "unknown"
): FileNode {
    return {
        id: rel,
        label: path.basename(rel),
        language,
        path: rel,
        sizeBytes: decision.sizeBytes,
        lineCount: 0,
        parseStatus: "skipped",
        kind: "unknown",
        isEntryPoint: false,
        functions: [],
        externalImports: [],
        unresolvedImports: [],
    };
}
