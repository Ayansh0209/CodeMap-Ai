// src/parser/chunkProcessor.ts
// Processes files in batches to keep RAM flat
// Each batch gets its own ts-morph Project instance — disposed after use
// This is the only file that touches ts-morph directly

import path from "path";
import fs from "fs";
import { Project, ScriptTarget, ModuleKind } from "ts-morph";
import { ParseDecision } from "../processing/sizeHandler";
import { FileNode, ImportEdge, FunctionNode, FileKind, StructureNode } from "../models/schema";
import { extractFileLevel } from "./fileLevel";
import { extractFunctionLevel, extractTestMetadata } from "./functionLevel";
import { ImportResolver } from "./importResolver";
import { config } from "../config/config";
import { isTreeSitterFile, LanguageRegistry } from "./treesitter/registry";
import { RepoFileIndex } from "./treesitter/fileIndex";
import { processTreeSitterFiles } from "./treesitter/treeSitterProcessor";

// Env-tunable (PARSE_CHUNK_SIZE). Default 20 — keeps peak RAM flat on small
// containers (Render free tier). 50 was too aggressive for 512MB.
const CHUNK_SIZE = config.queue.parseChunkSize;
const CHUNK_PAUSE_MS = 100; // breathing room between chunks

// ── Chunk helper ─────────────────────────────────────────────────────────────

function chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── File kind / entry point helpers ──────────────────────────────────────────

function detectFileKind(relativePath: string, sourceFile?: any): FileKind {
    const filename = path.basename(relativePath).toLowerCase();

    if (filename.endsWith(".d.ts")) return "declaration";

    const pathSegments = relativePath.split(/[\\/]/);
    if (
        filename.includes(".test.") ||
        filename.includes(".spec.") ||
        pathSegments.includes("__tests__") ||
        pathSegments.includes("__mocks__") ||
        pathSegments.includes("test") ||
        pathSegments.includes("tests") ||
        filename === "setuptests.ts" || filename === "setuptests.js" ||
        filename === "setup.ts" || filename === "setup.js" ||
        filename === "teardown.ts" || filename === "teardown.js"
    ) return "test";

    if (filename.endsWith(".jsx") || filename.endsWith(".tsx")) {
        if (sourceFile) {
            for (const [name] of sourceFile.getExportedDeclarations()) {
                if (/^[A-Z]/.test(name)) {
                    return "ui";
                }
            }
        }
    }

    if (
        filename.startsWith("jest.config") ||
        filename.startsWith("vite.config") ||
        filename.startsWith("webpack.config") ||
        filename.startsWith("tsdown.config") ||
        filename.startsWith("rollup.config") ||
        filename.startsWith("eslint.config") ||
        filename.startsWith("prettier.config") ||
        filename.startsWith("lint-staged.config") ||
        filename.startsWith("babel.config") ||
        filename.startsWith("next.config") ||
        filename.startsWith("nuxt.config") ||
        filename.startsWith("tailwind.config") ||
        filename.startsWith("postcss.config")
    ) return "config";

    return "source";
}

function countLines(absolutePath: string): number {
    try {
        const content = fs.readFileSync(absolutePath, "utf-8");
        return content.split("\n").length;
    } catch {
        return 0;
    }
}

// ── Result types ─────────────────────────────────────────────────────────────

export interface ChunkResult {
    fileNodes:       FileNode[];
    importEdges:     ImportEdge[];
    allFunctions:    FunctionNode[];
    startupSignals:  Map<string, boolean>;  // fileId → hasStartupSignals
    routeHandlers:   Map<string, boolean>;  // fileId → hasRouteHandlers
}

// ── Checkpointing ─────────────────────────────────────────────────────────────
// Lets a retried job (after OOM kill / restart) resume from the last finished
// chunk instead of re-parsing everything. The caller decides where checkpoints
// live (Redis, disk, ...) — this module only defines the contract + (de)serialization.

export interface ChunkCheckpointStore {
    load: (chunkIndex: number) => Promise<ChunkResult | null>;
    save: (chunkIndex: number, result: ChunkResult) => Promise<void>;
}

