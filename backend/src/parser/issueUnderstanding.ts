// src/parser/issueUnderstanding.ts
// ─────────────────────────────────────────────────────────────────────────────
// Extracts structured search tokens from raw issue text.
//
// This module is PURELY DETERMINISTIC — no AI calls, no external dependencies,
// no async operations. It takes raw text and returns a SearchIntent that the
// rest of the pipeline uses to find candidate files via substring matching.
//
// Phase 3 redesign:
//   Removed all domain-specific heuristics (AUTH_CONCEPTS, DATA_CONCEPTS,
//   OPERATION_KEYWORDS, intentHasAuthSignal, intentHasDataSignal, concepts).
//   The module now extracts only two things:
//     1. entities[] — code identifiers + plain nouns from the issue text
//     2. isVague — true when extraction yields insufficient signal
//
//   No domain classification. No concept categories. No weighted scoring.
//   Gemini decides what matters — this module only tokenizes.
// ─────────────────────────────────────────────────────────────────────────────

// ── Output type ───────────────────────────────────────────────────────────────

export interface SearchIntent {
    /**
     * All meaningful tokens extracted from the issue text.
     * Includes camelCase/PascalCase identifiers, backtick-quoted names,
     * and plain nouns after stopword removal.
     *
     * These are used for pure substring matching against file paths and
     * function names in the RetrievalIndex. No scoring, no weighting.
     */
    entities: string[];

    /**
     * True when extraction yields insufficient signal for graph traversal.
     *
     * Vague = fewer than 2 meaningful tokens AND no camelCase/PascalCase
     * identifiers were found in the issue text.
     *
     * When isVague=true, the pipeline routes to Stage 2 where Gemini
     * reads the issue + a compact graph map to identify which files
     * to examine, rather than relying on token-based traversal.
     */
    isVague: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Words that provide no retrieval signal.
 * Covers common English stopwords + developer jargon that appears in every issue.
 */
const STOPWORDS = new Set([
    // Common English
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
    "just", "also", "very", "too", "quite", "rather", "still", "already",
    // Issue/developer noise that appears in virtually every bug report
    "please", "help", "problem", "wrong", "broken", "working", "work",
    "issue", "bug", "fix", "error", "currently", "expected", "actual",
    "steps", "reproduce", "description", "version", "using", "see",
    "getting", "seems", "happens", "shows", "showing", "displayed",
    "screenshot", "following", "above", "behavior", "behaviour",
    "feature", "request", "functionality", "pretty", "nice", "good",
    "want", "need", "make", "click", "button", "page", "screen",
]);

/**
 * Minimum number of meaningful entities required for a "specific" issue.
 *
 * Reasoning: a useful graph traversal needs at least 2 tokens to narrow
 * the candidate set. With only 1 token (e.g. "button"), the search
 * space is too broad and we're better off letting Gemini read the full issue.
 */
const MIN_ENTITIES_FOR_SPECIFIC = 2;

// ── Tokenization ──────────────────────────────────────────────────────────────

/**
 * Tokenize raw text into normalized lowercase words.
 * Handles camelCase splitting, path separators, and common punctuation.
 */
function tokenize(text: string): string[] {
    const normalized = text
        // Split camelCase: "agendaItem" → "agenda Item"
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        // Replace non-alphanumeric (except apostrophes in contractions) with space
        .replace(/[^a-zA-Z0-9']/g, " ")
        // Collapse multiple spaces
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

    return normalized.split(" ").filter(t => t.length > 2 && !STOPWORDS.has(t));
}

/**
 * Extract camelCase and PascalCase identifiers from code snippets in issue text.
 *
 * These are the HIGHEST signal tokens because they match actual code names:
 *   - `createEvent` → matches createEvent function
 *   - `AgendaItem` → matches AgendaItem type/class
 *   - `checkPasswordChangeRateLimit` → matches the exact function
 *
 * Sources:
 *   1. Backtick-quoted identifiers: `functionName`, `EventAgendaItem`
 *   2. Inline camelCase/PascalCase words in the body text
 */
function extractCodeIdentifiers(text: string): string[] {
    const identifiers: string[] = [];

    // Match backtick-quoted identifiers: `functionName`, `EventAgendaItem`
    const backtickMatches = text.matchAll(/`([a-zA-Z_$][a-zA-Z0-9_$]+)`/g);
    for (const match of backtickMatches) {
        const id = match[1];
        // Keep the full identifier AND its camelCase parts
        const parts = id
            .replace(/([a-z])([A-Z])/g, "$1 $2")
            .split(" ")
            .map(p => p.toLowerCase())
            .filter(p => p.length > 2 && !STOPWORDS.has(p));
        identifiers.push(...parts, id.toLowerCase());
    }

    // Match PascalCase/camelCase words in the text (likely type/function names)
    const camelMatches = text.matchAll(/\b([A-Z][a-z]+(?:[A-Z][a-z]*)+|[a-z]+(?:[A-Z][a-z]*)+)\b/g);
    for (const match of camelMatches) {
        const id = match[1];
        const parts = id
            .replace(/([a-z])([A-Z])/g, "$1 $2")
            .split(" ")
            .map(p => p.toLowerCase())
            .filter(p => p.length > 2 && !STOPWORDS.has(p));
        identifiers.push(...parts);
    }

    return [...new Set(identifiers)];
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Extract structured search intent from raw issue text.
 *
 * Combines the issue title, body, and up to 5 comments into a single text
 * block for analysis. Comments are included because developers often describe
 * the root cause in comments, not in the original issue body.
 *
 * @param title    Issue title
 * @param body     Issue body (markdown)
 * @param comments Array of comment bodies (pass [] if not available)
 * @returns SearchIntent with entities and isVague flag
 */
export function extractSearchIntent(
    title: string,
    body: string,
    comments: string[] = [],
): SearchIntent {
    // Combine all text — title gets double weight by including it twice
    // since titles are the most concise description of the issue
    const fullText = [title, title, body, ...comments.slice(0, 5)].join(" ");

    // ── Step 1: Extract tokens ────────────────────────────────────────────────
    const tokens = tokenize(fullText);
    const codeIdentifiers = extractCodeIdentifiers(fullText);

    // Merge and deduplicate
    const entities = [...new Set([...codeIdentifiers, ...tokens])];

    // ── Step 2: Determine vagueness ───────────────────────────────────────────
    //
    // An issue is vague when:
    //   - Fewer than MIN_ENTITIES_FOR_SPECIFIC meaningful tokens, AND
    //   - No camelCase/PascalCase identifiers found (zero code-level signal)
    //
    // Note: a short issue like "Event creators cannot delete their own events"
    // is NOT vague — it has clear entities. Vagueness is about semantic density,
    // not word count.
    const isVague = entities.length < MIN_ENTITIES_FOR_SPECIFIC && codeIdentifiers.length === 0;

    // Cap at 20 to keep traversal focused — more than 20 tokens
    // produces a search space too wide to be useful
    const finalEntities = entities.slice(0, 20);

    return {
        entities: finalEntities,
        isVague,
    };
}
