// src/parser/snippetFetcher.ts
// ─────────────────────────────────────────────────────────────────────────────
// Bridges candidate file IDs → actual code bodies for Gemini to reason over.
//
// Phase 3 redesign:
//   Removed all scoring-based function selection:
//     - scoreFunctionAgainstIntent() — deleted
//     - intentHasAuth / intentHasData checks — deleted
//     - FUNCTION_SCORE_THRESHOLD — deleted
//     - hasAuthCheck / hasDatabaseCall boosts — deleted
//     - function kind weights (resolver, middleware, etc.) — deleted
//
//   New function selection logic (per candidate source):
//     - PR-sourced: take top exported functions (or all if few)
//     - Keyword / gemini-directed: take functions whose names overlap tokens
//     - Barrel-expansion / neighborhood: take first few exported functions
//     - No functions in index: include whole file (truncated)
//
//   What stays the same:
//     - fetchRawFileCached() — GitHub + Redis caching
//     - sliceFunctionBody() — line-based extraction
//     - semanticTruncate() — simple head+tail truncation
// ─────────────────────────────────────────────────────────────────────────────

import type { RetrievalIndex, RetrievalFileEntry, RetrievalFunction } from "../models/retrieval";
import type { SearchIntent } from "./issueUnderstanding";
import type { CandidateFileEntry } from "./issueMapper";
import { isTestPath, isNoisePath } from "./issueMapper";
import { fetchRawFile } from "../github/issueClient";
import { redisConnection } from "../queue/jobQueue";

// ── Output types ──────────────────────────────────────────────────────────────

/**
 * A code snippet ready for Gemini consumption.
 * Contains the actual function body sliced from the raw file.
 */
