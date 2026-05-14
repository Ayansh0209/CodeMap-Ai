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
function isNoisePath(fileId: string): boolean {
    const lower = fileId.toLowerCase();

    // TypeScript declaration files — zero behavior
    if (lower.endsWith(".d.ts")) return true;

    // Auto-generated documentation
    if (lower.includes("/auto-docs/") || lower.includes("/auto-schema/")) return true;

    // Test files — only allowed via PR, not via token match
    if (/\.(test|spec)\.(ts|js|tsx|jsx)$/i.test(lower)) return true;
    if (/\/__tests?__\//i.test(lower)) return true;
    if (/\/test\//i.test(lower)) return true;

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

// ── Neighborhood expansion ────────────────────────────────────────────────────

/**
 * Add one-hop neighbors (importedBy + imports) for each candidate file.
 *
 * Reasoning: the bug might be in a file that imports the matched file,
 * or in a dependency the matched file relies on.
 *
 * Filters out noise paths (test files, declarations) from neighborhood.
 */
function addNeighborhood(
    directCandidates: Set<string>,
    fileMap: Map<string, RetrievalFileEntry>,
    maxToAdd: number,
): Set<string> {
    const result = new Set<string>(directCandidates);
    let added = 0;

    for (const fileId of directCandidates) {
        if (added >= maxToAdd) break;
        const entry = fileMap.get(fileId);
        if (!entry) continue;

        // importedBy: files that call INTO our candidate
        for (const importer of entry.importedBy.slice(0, 3)) {
            if (!result.has(importer) && added < maxToAdd && !isNoisePath(importer)) {
                result.add(importer);
                added++;
            }
        }

        // imports: dependencies this candidate relies on
        for (const dep of entry.imports.slice(0, 2)) {
            if (!result.has(dep) && added < maxToAdd && !isNoisePath(dep)) {
                result.add(dep);
                added++;
            }
        }
    }

    return result;
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
 *   4. Add one-hop neighborhood (importedBy + imports)
 *   5. Assemble unordered candidate set
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

    // ── Token-based traversal ─────────────────────────────────────────────────
    const tokens = intent.entities;
    const matchedFileIds = new Set<string>();

    for (const fileEntry of retrieval.files) {
        // Skip noise paths
        if (isNoisePath(fileEntry.fileId)) continue;

        // Check file path against tokens
        if (matchesAnyToken(fileEntry.fileId, tokens)) {
            matchedFileIds.add(fileEntry.fileId);
            continue;
        }

        // Check function names against tokens
        for (const fn of fileEntry.functions) {
            if (matchesAnyToken(fn.name, tokens)) {
                matchedFileIds.add(fileEntry.fileId);
                break; // one match is enough to include the file
            }
        }
    }

    // Cap direct matches
    const cappedMatches = new Set<string>(
        [...matchedFileIds].slice(0, MAX_DIRECT_CANDIDATES)
    );

    // ── Barrel expansion ──────────────────────────────────────────────────────
    const afterExpansion = expandBarrels(cappedMatches, fileMap);

    // ── Neighborhood expansion ────────────────────────────────────────────────
    const maxNeighbors = MAX_TOTAL_CANDIDATES - prFileIds.size - afterExpansion.size;
    const withNeighborhood = addNeighborhood(afterExpansion, fileMap, Math.max(0, maxNeighbors));

    // ── Assemble candidate set ────────────────────────────────────────────────
    const files: CandidateFileEntry[] = [];
    const seen = new Set<string>();

    // PR files first
    for (const fileId of prFileIds) {
        if (!seen.has(fileId)) {
            files.push({ fileId, source: "pr" });
            seen.add(fileId);
        }
    }

    // Direct keyword matches (excluding barrels that were expanded)
    for (const fileId of cappedMatches) {
        if (seen.has(fileId)) continue;
        const entry = fileMap.get(fileId);
        if (entry?.isBarrel) continue;
        files.push({ fileId, source: "keyword" });
        seen.add(fileId);
    }

    // Barrel expansion targets
    for (const fileId of afterExpansion) {
        if (seen.has(fileId)) continue;
        if (!cappedMatches.has(fileId)) {
            files.push({ fileId, source: "barrel-expansion" });
            seen.add(fileId);
        }
    }

    // Neighborhood files
    for (const fileId of withNeighborhood) {
        if (seen.has(fileId)) continue;
        files.push({ fileId, source: "neighborhood" });
        seen.add(fileId);
    }

    return { files: files.slice(0, MAX_TOTAL_CANDIDATES), usedRetrievalIndex: true };
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
        .filter(f => !f.isBarrel && !isNoisePath(f.fileId))
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
