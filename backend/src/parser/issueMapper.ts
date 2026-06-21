// src/parser/issueMapper.ts
// ─────────────────────────────────────────────────────────────────────────────
// Graph traversal engine for issue-to-code mapping.
//
// Phase 3 redesign:
//   Given a SearchIntent (just entities[] + isVague), navigate the
//   RetrievalIndex graph to find candidate files through:
//     1. Pure substring match against function names and file paths
//     2. Barrel expansion (barrels → real implementation files)
//     3. One-hop neighborhood (importedBy + imports of matched files)
//     4. PR-based files (strongest signal — always included)
//
//   Returns an UNORDERED candidate set. No scoring. No ranking.
//   Ranking is Gemini's job.
//
// What was removed:
//   - scoreAgainstIntent() weighted scoring
//   - rawScore field on CandidateFileEntry
//   - getVagueFallbackCandidates() (vague path now handled by Stage 2 in pipeline)
//   - semanticRole-based scoring
//   - All domain assumptions (auth, data, resolver weights)
//
// BACKWARD COMPATIBILITY:
//   Legacy mapIssueToCode() and buildInlineSearchIndex() are preserved
//   for repos without a RetrievalIndex.
// ─────────────────────────────────────────────────────────────────────────────

import type {
    SearchIndex,
    SearchIndexEntry,
    IssueMappingResult,
    CandidateFile,
    CandidateFunction,
} from "../models/schema";
import type { RetrievalIndex, RetrievalFileEntry } from "../models/retrieval";
import type { SearchIntent } from "./issueUnderstanding";
import { rankFiles } from "./lexicalRanker";
import type { LinkedPR } from "../github/issueClient";
import { searchIndex as runSearch } from "../search/queryEngine";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * The output of the graph traversal mapper.
 * An unordered candidate set — Gemini ranks, not the mapper.
 */
export interface CandidateSet {
    /** Files found through graph traversal, with source annotation */
    files: CandidateFileEntry[];
    /** Whether the RetrievalIndex was used (true) or inline fallback (false) */
    usedRetrievalIndex: boolean;
}

export interface CandidateFileEntry {
    fileId: string;
    /** How this file entered the candidate set */
    source: "pr" | "keyword" | "barrel-expansion" | "neighborhood" | "gemini-directed";
    score?: number; // Optional score field
}

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Maximum candidate set size before neighborhood expansion.
 * Caps direct matches to keep the total manageable after expansion.
 */
const MAX_DIRECT_CANDIDATES = 15;

/**
 * Maximum total candidates after neighborhood expansion.
 * Each file is potentially a GitHub API call — 30 is the practical limit.
 */
const MAX_TOTAL_CANDIDATES = 30;

/**
 * Minimum candidates from Stage 1 before the pipeline triggers Stage 2.
 * If token traversal finds fewer than this, Gemini reads the graph map.
 */
export const MIN_CANDIDATES_FOR_STAGE1 = 5;

// ── Noise filter ──────────────────────────────────────────────────────────────

/**
 * Files that should never enter the candidate set from token matching.
 * These are structural/universal filters — not domain-specific.
 *
 * - .d.ts: TypeScript declarations, zero runtime behavior
 * - auto-docs/auto-schema: generated documentation
 * - Test files: only enter via PR source, never via token match
 */
export function isNoisePath(fileId: string): boolean {
    const lower = fileId.toLowerCase();

    // TypeScript declaration files — zero behavior
    if (lower.endsWith(".d.ts")) return true;

    // Auto-generated documentation
    if (lower.includes("/auto-docs/") || lower.includes("/auto-schema/")) return true;

    return false;
}

/**
 * Detects test files across the supported languages.
 *
 * Test files are NOT noise — a bug can genuinely live in (or be diagnosed from)
 * a test, so they ARE allowed into the candidate set. But they are tightly
 * controlled: they only enter via a DIRECT token/path match or a PR (never via
 * barrel/neighborhood graph expansion), are capped in COUNT here, and are hard
 * truncated in snippetFetcher so a single large test suite can never flood
 * Gemini (the historical "0 functions → whole 800-line file sent" failure).
 */