export interface CodeSnippet {
    /** Relative file path from repo root */
    fileId: string;
    /** Function name */
    functionName: string;
    /** Full function ID (filePath::functionName) */
    functionId: string;
    /** The actual source code of the function */
    body: string;
    /** Source lines range */
    startLine: number;
    endLine: number;
    /** Why this snippet was selected (for pipeline debugging) */
    selectionReasons: string[];
    /** How this file entered the candidate set */
    candidateSource: CandidateFileEntry["source"];
    /** Lexical/graph rank score (higher = more relevant) — shown to Gemini. */
    candidateScore?: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Maximum functions per file to include in snippets.
 *
 * 5 is the empirical sweet spot: enough to cover different call paths,
 * not so many that context is wasted.
 */
const MAX_FUNCTIONS_PER_FILE = 4;



/**
 * Redis TTL for raw file cache (1 hour).
 */
const RAW_FILE_CACHE_TTL_SECONDS = 3600;

/**
 * Maximum total snippets to send to Gemini.
 */
const MAX_TOTAL_SNIPPETS = 26;

/**
 * Emergency safety cap (lines) for a SINGLE function slice. Any snippet longer
 * than this is hard-truncated. Final safety net for parser edge cases where line
 * numbers are wrong or a "function" spans most of a file. Lowered from 1200 →
 * 700 so a leaked/huge body can never balloon the prompt.
 */
const MAX_SNIPPET_LINES = 700;

/**
 * Per-FILE line budget across all of that file's snippets. Once a file has
 * contributed this many lines we stop adding more from it. Stops one big file
 * (e.g. a parser-confused source file) from eating the whole prompt.
 */
const MAX_LINES_PER_FILE = 220;

/**
 * Test files are retrieved exactly like source files — function-by-function,
 * using MAX_FUNCTIONS_PER_FILE and MAX_LINES_PER_FILE — because individual test
 * functions are short and may all be relevant. The ONLY special case is a test
 * file that the parser reported with 0 functions (it choked on the suite): we
 * must not dump the whole 800-line suite, so we send a bounded preview instead.
 */
const TEST_PREVIEW_LINES = 120;

/** Bounded preview for definition/schema files with no parsed symbols. */
const CONTENT_PREVIEW_LINES = 100;

// ── Token-based function selection ────────────────────────────────────────────

/**
 * Select functions from a file based on candidate source and token overlap.
 *
 * No scoring. No weighting. Simple rules per source type:
 *   - "pr": take exported functions first, then any (most prominent)
 *   - "keyword" / "gemini-directed": take functions whose names match tokens
 *   - "barrel-expansion" / "neighborhood": take first few exported functions
 *
 * @param functions  All functions in the file from RetrievalIndex
 * @param source     How this file entered the candidate set
 * @param tokens     Entity tokens from SearchIntent
 * @returns          Selected functions with selection reasons
 */
function selectFunctions(
    functions: RetrievalFunction[],
    source: CandidateFileEntry["source"],
    tokens: string[],
): Array<{ fn: RetrievalFunction; reasons: string[] }> {
    if (functions.length === 0) return [];

    switch (source) {
        case "pr": {
            // PR files: take exported functions first (entry points),
            // fall back to any functions if none are exported
            const exported = functions.filter(fn => fn.isExported);
            const selected = exported.length > 0
                ? exported.slice(0, MAX_FUNCTIONS_PER_FILE)
                : functions.slice(0, MAX_FUNCTIONS_PER_FILE);
            return selected.map(fn => ({
                fn,
                reasons: [`PR-sourced file, ${fn.isExported ? "exported" : "non-exported"} function`],
            }));
        }

        case "keyword":
        case "gemini-directed": {
            // Take functions whose names contain any token (substring match)
            const matched = functions.filter(fn => {
                const nameLower = fn.name.toLowerCase();
                return tokens.some(t => nameLower.includes(t));
            });

            if (matched.length > 0) {
                return matched.slice(0, MAX_FUNCTIONS_PER_FILE).map(fn => ({
                    fn,
                    reasons: [`function name matches issue tokens`],
                }));
            }

            // No name matches — take first few exported as representative sample
            const exported = functions.filter(fn => fn.isExported);
            return (exported.length > 0 ? exported : functions)
                .slice(0, 3)
                .map(fn => ({
                    fn,
                    reasons: [`representative sample (no direct name match)`],
                }));
        }

        case "barrel-expansion":
        case "neighborhood": {
            // Take first few exported functions as representative sample
            const exported = functions.filter(fn => fn.isExported);
            return (exported.length > 0 ? exported : functions)
                .slice(0, 3)
                .map(fn => ({
                    fn,
                    reasons: [`${source} — representative exported function`],
                }));
        }

        default:
            return functions.slice(0, 3).map(fn => ({
                fn,
                reasons: [`included from ${source}`],
            }));
    }
}

// ── Structure selection (enums / classes / types / schema definitions) ────────

/**
 * Select structures from a file the same way we select functions, then expose
 * them as function-shaped slices so Phase B can slice their bodies uniformly.
 * This is what makes definition & schema files retrievable universally — across
 * any language and any framework/DB (GraphQL, Mongo/Prisma models, Redis schema,
 * C/C++ structs, Go types, Python classes) — instead of being dropped.
 */
function selectStructures(
    structures: Array<{ name: string; startLine: number; endLine: number }>,
    source: CandidateFileEntry["source"],
    tokens: string[],
    fileId: string,
): Array<{ fn: RetrievalFunction; reasons: string[] }> {
    if (structures.length === 0) return [];

    const toFn = (st: { name: string; startLine: number; endLine: number }, reason: string) => ({
        fn: {
            id: `${fileId}::${st.name}`,
            name: st.name,
            filePath: fileId,
            startLine: st.startLine,
            endLine: st.endLine,
            kind: "structure",
            isExported: true,
            isAsync: false,
            hasAuthCheck: false,
            hasDatabaseCall: false,
            calls: [] as string[],
        } as RetrievalFunction,
        reasons: [reason],
    });

    if (source === "keyword" || source === "gemini-directed") {
        const matched = structures.filter(st => {
            const n = st.name.toLowerCase();
            return tokens.some(t => n.includes(t));
        });
        if (matched.length > 0) {
            return matched.slice(0, MAX_FUNCTIONS_PER_FILE)
                .map(st => toFn(st, "structure name matches issue tokens (enum/class/type/schema)"));
        }
    }

    // PR → take more; others → a few representative structures
    const cap = source === "pr" ? MAX_FUNCTIONS_PER_FILE : 3;
    return structures.slice(0, cap).map(st => toFn(st, `${source} — representative structure (${st.name})`));
}

// ── Semantic truncation ───────────────────────────────────────────────────────

/**
 * Patterns that identify high-signal lines worth preserving in truncation.
 */
/**
 * Simple truncation for pathologically large functions.
 * Returns the first 60 lines, an omission comment, and the last 20 lines.
 * If the input is 80 lines or fewer, returns it unchanged.
 */
function semanticTruncate(body: string): string {
    const lines = body.split("\n");
    if (lines.length <= 80) return body;

    const head = lines.slice(0, 60);
    const tail = lines.slice(-20);
    const omitted = lines.length - 80;

    return [
        ...head,
        `// ... [${omitted} lines omitted] ...`,
        ...tail,
    ].join("\n");
}

// ── Boilerplate stripping (Phase 5: cut wasted tokens) ────────────────────────

/**
 * Remove zero-signal lines from the TOP of a file before previewing it: license
 * headers, leading comment blocks, and import/include lines. A naive "first N
 * lines" preview otherwise wastes the whole budget on the license + imports.
 * Language-agnostic enough for JS/TS/Py/Go/C/C++.
 */
function stripBoilerplate(content: string): string {
    let lines = content.split("\n");
    let i = 0;
    const isBlank = (l: string) => l.trim() === "";
    const isLineComment = (l: string) => /^\s*(\/\/|#|\*|\/\*|\*\/)/.test(l);
    const isImport = (l: string) =>
        /^\s*(import\s|from\s+\S+\s+import\s|export\s+\*|export\s+\{|const\s+\w+\s*=\s*require\(|#include\b|using\s+\w|package\s+\w|use\s+\w)/.test(l);

    // Skip a contiguous leading run of blanks / comments / imports.
    while (i < lines.length && (isBlank(lines[i]) || isLineComment(lines[i]) || isImport(lines[i]))) {
        i++;
    }
    // Don't strip everything — if the whole head was boilerplate and nothing
    // meaningful remains close by, fall back to the original.
    if (i >= lines.length) return content;
    return lines.slice(i).join("\n");
}

// ── Raw file caching ──────────────────────────────────────────────────────────

/**
 * Fetch a raw file from GitHub with Redis caching.
 *
 * Cache key: rawfile:{owner}:{repo}:{sha}:{fileId}
 * TTL: RAW_FILE_CACHE_TTL_SECONDS (1 hour)
 */
async function fetchRawFileCached(
    owner: string,
    repo: string,
    commitSha: string,
    fileId: string,
): Promise<string> {
    const safeFileId = fileId.replace(/[/\\]/g, ":");
    const cacheKey = `rawfile:${owner}:${repo}:${commitSha}:${safeFileId}`;

    try {
        const cached = await redisConnection.get(cacheKey);
        if (cached) {
            console.log(`\x1b[36m[snippetFetcher] cache hit: ${fileId}\x1b[0m`);
            return cached;
        }
    } catch {
        // Redis failure is non-fatal
    }

    const content = await fetchRawFile(owner, repo, commitSha, fileId);

    if (content) {
        try {
            await redisConnection.set(cacheKey, content, "EX", RAW_FILE_CACHE_TTL_SECONDS);
        } catch {
            // Cache write failure is never fatal
        }
    }

    return content;
}

/**
 * Slice a function body from raw file content using line numbers.
 * Line numbers from ts-morph are 1-indexed.
 */
function sliceFunctionBody(
    rawContent: string,
    startLine: number,
    endLine: number,
): string {
    const lines = rawContent.split("\n");
    const start = Math.max(0, startLine - 1);
    const end = Math.min(lines.length, endLine);
    return lines.slice(start, end).join("\n");
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Select functions from candidate files and fetch their code bodies.
 *
 * Phase A (Selection — no I/O):
 *   Select functions using token overlap and source-based rules.
 *   No scoring. No threshold filtering.
 *
 * Phase B (Fetching — GitHub API, Redis cached):
 *   Fetch raw file content for each surviving file (once per file).
 *   Slice function bodies using line numbers.
 *   Apply semantic truncation to huge functions.
 *
 * @param candidates   Candidate files from issueMapper.traverseGraph()
 * @param retrieval    RetrievalIndex for function metadata
 * @param intent       SearchIntent for token-based function selection
 * @param owner        GitHub repo owner
 * @param repo         GitHub repo name
 * @param commitSha    Commit SHA for raw file fetching
 * @returns            Code snippets ready for Gemini
 */
export async function fetchSnippets(
    candidates: CandidateFileEntry[],
    retrieval: RetrievalIndex,
    intent: SearchIntent,
    owner: string,
    repo: string,
    commitSha: string,
): Promise<CodeSnippet[]> {
    // Build file map for O(1) lookup
    const fileMap = new Map<string, RetrievalFileEntry>();
    for (const f of retrieval.files) {
        fileMap.set(f.fileId, f);
    }

    const tokens = intent.entities;

    // ── Phase A: Function selection ───────────────────────────────────────────

    interface SelectedFile {
        candidateEntry: CandidateFileEntry;
        selectedFunctions: Array<{ fn: RetrievalFunction; reasons: string[] }>;
        /** Indicates how to handle files with 0 selected functions */
        zeroFunctionMode?: "pr-no-metadata" | "structure-pr-partial" | "zero-pr-partial" | "test-partial" | "content-preview" | "barrel-summary";
    }

    const selectedFiles: SelectedFile[] = [];

    for (const candidate of candidates) {
        // Drop generated / declaration / build files BEFORE fetching — even when
        // they come from a linked PR. These (gql.tada.d.ts, *.generated.*,
        // schema.graphql, dist/…) are regenerated, never hand-edited, and their
        // huge bodies were ballooning the Gemini prompt (and cost) for nothing.
        if (isNoisePath(candidate.fileId)) {
            console.log(`\x1b[33m[snippetFetcher] dropping generated/declaration file ${candidate.fileId}\x1b[0m`);
            continue;
        }

        const fileEntry = fileMap.get(candidate.fileId);

        const isStrongCandidate = candidate.source === "pr"
            || candidate.source === "keyword"
            || candidate.source === "gemini-directed";

        if (fileEntry?.isBarrel === true) {
            // Don't silently drop a barrel that genuinely matched. Send a CHEAP
            // one-line re-export summary (~20 tokens), never its full body. The
            // full body is only fetched if Gemini asks for it in Round 2.
            if (isStrongCandidate) {
                selectedFiles.push({ candidateEntry: candidate, selectedFunctions: [], zeroFunctionMode: "barrel-summary" });
            } else {
                console.log(`\x1b[33m[snippetFetcher] dropping weak barrel candidate ${candidate.fileId}\x1b[0m`);
            }
            continue;
        }

        if (!fileEntry) {

            if (candidate.source === "pr") {
                selectedFiles.push({ candidateEntry: candidate, selectedFunctions: [], zeroFunctionMode: "pr-no-metadata" });
            }
            continue;
        }

        // ── 0-function files: structures, content preview, test, or barrel ─────
        if (fileEntry.functions.length === 0) {
            const structures = fileEntry.structures ?? [];

            if (structures.length > 0) {
                // Structure-only file (enum / class / interface / type / schema
                // definition). Slice the structures just like functions, for ANY
                // source — universal across languages and frameworks/DBs.
                const selectedStructs = selectStructures(structures, candidate.source, tokens, candidate.fileId);
                selectedFiles.push({ candidateEntry: candidate, selectedFunctions: selectedStructs });
            } else if (isTestPath(candidate.fileId)) {
                // Test file the parser reported with 0 functions — bounded preview.
                selectedFiles.push({ candidateEntry: candidate, selectedFunctions: [], zeroFunctionMode: "test-partial" });
            } else if (isStrongCandidate) {
                // No parsed symbols at all but a STRONG candidate (named in issue,
                // PR, or top-ranked): could be a macro-only header or a schema
                // written in a form the parser doesn't model. Bounded, stripped
                // preview. Phase B drops it if nothing survives stripping (= true
                // barrel), so this never floods Gemini with vague files.
                selectedFiles.push({ candidateEntry: candidate, selectedFunctions: [], zeroFunctionMode: "content-preview" });
            } else {
                // Weak candidate (neighborhood / barrel-expansion), no symbols → drop.
                console.log(`\x1b[33m[snippetFetcher] dropping weak symbol-less candidate ${candidate.fileId}\x1b[0m`);
            }
            continue;
        }

        const selected = selectFunctions(fileEntry.functions, candidate.source, tokens);
        selectedFiles.push({ candidateEntry: candidate, selectedFunctions: selected });
    }

    // ── Phase B: Fetch file content and slice bodies ──────────────────────────

    const snippets: CodeSnippet[] = [];
    const fetchedContent = new Map<string, string>();

    for (const { candidateEntry, selectedFunctions, zeroFunctionMode } of selectedFiles) {
        if (snippets.length >= MAX_TOTAL_SNIPPETS) break;

        const { fileId, source } = candidateEntry;

        // Barrel summary — one cheap line, no content fetch needed.
        if (zeroFunctionMode === "barrel-summary") {
            const targets = fileMap.get(fileId)?.barrelTargets ?? [];
            const list = targets.length > 0 ? targets.slice(0, 12).join(", ") : "(targets unknown)";
            snippets.push({
                fileId,
                functionName: "(barrel)",
                functionId: `${fileId}::*`,
                body: `// Barrel / index file — re-exports from: ${list}`,
                startLine: 1,
                endLine: 1,
                selectionReasons: ["barrel re-export summary (cheap; full body only on request)"],
                candidateSource: source,
                candidateScore: candidateEntry.score,
            });
            continue;
        }

        // Fetch raw file content (once per file, Redis-cached)
        let rawContent = fetchedContent.get(fileId);
        if (rawContent === undefined) {
            try {
                rawContent = await fetchRawFileCached(owner, repo, commitSha, fileId);
                fetchedContent.set(fileId, rawContent);
            } catch (err) {
                console.warn(`\x1b[31m[snippetFetcher] failed to fetch ${fileId}:\x1b[0m`, (err as Error).message);
                continue;
            }
        }

        if (!rawContent) continue;

        // ── Zero-function modes: controlled partial fetch ──────────────────
        if (selectedFunctions.length === 0) {
            const lines = rawContent.split("\n");

            // Determine how many lines to preview based on mode
            let previewLines: number;
            let reason: string;

            switch (zeroFunctionMode) {
                case "structure-pr-partial":
                    previewLines = Math.min(80, lines.length);
                    reason = "PR-sourced structure-only file (partial preview)";
                    break;
                case "zero-pr-partial":
                    previewLines = Math.min(80, lines.length);
                    reason = "PR-sourced zero-content file (partial preview)";
                    break;
                case "test-partial":
                    previewLines = Math.min(TEST_PREVIEW_LINES, lines.length);
                    reason = "test file (0 functions parsed — bounded preview, not full suite)";
                    break;
                case "content-preview":
                    previewLines = Math.min(CONTENT_PREVIEW_LINES, lines.length);
                    reason = "definition/schema file (no functions — bounded content preview)";
                    break;
                case "pr-no-metadata":
                default:
                    previewLines = Math.min(80, lines.length);
                    reason = "PR-sourced file (no function metadata, partial preview)";
                    break;
            }

            const meaningful = stripBoilerplate(lines.join("\n")).split("\n");
            // Content preview self-filters barrels: nothing left after stripping → drop.
            if (zeroFunctionMode === "content-preview" && meaningful.join("").trim().length === 0) {
                console.log(`\x1b[33m[snippetFetcher] ${fileId} empty after stripping (barrel-like) — dropping\x1b[0m`);
                continue;
            }
            const body = meaningful.slice(0, previewLines).join("\n")
                + (meaningful.length > previewLines ? `\n// ... [${meaningful.length - previewLines} more lines omitted] ...` : "");

            snippets.push({
                fileId,
                functionName: "(partial file)",
                functionId: `${fileId}::*`,
                body,
                startLine: 1,
                endLine: previewLines,
                selectionReasons: [reason],
                candidateSource: source,
                candidateScore: candidateEntry.score,
            });
            continue;
        }

        // Slice individual function bodies — with a hard per-file line budget so
        // no single file (test or source) can dominate the prompt.
        const perFileBudget = MAX_LINES_PER_FILE;
        let linesFromThisFile = 0;
        for (const { fn, reasons } of selectedFunctions) {
            if (snippets.length >= MAX_TOTAL_SNIPPETS) break;
            if (linesFromThisFile >= perFileBudget) {
                console.log(`\x1b[33m[snippetFetcher] per-file budget hit for ${fileId} (${linesFromThisFile}/${perFileBudget} lines) — skipping remaining functions\x1b[0m`);
                break;
            }

            let rawBody = sliceFunctionBody(rawContent, fn.startLine, fn.endLine);

            // Emergency safety cap — hard-truncate if parser line numbers are wrong
            const rawLines = rawBody.split("\n");
            if (rawLines.length > MAX_SNIPPET_LINES) {
                console.warn(`\x1b[31m[snippetFetcher] truncating oversized snippet ${fileId}::${fn.name} (${rawLines.length} lines → ${MAX_SNIPPET_LINES})\x1b[0m`);
                rawBody = rawLines.slice(0, MAX_SNIPPET_LINES).join("\n") + `\n// ... [truncated at ${MAX_SNIPPET_LINES} lines] ...`;
            }

            let body = semanticTruncate(rawBody);

            // Clamp this snippet to the file's remaining budget.
            const remaining = perFileBudget - linesFromThisFile;
            const bodyLineArr = body.split("\n");
            if (bodyLineArr.length > remaining) {
                body = bodyLineArr.slice(0, Math.max(1, remaining)).join("\n")
                    + `\n// ... [trimmed to per-file budget] ...`;
            }
            linesFromThisFile += body.split("\n").length;

            snippets.push({
                fileId,
                functionName: fn.name,
                functionId: fn.id,
                body,
                startLine: fn.startLine,
                endLine: fn.endLine,
                selectionReasons: reasons,
                candidateSource: source,
                candidateScore: candidateEntry.score,
            });
        }
    }

    // Dedupe: drop repeated functionIds and byte-identical bodies (Phase 5).
    const seenIds = new Set<string>();
    const seenBodies = new Set<string>();
    const deduped: CodeSnippet[] = [];
    for (const snip of snippets) {
        const bodyKey = snip.body.trim();
        if (seenIds.has(snip.functionId)) continue;
        if (bodyKey.length > 0 && seenBodies.has(bodyKey)) continue;
        seenIds.add(snip.functionId);
        seenBodies.add(bodyKey);
        deduped.push(snip);
    }

    // Highest-ranked snippets first so Gemini reads the strongest candidates up top.
    deduped.sort((a, b) => (b.candidateScore ?? 0) - (a.candidateScore ?? 0));

    console.log(
        `\x1b[32m[snippetFetcher] selected ${deduped.length} snippets (from ${snippets.length} pre-dedupe) across ` +
        `${selectedFiles.length}/${candidates.length} candidate files\x1b[0m`
    );

    return deduped;
}
