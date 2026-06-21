// src/parser/lexicalRanker.ts
// ─────────────────────────────────────────────────────────────────────────────
// Deterministic BM25 lexical ranker for issue → file candidate selection.
//
// WHY:
//   The old matcher did `path.includes(token)` with OR semantics, treated every
//   hit as equal, then kept an ARBITRARY first 15. That produced noise (`call`
//   matching `call.h`) and dropped the real file. This module scores every file
//   against the issue's typed signals and returns a RANKED list, so the best
//   files float to the top and we keep the best N (not a random N).
//
// HOW (plain terms):
//   - Each file becomes a small "document": the words in its path + filename
//     (filename counted extra because it's the strongest hint) + its function
//     and structure names, all split on camelCase and lowercased.
//   - The issue becomes a weighted query: exact file paths (huge), strong code
//     identifiers like `createEvent` (high), plain words like "output" (low).
//   - BM25 scores how well each file's document matches the query, rewarding
//     rare/specific words and not over-rewarding long files.
//   - Files whose path literally matches a path mentioned in the issue get a big
//     direct bonus on top.
//
//   Matching is on WHOLE tokens (after camelCase splitting), never raw substring,
//   so "call" no longer matches "recall"/"callback".
// ─────────────────────────────────────────────────────────────────────────────

import type { RetrievalIndex, RetrievalFileEntry } from "../models/retrieval";
import type { SearchIntent } from "./issueUnderstanding";
import { isNoisePath } from "./issueMapper";

// ── Tuning ────────────────────────────────────────────────────────────────────

const BM25_K1 = 1.2;
const BM25_B = 0.75;

/** Query-term weights by signal type. */
const WEIGHT_STRONG = 3.0;   // `createEvent`, AgendaItem
const WEIGHT_WEAK = 1.0;     // "output", "query"

/** Filename tokens are repeated this many times in the document (extra weight). */
const FILENAME_BOOST = 3;

/** Direct additive bonus when a file path matches a path mentioned in the issue. */
const EXACT_PATH_BONUS = 50;
const BASENAME_BONUS = 25;

export interface RankedFile {
    fileId: string;
    score: number;
}

// ── Tokenization (matches issueUnderstanding's camelCase handling) ────────────

function splitTokens(text: string): string[] {
    return text
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")  // camelCase → camel Case
        .replace(/[^a-zA-Z0-9]/g, " ")           // path seps, dots, etc → space
        .toLowerCase()
        .split(/\s+/)
        .filter(t => t.length > 1);
}

/** Build the searchable document tokens for one file. */
function fileDocument(f: RetrievalFileEntry): string[] {
    const tokens: string[] = [];

    // Path tokens (directories give domain context)
    tokens.push(...splitTokens(f.fileId));

    // Filename tokens repeated — the filename is the single strongest hint
    const base = f.fileId.split("/").pop() ?? f.fileId;
    const baseNoExt = base.replace(/\.[^.]+$/, "");
    for (let i = 0; i < FILENAME_BOOST; i++) tokens.push(...splitTokens(baseNoExt));

    // Function names + structure (type/interface/enum) names
    for (const fn of f.functions) tokens.push(...splitTokens(fn.name));
    for (const st of f.structures ?? []) tokens.push(...splitTokens(st.name));

    return tokens;
}

// ── Weighted query terms ──────────────────────────────────────────────────────

interface QueryTerm {
    token: string;
    weight: number;
}

function buildQueryTerms(intent: SearchIntent): QueryTerm[] {
    const weightByToken = new Map<string, number>();

    const add = (raw: string, weight: number) => {
        for (const t of splitTokens(raw)) {
            // Keep the strongest weight seen for a token
            weightByToken.set(t, Math.max(weightByToken.get(t) ?? 0, weight));
        }
    };

    for (const id of intent.strongIdentifiers) add(id, WEIGHT_STRONG);
    for (const term of intent.weakTerms) add(term, WEIGHT_WEAK);
    // Fallback: if typed buckets are empty (older callers), use entities as weak.
    if (weightByToken.size === 0) for (const e of intent.entities) add(e, WEIGHT_WEAK);

    return [...weightByToken.entries()].map(([token, weight]) => ({ token, weight }));
}

// ── Exact-path bonus ──────────────────────────────────────────────────────────

function exactPathBonus(fileId: string, exactPaths: string[]): number {
    if (exactPaths.length === 0) return 0;
    const lower = fileId.toLowerCase();
    const base = lower.split("/").pop() ?? lower;
    let bonus = 0;
    for (const p of exactPaths) {
        if (lower === p || lower.endsWith("/" + p) || lower.endsWith(p)) {
            bonus = Math.max(bonus, EXACT_PATH_BONUS);
        } else if (base === p || base === p.split("/").pop()) {
            bonus = Math.max(bonus, BASENAME_BONUS);
        }
    }
    return bonus;
}

// ── Main: BM25 ranking ────────────────────────────────────────────────────────

/**
 * Rank all (non-noise) files in the index against the issue intent.
 *
 * @param intent     Typed SearchIntent (exactPaths / strongIdentifiers / weakTerms)
 * @param retrieval  The repo's RetrievalIndex
 * @param limit      Max ranked files to return
 * @returns          Files sorted by score descending (score > 0 only)
 */
export function rankFiles(
    intent: SearchIntent,
    retrieval: RetrievalIndex,
    limit = 40,
): RankedFile[] {
    const queryTerms = buildQueryTerms(intent);

    // Build documents + document frequencies (skip noise files)
    const docs: Array<{ fileId: string; tf: Map<string, number>; len: number }> = [];
    const df = new Map<string, number>();
    let totalLen = 0;

    for (const f of retrieval.files) {
        if (isNoisePath(f.fileId)) continue;
        const tokens = fileDocument(f);
        const tf = new Map<string, number>();
        for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
        docs.push({ fileId: f.fileId, tf, len: tokens.length });
        totalLen += tokens.length;
        for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    }

    const N = docs.length || 1;
    const avgdl = totalLen / N || 1;

    // Precompute idf per query term
    const idf = new Map<string, number>();
    for (const { token } of queryTerms) {
        const n = df.get(token) ?? 0;
        // BM25 idf with +1 to stay positive even for very common terms
        idf.set(token, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
    }

    const results: RankedFile[] = [];
    for (const doc of docs) {
        let score = 0;
        for (const { token, weight } of queryTerms) {
            const tf = doc.tf.get(token);
            if (!tf) continue;
            const idfT = idf.get(token) ?? 0;
            const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.len / avgdl));
            score += weight * idfT * ((tf * (BM25_K1 + 1)) / denom);
        }
        score += exactPathBonus(doc.fileId, intent.exactPaths);
        if (score > 0) results.push({ fileId: doc.fileId, score });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
}