export function isTestPath(fileId: string): boolean {
    const lower = fileId.toLowerCase();
    // JS/TS: foo.test.ts, foo.spec.tsx
    if (/\.(test|spec)\.(ts|js|tsx|jsx|mjs|cjs)$/i.test(lower)) return true;
    // Python: test_foo.py, foo_test.py
    if (/(^|\/)test_[^/]*\.py$/i.test(lower)) return true;
    if (/_test\.py$/i.test(lower)) return true;
    // Go: foo_test.go
    if (/_test\.go$/i.test(lower)) return true;
    // C/C++: foo_test.cpp, test_foo.cc (path- or name-delimited)
    if (/(^|[/_-])tests?[/_-][^/]*\.(c|cc|cpp|cxx|h|hpp|hh)$/i.test(lower)) return true;
    // Common test directories
    if (/(^|\/)__tests__\//i.test(lower)) return true;
    if (/(^|\/)tests?\//i.test(lower)) return true;
    if (/(^|\/)(spec|specs)\//i.test(lower)) return true;
    return false;
}

// ── Pure substring matching ───────────────────────────────────────────────────

/**
 * Check if a text contains ANY of the tokens from the search intent.
 *
 * Pure substring match — no scoring, no weighting, no domain assumptions.
 * A match is a match. Returns true/false only.
 */
function matchesAnyToken(text: string, tokens: string[]): boolean {
    const lower = text.toLowerCase();
    return tokens.some(token => lower.includes(token));
}

// ── Barrel expansion ──────────────────────────────────────────────────────────

/**
 * Expand barrel files to their real implementation targets.
 *
 * Barrel files (index.ts that only re-exports) dominate keyword searches
 * because they reference many names. But they contain no code worth reading.
 * This function replaces barrel fileIds with their actual implementation targets.
 */
function expandBarrels(
    fileIds: Set<string>,
    fileMap: Map<string, RetrievalFileEntry>,
): Set<string> {
    const expanded = new Set<string>();

    for (const fileId of fileIds) {
        const entry = fileMap.get(fileId);
        if (entry?.isBarrel && entry.barrelTargets.length > 0) {
            for (const target of entry.barrelTargets) {
                expanded.add(target);
            }
        } else {
            expanded.add(fileId);
        }
    }

    return expanded;
}

// ── Neighborhood expansion (Scored BFS) ───────────────────────────────────────

interface BFSSeed {
    fileId: string;
    score: number;
}

function runBFS(
    seeds: BFSSeed[],
    fileMap: Map<string, RetrievalFileEntry>,
    graphFileIds: Set<string>,
): Array<{ fileId: string; score: number }> {
    const scores = new Map<string, number>();

    // Level 0 (Hops 0)
    let currentLevel = new Map<string, number>();
    for (const seed of seeds) {
        currentLevel.set(seed.fileId, (currentLevel.get(seed.fileId) ?? 0) + seed.score);
        scores.set(seed.fileId, (scores.get(seed.fileId) ?? 0) + seed.score);
    }

    // Run for maximum 2 hops
    for (let hop = 0; hop < 2; hop++) {
        const nextLevel = new Map<string, number>();

        for (const [fileId, currentScore] of currentLevel.entries()) {
            const entry = fileMap.get(fileId);
            if (!entry) continue;

            // Collect neighbors from three sources
            const neighbors = new Set<string>();
            for (const imp of entry.importedBy) neighbors.add(imp);
            for (const dep of entry.imports) neighbors.add(dep);
            for (const fn of entry.functions) {
                for (const call of fn.calls) {
                    const path = call.split("::")[0];
                    if (path) neighbors.add(path);
                }
            }

            for (const neighborId of neighbors) {
                if (neighborId === fileId) continue;
                if (!graphFileIds.has(neighborId)) continue;
                if (isNoisePath(neighborId)) continue;
                if (isTestPath(neighborId)) continue; // tests never enter via expansion

                const incomingScore = currentScore * 0.6;
                if (incomingScore < 15) continue; // Skip if incoming score is below 15

                scores.set(neighborId, (scores.get(neighborId) ?? 0) + incomingScore);
                nextLevel.set(neighborId, (nextLevel.get(neighborId) ?? 0) + incomingScore);
            }
        }

        currentLevel = nextLevel;
    }

    // Sort descending and return top MAX_TOTAL_CANDIDATES
    const sorted = Array.from(scores.entries())
        .map(([fileId, score]) => ({ fileId, score }))
        .sort((a, b) => b.score - a.score);

    return sorted.slice(0, MAX_TOTAL_CANDIDATES);
}

// ── Core graph traversal ──────────────────────────────────────────────────────

/**
 * Token-based graph traversal using the RetrievalIndex.
 *
 * Steps:
 *   1. Collect PR-linked files (always included, strongest signal)
 *   2. For each file in the index: check if file path or any function name
 *      matches any token from the intent (pure substring, no scoring)
 *   3. Expand barrel files to their real targets
 *   4. Build seeds list from PR files and keyword matches (after barrel expansion)
 *   5. Run BFS scored expansion
 *   6. Assemble candidate set sorted by score descending
 */
function traverseRetrievalGraph(
    intent: SearchIntent,
    retrieval: RetrievalIndex,
    linkedPRs: LinkedPR[],
    graphFileIds: Set<string>,
): CandidateSet {
    const fileMap = new Map<string, RetrievalFileEntry>();
    for (const f of retrieval.files) {
        fileMap.set(f.fileId, f);
    }

    // ── PR-based files (always included) ──────────────────────────────────────
    const prFileIds = new Set<string>();
    for (const pr of linkedPRs) {
        for (const changedFile of pr.changedFiles) {
            if (graphFileIds.has(changedFile)) {
                prFileIds.add(changedFile);
            }
        }
    }

    // ── BM25 ranked matching (replaces unscored substring OR-match) ───────────
    // Score every file against the issue's typed signals and keep the BEST N
    // (not an arbitrary first N). Tests are ranked like any other file.
    const ranked = rankFiles(intent, retrieval, MAX_DIRECT_CANDIDATES * 3);
    const bm25Score = new Map<string, number>();
    for (const r of ranked) bm25Score.set(r.fileId, r.score);
    const maxBm25 = ranked.length > 0 ? ranked[0].score : 1;

    const cappedMatches = new Set<string>(
        ranked.slice(0, MAX_DIRECT_CANDIDATES).map(r => r.fileId),
    );

    // ── Barrel expansion ──────────────────────────────────────────────────────
    const afterExpansion = expandBarrels(cappedMatches, fileMap);

    // ── Build seed list with priorities: pr (120) > keyword (100) > barrel-expansion (80) ──
    const seedsMap = new Map<string, { score: number; source: CandidateFileEntry["source"] }>();

    // 1. PR files (highest priority)
    for (const fileId of prFileIds) {
        seedsMap.set(fileId, { score: 140, source: "pr" });
    }

    // 2. Keyword-matched files — seed score scaled by BM25 rank (90..130) so the
    //    best lexical matches stay on top through BFS, instead of all tying at 100.
    for (const fileId of cappedMatches) {
        const entry = fileMap.get(fileId);
        if (entry?.isBarrel) continue;
        if (!seedsMap.has(fileId)) {
            const ratio = (bm25Score.get(fileId) ?? 0) / (maxBm25 || 1);
            seedsMap.set(fileId, { score: 90 + ratio * 40, source: "keyword" });
        }
    }

    // 3. Barrel expansion targets
    for (const fileId of afterExpansion) {
        if (!seedsMap.has(fileId)) {
            seedsMap.set(fileId, { score: 70, source: "barrel-expansion" });
        }
    }

    const bfsSeeds = Array.from(seedsMap.entries()).map(([fileId, seed]) => ({
        fileId,
        score: seed.score,
    }));

    // ── Scored BFS Neighborhood expansion ─────────────────────────────────────
    const bfsResults = runBFS(bfsSeeds, fileMap, graphFileIds);

    // ── Assemble candidate set ────────────────────────────────────────────────
    const files: CandidateFileEntry[] = bfsResults.map(res => {
        const seed = seedsMap.get(res.fileId);
        const source = seed ? seed.source : ("neighborhood" as const);
        return {
            fileId: res.fileId,
            source,
            score: res.score,
        };
    });

    return { files, usedRetrievalIndex: true };
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Navigate the RetrievalIndex graph to find candidate files for an issue.
 *
 * This is Stage 1 of the pipeline. Pure token-based traversal, no AI calls.
 * If the issue is vague AND this produces < MIN_CANDIDATES_FOR_STAGE1,
 * the pipeline will invoke Stage 2 (Gemini graph navigation) separately.
 *
 * @param intent       Structured intent from issueUnderstanding.ts
 * @param retrieval    RetrievalIndex loaded from Redis
 * @param linkedPRs    Linked pull requests (strongest signal)
 * @param graphFileIds Set of all fileIds in the visualization graph
 * @returns            Unordered candidate set
 */
export function traverseGraph(
    intent: SearchIntent,
    retrieval: RetrievalIndex,
    linkedPRs: LinkedPR[],
    graphFileIds: Set<string>,
): CandidateSet {
    return traverseRetrievalGraph(intent, retrieval, linkedPRs, graphFileIds);
}

/**
 * Build a compact, one-line-per-file graph map for Gemini Stage 2.
 *
 * Format: "src/resolvers/userResolver.ts: resolve, validate, checkAuth"
 * One line per file. Gemini can read ~1500 file summaries comfortably.
 *
 * Used when Stage 1 produces insufficient candidates and Gemini needs
 * to navigate the graph structure to identify relevant files.
 */
export function buildCompactGraphMap(retrieval: RetrievalIndex): string {
    return retrieval.files
        .filter(f => !f.isBarrel && !isNoisePath(f.fileId) && !isTestPath(f.fileId))
        .map(f => {
            const fnNames = f.functions
                .slice(0, 8) // cap function names per file to keep compact
                .map(fn => fn.name)
                .join(", ");
            return fnNames
                ? `${f.fileId}: ${fnNames}`
                : f.fileId;
        })
        .join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY FALLBACK — backward compatibility for repos without RetrievalIndex
// ─────────────────────────────────────────────────────────────────────────────

/** @deprecated Use traverseGraph() instead when RetrievalIndex is available */
const STOPWORDS = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "must",
    "in", "on", "at", "to", "for", "with", "by", "from", "of", "into",
    "about", "between", "through", "after", "before", "above", "below",
    "and", "or", "but", "not", "no", "nor", "so", "yet",
    "this", "that", "these", "those", "it", "its",
    "i", "we", "you", "he", "she", "they", "me", "us", "him", "her", "them",
    "my", "our", "your", "his", "their",
    "what", "which", "who", "whom", "when", "where", "why", "how",
    "if", "then", "else", "than",
    "just", "also", "very", "too", "quite", "rather",
    "file", "files", "code", "function", "error", "bug", "issue", "fix",
    "please", "help", "problem", "wrong", "broken", "doesn",
]);

/** @deprecated Use traverseGraph() instead when RetrievalIndex is available */
function extractQueryTokens(query: string): string[] {
    const raw = query
        .replace(/[^a-zA-Z0-9_\-./\\@#:]/g, " ")
        .split(/\s+/)
        .filter(t => t.length > 1 && !STOPWORDS.has(t.toLowerCase()));

    const expanded = new Set<string>();
    for (const token of raw) {
        expanded.add(token.toLowerCase());
        if (/^[a-z]+[A-Z][a-zA-Z]*$/.test(token) || /^[A-Z][a-z]+[A-Z][a-zA-Z]*$/.test(token)) {
            const parts = token.replace(/([a-z])([A-Z])/g, "$1 $2").split(" ");
            for (const p of parts) if (p.length > 1) expanded.add(p.toLowerCase());
        }
        if (token.includes("/") || token.includes("\\")) {
            const parts = token.split(/[/\\.]/);
            for (const p of parts) if (p.length > 1) expanded.add(p.toLowerCase());
        }
    }
    return [...expanded];
}

/**
 * Legacy keyword-based issue mapping.
 * Used as fallback when RetrievalIndex is not available.
 *
 * @deprecated Use traverseGraph() instead
 */
export function mapIssueToCode(
    query: string,
    index: SearchIndex,
    maxResults = 10,
): IssueMappingResult {
    const tokens = extractQueryTokens(query);

    if (tokens.length === 0) {
        return { issueText: query, matchedKeywords: [], topFiles: [], topFunctions: [], confidenceScore: 0 };
    }

    const fileResults   = runSearch(index, tokens.join(" "), { type: "file",   limit: maxResults * 2, scoreThreshold: 20 });
    const exportResults = runSearch(index, tokens.join(" "), { type: "export", limit: maxResults * 2, scoreThreshold: 20 });
    const testResults   = runSearch(index, tokens.join(" "), { type: "test",   limit: maxResults,     scoreThreshold: 20 });

    const candidateFileMap = new Map<string, { score: number; reasons: string[] }>();

    for (const r of fileResults) {
        const existing = candidateFileMap.get(r.entry.filePath) ?? { score: 0, reasons: [] };
        existing.score += r.score;
        existing.reasons.push(`file match: "${r.matchedTokens.join(", ")}" (+${Math.round(r.score)})`);
        candidateFileMap.set(r.entry.filePath, existing);
    }

    const candidateFunctionMap = new Map<string, { filePath: string; score: number; reasons: string[] }>();

    for (const r of exportResults) {
        const funcId = r.entry.id;
        const existing = candidateFunctionMap.get(funcId) ?? { filePath: r.entry.filePath, score: 0, reasons: [] };
        existing.score += r.score;
        existing.reasons.push(`export match: "${r.entry.name}" (+${Math.round(r.score)})`);
        candidateFunctionMap.set(funcId, existing);

        const fExisting = candidateFileMap.get(r.entry.filePath) ?? { score: 0, reasons: [] };
        fExisting.score += r.score * 0.8;
        fExisting.reasons.push(`contains matching export "${r.entry.name}" (+${Math.round(r.score * 0.8)})`);
        candidateFileMap.set(r.entry.filePath, fExisting);
    }

    for (const r of testResults) {
        const existing = candidateFileMap.get(r.entry.filePath) ?? { score: 0, reasons: [] };
        existing.score += r.score * 0.5;
        existing.reasons.push(`test coverage match: "${r.entry.name}" (+${Math.round(r.score * 0.5)})`);
        candidateFileMap.set(r.entry.filePath, existing);
    }

    const topFiles: CandidateFile[] = [...candidateFileMap.entries()]
        .map(([filePath, data]) => ({ filePath, score: Math.min(100, Math.round(data.score)), matchedReasons: data.reasons }))
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults);

    const topFunctions: CandidateFunction[] = [...candidateFunctionMap.entries()]
        .map(([functionId, data]) => ({ functionId, filePath: data.filePath, score: Math.min(100, Math.round(data.score)), matchedReasons: data.reasons }))
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults);

    let confidenceScore = 0;
    if (topFiles.length > 0) confidenceScore = topFiles[0].score;
    if (topFunctions.length > 0 && topFunctions[0].score > confidenceScore) confidenceScore = topFunctions[0].score;

    return { issueText: query, matchedKeywords: tokens, topFiles, topFunctions, confidenceScore };
}

/**
 * Builds a SearchIndex from a file list (legacy inline fallback).
 *
 * @deprecated Use traverseGraph() instead
 */
export function buildInlineSearchIndex(
    files: Array<{ id: string; label: string; architecturalImportance?: number }>,
): SearchIndex {
    const entries: SearchIndexEntry[] = files.map(f => {
        const pathTokens = f.id.replace(/[^a-zA-Z0-9]/g, " ").split(/\s+/).filter(t => t.length > 1).map(t => t.toLowerCase());
        const labelTokens = f.label.replace(/[^a-zA-Z0-9]/g, " ").split(/\s+/).filter(t => t.length > 1).map(t => t.toLowerCase());
        const tokens = [...new Set([...pathTokens, ...labelTokens])];
        return { id: f.id, type: "file" as const, name: f.label, filePath: f.id, tokens, hubScore: f.architecturalImportance ?? 0 };
    });
    return { entries, generatedAt: new Date().toISOString() };
}