/** JSON-safe shape of a ChunkResult (Maps → entry arrays). */
export interface SerializedChunkResult {
    fileNodes:      FileNode[];
    importEdges:    ImportEdge[];
    allFunctions:   FunctionNode[];
    startupSignals: [string, boolean][];
    routeHandlers:  [string, boolean][];
}

export function serializeChunkResult(r: ChunkResult): SerializedChunkResult {
    return {
        fileNodes:      r.fileNodes,
        importEdges:    r.importEdges,
        allFunctions:   r.allFunctions,
        startupSignals: [...r.startupSignals.entries()],
        routeHandlers:  [...r.routeHandlers.entries()],
    };
}

export function deserializeChunkResult(s: SerializedChunkResult): ChunkResult {
    return {
        fileNodes:      s.fileNodes,
        importEdges:    s.importEdges,
        allFunctions:   s.allFunctions,
        startupSignals: new Map(s.startupSignals),
        routeHandlers:  new Map(s.routeHandlers),
    };
}

// ── Single chunk processor ────────────────────────────────────────────────────

async function processChunk(
    decisions:   ParseDecision[],
    repoRoot:    string,
    resolver:    ImportResolver,
    chunkIndex:  number
): Promise<ChunkResult> {
    const fileNodes:      FileNode[]    = [];
    const importEdges:    ImportEdge[]  = [];
    const allFunctions:   FunctionNode[] = [];
    const startupSignals  = new Map<string, boolean>();
    const routeHandlers   = new Map<string, boolean>();

    // One Project per chunk — disposed at end of this function
    const project = new Project({
        useInMemoryFileSystem: false,
        compilerOptions: {
            target: ScriptTarget.Latest,
            module: ModuleKind.CommonJS,
            allowJs: true,           // parse .js files too
            jsx: 4,                  // JsxEmit.ReactJSX — handles .tsx/.jsx
            skipLibCheck: true,      // don't type-check, just parse
            noEmit: true,
        },
    });

    // Add all files in this chunk to the project
    for (const decision of decisions) {
        try {
            project.addSourceFileAtPath(decision.absolutePath);
        } catch (err) {
            // file unreadable — log and skip, never crash the whole job
            console.warn(
                `[chunkProcessor] Could not add file: ${decision.relativePath} — ${(err as Error).message}`
            );
        }
    }

    // Process each file
    for (const decision of decisions) {
        const sourceFile = project.getSourceFile(decision.absolutePath);

        if (!sourceFile) {
            // was skipped during addSourceFileAtPath
            continue;
        }

        try {
            const fileLevelResult = extractFileLevel(
                sourceFile,
                decision.relativePath,
                repoRoot
            );

            // Resolve raw imports → ImportEdges + accurate external list
            const resolvedEdges:    ImportEdge[] = [];
            const unresolvedImports: string[]    = [];
            const confirmedExternal: string[]    = [];

            for (const rawImport of fileLevelResult.rawImports) {
                // Prefer ts-morph's compiler-resolved path when available.
                // This handles .js → .ts, .js → .tsx, baseUrl, paths aliases,
                // and workspace symlinks — all via the TS compiler.
                if (rawImport.resolvedPath) {
                    resolvedEdges.push({
                        source:     decision.relativePath,
                        target:     rawImport.resolvedPath,
                        kind:       rawImport.kind,
                        symbols:    rawImport.symbols,
                        isTypeOnly: rawImport.isTypeOnly,
                    });
                    continue;
                }

                // Fallback: ImportResolver handles dynamic imports and any
                // specifiers ts-morph couldn't resolve (missing files, etc.)
                const resolved = resolver.resolve(
                    rawImport.specifier,
                    decision.absolutePath
                );

                if (resolved.kind === "internal") {
                    resolvedEdges.push({
                        source:     decision.relativePath,
                        target:     resolved.resolvedPath,
                        kind:       rawImport.kind,
                        symbols:    rawImport.symbols,
                        isTypeOnly: rawImport.isTypeOnly,
                    });
                } else if (resolved.kind === "external") {
                    confirmedExternal.push(resolved.packageName);
                } else if (resolved.kind === "unresolved") {
                    unresolvedImports.push(resolved.specifier);
                }
            }

            importEdges.push(...resolvedEdges);

            // Record semantic signals for entry scorer (keyed by fileId)
            startupSignals.set(decision.relativePath, fileLevelResult.hasStartupSignals);
            routeHandlers.set(decision.relativePath,  fileLevelResult.hasRouteHandlers);

            // ── Function level: only for "full" parse files ───────────────
            const extracted = decision.mode === "full"
                    ? extractFunctionLevel(sourceFile, decision.relativePath)
                    : { functions: [], structures: [] };

            const functions: FunctionNode[] = extracted.functions;
            const structures: StructureNode[] = extracted.structures;

            // Debug: warn if a JS file in full-parse mode produced 0 functions
            if (decision.mode === "full" && functions.length === 0) {
                const ext = path.extname(decision.relativePath);
                if (ext === ".js" || ext === ".jsx") {
                    console.log(`[chunkProcessor] ⚠ 0 functions in JS file: ${decision.relativePath}`);
                }
            }

            allFunctions.push(...functions);

            // ── Build FileNode ────────────────────────────────────────────
            const ext = decision.relativePath.split(".").pop() ?? "";
            const language =
                ext === "ts" || ext === "tsx"
                    ? "typescript"
                    : ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs"
                        ? "javascript"
                        : "unknown";

            const kind = detectFileKind(decision.relativePath, sourceFile);

            let testSuites: string[] = [];
            let testCases: string[] = [];
            if (kind === "test") {
                const metadata = extractTestMetadata(sourceFile);
                testSuites = metadata.testSuites;
                testCases = metadata.testCases;
            }

            fileNodes.push({
                id:               decision.relativePath,
                label:            path.basename(decision.relativePath),
                language,
                path:             decision.relativePath,
                sizeBytes:        decision.sizeBytes,
                lineCount:        countLines(decision.absolutePath),
                parseStatus:      decision.mode === "skip" ? "skipped" : decision.mode,
                kind,
                isEntryPoint:     false,
                functions,
                structures,
                externalImports:  [...new Set(confirmedExternal)],
                unresolvedImports,
                testSuites,
                testCases,
                cycleScore: undefined,
                hubScore: undefined,
                architecturalImportance: undefined,
                // Phase 4: barrel detection signals from fileLevel.ts
                isBarrel:         fileLevelResult.isBarrel,
                barrelTargets:    fileLevelResult.barrelExportSpecifiers,
            });

        } catch (err) {
            // parsing this file failed — add it as a minimal node, never crash
            console.warn(
                `[chunkProcessor] Parse error in ${decision.relativePath}: ${(err as Error).message}`
            );

            fileNodes.push({
                id: decision.relativePath,
                label: path.basename(decision.relativePath),
                language: "unknown",
                path: decision.relativePath,
                sizeBytes: decision.sizeBytes,
                lineCount: countLines(decision.absolutePath),
                parseStatus: "skipped",
                kind: detectFileKind(decision.relativePath),
                isEntryPoint: false,
                functions: [],
                externalImports: [],
                unresolvedImports: [],
            });
        }
    }

    // IMPORTANT: dispose project to free ts-morph memory
    project.getSourceFiles().forEach((sf) => project.removeSourceFile(sf));

    return { fileNodes, importEdges, allFunctions, startupSignals, routeHandlers };
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function processAllFiles(
    decisions: ParseDecision[],
    repoRoot: string,
    onProgress?: (processedSoFar: number, total: number) => void,
    checkpoints?: ChunkCheckpointStore
): Promise<ChunkResult> {
    // ── Language split ────────────────────────────────────────────────────────
    // JS/TS goes through ts-morph (below). Python/Go/C/C++ go through the
    // tree-sitter pipeline (parser/treesitter/) which emits identical shapes.
    const treeSitterDecisions = decisions.filter((d) =>
        isTreeSitterFile(d.relativePath)
    );
    const jsDecisions = decisions.filter(
        (d) => !isTreeSitterFile(d.relativePath)
    );

    const totalParseable = decisions.filter((d) => d.mode !== "skip").length;
    let globalProcessed = 0;
    const reportProgress = (n: number) => {
        globalProcessed += n;
        onProgress?.(globalProcessed, totalParseable);
    };

    decisions = jsDecisions;

    // Filter out "skip" mode — don't pass to ts-morph at all
    const filesToParse = decisions.filter((d) => d.mode !== "skip");
    const skippedFiles = decisions.filter((d) => d.mode === "skip");

    const resolver = new ImportResolver(repoRoot);
    const chunks = chunkArray(filesToParse, CHUNK_SIZE);

    const allFileNodes:     FileNode[]    = [];
    const allImportEdges:   ImportEdge[]  = [];
    const allFunctions:     FunctionNode[] = [];
    const allStartupSignals = new Map<string, boolean>();
    const allRouteHandlers  = new Map<string, boolean>();

    console.log(
        `[chunkProcessor] ${filesToParse.length} files to parse in ${chunks.length} chunks`
    );

    let processedCount = 0;

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        console.log(
            `[chunkProcessor] chunk ${i + 1}/${chunks.length} — ${chunk.length} files`
        );

        // ── Checkpoint: skip chunks already parsed by a previous (crashed) attempt
        let result: ChunkResult | null = null;
        if (checkpoints) {
            try {
                result = await checkpoints.load(i);
                if (result) {
                    console.log(`[chunkProcessor] chunk ${i + 1} restored from checkpoint — skipping parse`);
                }
            } catch {
                result = null; // checkpoint read failure is never fatal
            }
        }

        if (!result) {
            result = await processChunk(chunk, repoRoot, resolver, i);
            if (checkpoints) {
                try {
                    await checkpoints.save(i, result);
                } catch (err) {
                    console.warn(`[chunkProcessor] checkpoint save failed (non-fatal):`, (err as Error).message);
                }
            }
        }

        allFileNodes.push(...result.fileNodes);
        allImportEdges.push(...result.importEdges);
        allFunctions.push(...result.allFunctions);
        result.startupSignals.forEach((v, k) => allStartupSignals.set(k, v));
        result.routeHandlers.forEach((v, k)  => allRouteHandlers.set(k, v));

        processedCount += chunk.length;
        reportProgress(chunk.length);

        // breathing room between chunks — lets GC run
        if (i < chunks.length - 1) {
            await sleep(CHUNK_PAUSE_MS);
        }
    }

    // Add skipped files as minimal FileNodes so they appear in graph
    for (const decision of skippedFiles) {
        allFileNodes.push({
            id: decision.relativePath,
            label: path.basename(decision.relativePath),
            language: "unknown",
            path: decision.relativePath,
            sizeBytes: decision.sizeBytes,
            lineCount: countLines(decision.absolutePath),
            parseStatus: "skipped",
            kind: detectFileKind(decision.relativePath),
            isEntryPoint: false,
            functions: [],
            externalImports: [],
            unresolvedImports: [],
        });
    }

    // ── Tree-sitter languages (Python / Go / C / C++) ─────────────────────────
    if (treeSitterDecisions.length > 0) {
        console.log(
            `[chunkProcessor] ${treeSitterDecisions.length} files → tree-sitter pipeline`
        );

        const fileIndex = new RepoFileIndex(
            repoRoot,
            treeSitterDecisions.map((d) => ({
                relativePath: d.relativePath,
                absolutePath: d.absolutePath,
            }))
        );
        const registry = new LanguageRegistry(fileIndex);

        const tsResult = await processTreeSitterFiles(
            treeSitterDecisions,
            repoRoot,
            fileIndex,
            registry,
            (done, _total) => {
                onProgress?.(
                    Math.min(globalProcessed + done, totalParseable),
                    totalParseable
                );
            }
        );

        allFileNodes.push(...tsResult.fileNodes);
        allImportEdges.push(...tsResult.importEdges);
        allFunctions.push(...tsResult.allFunctions);
        tsResult.startupSignals.forEach((v, k) => allStartupSignals.set(k, v));
        tsResult.routeHandlers.forEach((v, k) => allRouteHandlers.set(k, v));
    }

    console.log(
        `[chunkProcessor] done — ` +
        `${allFileNodes.length} files, ` +
        `${allImportEdges.length} import edges, ` +
        `${allFunctions.length} functions`
    );

    return {
        fileNodes:      allFileNodes,
        importEdges:    allImportEdges,
        allFunctions,
        startupSignals: allStartupSignals,
        routeHandlers:  allRouteHandlers,
    };
}
