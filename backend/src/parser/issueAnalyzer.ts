// src/parser/issueAnalyzer.ts
// ─────────────────────────────────────────────────────────────────────────────
// Gemini API calls for issue mapping, graph navigation, and chat.
//
// Phase 3 redesign:
//   - callGeminiForMapping() now supports iterative rounds:
//     Round 1: asks Gemini "are you confident, or do you need more files?"
//     Round 2: forced final answer with additional context
//   - Added callGeminiForGraphNavigation() for Stage 2:
//     sends compact graph map to Gemini, receives file paths to examine
//   - Removed legacy overloads (no more files[] backward compat)
//   - callGeminiForChatStream() — untouched
// ─────────────────────────────────────────────────────────────────────────────

import { VertexAI } from "@google-cloud/vertexai";
import { config } from "../config/config";
import type { IssueComment, LinkedPR } from "../github/issueClient";
import type { CodeSnippet } from "./snippetFetcher";
import * as fs from "fs";
import * as path from "path";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AffectedFile {
    fileId: string;
    confidence: number;   // 0-100
    reason: string;
}

export interface GeminiMappingResult {
    affectedFiles: AffectedFile[];
    summary: string;
    fixApproach: string;
}

/** Round 1 can return either a final answer or a request for more files */
export interface GeminiRound1Response {
    /** If true, Gemini wants more files before giving a final answer */
    needsMoreContext: boolean;
    /** File paths Gemini wants to examine (only when needsMoreContext=true) */
    requestedFiles: string[];
    /** Reason for needing more context (only when needsMoreContext=true) */
    reason: string;
    /** Final answer (only when needsMoreContext=false) */
    affectedFiles: AffectedFile[];
    summary: string;
    fixApproach: string;
}

export interface GeminiFixResult {
    explanation: string;
    replacementBlocks: Array<{
        fileId: string;
        original: string;
        replacement: string;
        lineHint?: number;
    }>;
}

export interface IssueContextInput {
    title: string;
    body: string;
    comments: IssueComment[];
    linkedPRs: LinkedPR[];
}

// ── Client ────────────────────────────────────────────────────────────────────

let vertexClient: VertexAI | null = null;
function getClient(): VertexAI | null {
    let project = config.gcp.projectId || process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
    const location = config.gcp.location || process.env.GCP_LOCATION || process.env.GOOGLE_CLOUD_LOCATION || "us-central1";

    let googleAuthOptions: any = undefined;

    // Check for direct JSON credentials in environment variable first
    if (process.env.GCP_SA_KEY) {
        try {
            const apiConfig = JSON.parse(process.env.GCP_SA_KEY);
            if (apiConfig.project_id && !project) {
                project = apiConfig.project_id;
            }
            googleAuthOptions = {
                credentials: apiConfig
            };
        } catch (e) {
            console.error("Failed to parse GCP_SA_KEY in issueAnalyzer:", e);
        }
    } else {
        // Fallback to local api.json
        const apiJsonPath = path.join(process.cwd(), "api.json");
        if (fs.existsSync(apiJsonPath)) {
            try {
                const apiConfig = JSON.parse(fs.readFileSync(apiJsonPath, "utf8"));
                if (apiConfig.project_id && !project) {
                    project = apiConfig.project_id;
                }
                googleAuthOptions = {
                    keyFilename: apiJsonPath
                };
            } catch (e) {
                console.error("Failed to parse api.json in issueAnalyzer:", e);
            }
        }
    }

    if (!project) return null;
    if (!vertexClient) {
        vertexClient = new VertexAI({ 
            project, 
            location,
            googleAuthOptions
        });
    }
    return vertexClient;
}

function getText(res: any): string {
    if (res.text && typeof res.text === "function") {
        try {
            return res.text();
        } catch (e) {}
    }
    return res.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// ── Logging ───────────────────────────────────────────────────────────────────

function logUsage(operation: string, usage: any, prompt: string, response: string) {
    if (!usage) return;
    const { promptTokenCount, candidatesTokenCount } = usage;
    const cost = (promptTokenCount * 0.000000075) + (candidatesTokenCount * 0.0000003);
}

// ── Snippet formatter ─────────────────────────────────────────────────────────

/**
 * Format code snippets into a structured prompt section.
 * Each snippet is presented with file path, function name, and source signals.
 */
function formatSnippetsForPrompt(snippets: CodeSnippet[]): string {
    if (snippets.length === 0) {
        return "(No code snippets available — analyze based on issue text only)";
    }

    return snippets.map((s, i) => {
        const header = [
            `--- Snippet ${i + 1} ---`,
            `File: ${s.fileId}`,
            `Function: ${s.functionName} (lines ${s.startLine}-${s.endLine})`,
        ].join("\n");

        return `${header}\n\`\`\`\n${s.body}\n\`\`\``;
    }).join("\n\n");
}

// ── Stage 2: Gemini graph navigation ──────────────────────────────────────────

/**
 * Ask Gemini to navigate the graph structure and identify files to examine.
 *
 * Used in Stage 2 when Stage 1 token traversal produces insufficient candidates.
 * Sends Gemini the issue text + a compact graph map (one line per file with
 * function names). Gemini returns which files it wants to read.
 *
 * @param issue     Issue context
 * @param graphMap  Compact graph map (from buildCompactGraphMap())
 * @returns         List of file paths Gemini wants to examine
 */
export async function callGeminiForGraphNavigation(
    issue: IssueContextInput,
    graphMap: string,
): Promise<string[]> {
    const client = getClient();
    if (!client) return [];

    const model = client.getGenerativeModel({
        model: "gemini-2.5-pro",
        generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
        },
    });

    const commentText = issue.comments.slice(0, 5)
        .map(c => `${c.author}: ${c.body.slice(0, 300)}`)
        .join("\n");

    const prompt = `You are a senior software engineer. You need to identify which source files are likely involved in a bug or feature request.

You do NOT have the source code yet. You have the issue description and a map of the entire codebase showing file paths and function names.

═══════════════════════════════════════════════
ISSUE
═══════════════════════════════════════════════
Title: ${issue.title}

Body:
${issue.body.slice(0, 2000)}

${commentText ? `Discussion:\n${commentText}\n` : ""}
═══════════════════════════════════════════════
CODEBASE MAP (file path: function names)
═══════════════════════════════════════════════
${graphMap}

═══════════════════════════════════════════════
INSTRUCTIONS
═══════════════════════════════════════════════
Based on the issue and the codebase map above, identify which files you would need to read to diagnose this issue.

Think about:
- Which function names look related to the issue?
- Which file paths suggest relevant domain areas?
- Which files likely contain the entry points for the described behavior?

Return JSON:
{
  "requestedFiles": ["<exact file path from the map>", "..."],
  "reasoning": "<1-2 sentences explaining why you chose these files>"
}

IMPORTANT:
- Return 5-15 file paths — enough to cover the issue, not so many it's noise
- Only return file paths that appear in the CODEBASE MAP above
- Prefer files with function names that semantically match the issue
`;

    try {
        const result = await model.generateContent(prompt);
        const res = await result.response;
        const text = getText(res);
        logUsage("graph-navigation", res.usageMetadata, prompt, text);

        const parsed = JSON.parse(text);
        const files = (parsed.requestedFiles ?? [])
            .filter((f: unknown): f is string => typeof f === "string")
            .slice(0, 15);
        return files;
    } catch (err) {
        console.error("\x1b[31m[issueAnalyzer] Graph navigation failed:\x1b[0m", err);
        return [];
    }
}

// ── Stage 3: Gemini mapping (iterative) ───────────────────────────────────────

/**
 * Call Gemini to map an issue to affected files by reasoning over actual code.
 *
 * Phase 3 redesign:
 *   Round 1: Gemini reads code snippets and either:
 *     a) Returns a final answer (needsMoreContext=false)
 *     b) Requests additional files (needsMoreContext=true)
 *
 *   Round 2: Called with additional snippets, Gemini gives a final answer.
 *
 * @param issue     Issue context
 * @param snippets  Code snippets (actual function bodies)
 * @param linkedPRs Linked PRs for context
 * @param round     1 or 2 (default 1)
 * @returns         Round 1: GeminiRound1Response (may request more files)
 *                  Round 2: GeminiMappingResult (always final answer)
 */
export async function callGeminiForMappingRound1(
    issue: IssueContextInput,
    snippets: CodeSnippet[],
    linkedPRs: LinkedPR[],
): Promise<GeminiRound1Response | null> {
    const client = getClient();
    if (!client) return null;

    const model = client.getGenerativeModel({
        model: "gemini-2.5-pro",
        generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
        },
    });

    const commentText = issue.comments.slice(0, 5)
        .map(c => `${c.author}: ${c.body.slice(0, 300)}`)
        .join("\n");

    const prContext = linkedPRs.length > 0
        ? linkedPRs.map(pr =>
            `PR #${pr.number} (${pr.state}${pr.merged ? ", merged" : ""}): ${pr.title}\n` +
            `Changed files: ${pr.changedFiles.slice(0, 10).join(", ")}`
          ).join("\n")
        : "No linked pull requests.";

    const snippetSection = formatSnippetsForPrompt(snippets);

    const prompt = `You are a senior software engineer performing a code review to identify which files and functions are involved in a bug or feature request.

You have been given actual source code snippets from the repository. Read the code carefully.

═══════════════════════════════════════════════
ISSUE
═══════════════════════════════════════════════
Title: ${issue.title}

Body:
${issue.body.slice(0, 2000)}

${commentText ? `Discussion:\n${commentText}\n` : ""}
${prContext !== "No linked pull requests." ? `\nLinked PRs:\n${prContext}\n` : ""}
═══════════════════════════════════════════════
CODE SNIPPETS
═══════════════════════════════════════════════
${snippetSection}

═══════════════════════════════════════════════
INSTRUCTIONS
═══════════════════════════════════════════════
Based on the issue and the code snippets above, provide your analysis. The default expected response is Option A (final answer). Option B (needsMoreContext: true) must only be chosen if a file that is absolutely critical to understanding the issue is completely missing from the provided snippets — not just because more context would be nice.

If you have any reasonable basis to identify affected files from what you have, always choose Option A.

OPTION A — Final Answer (Default Expected Response):
Choose this if you have a reasonable basis to identify affected files.
Return JSON:
{
  "needsMoreContext": false,
  "requestedFiles": [],
  "reason": "",
  "affectedFiles": [
    {
      "fileId": "<exact file path from the snippets above>",
      "confidence": <0-100>,
      "reason": "<1-2 sentences: what you read in the code and why it matters>"
    }
  ],
  "summary": "<2-3 sentences about the issue based on the code>",
  "fixApproach": "<2-3 sentences on what needs to change>"
}

OPTION B — Request Additional Files:
Choose this ONLY if a file that is absolutely critical to understanding the issue is completely missing from the provided snippets.
Return JSON:
{
  "needsMoreContext": true,
  "requestedFiles": ["<file path you want to see>", "..."],
  "reason": "<1 sentence explaining what you need to see and why>",
  "affectedFiles": [],
  "summary": "",
  "fixApproach": ""
}

IMPORTANT:
- If you have any reasonable basis to identify affected files from what you have, always choose Option A.
- Only request more files if the snippets truly are insufficient to provide any initial analysis.
- Confidence 90+ means you can point to specific lines
- Confidence 50-70 means you're in the right area but want more context
- Only include files from the snippets in affectedFiles
`;

    try {
        const result = await model.generateContent(prompt);
        const res = await result.response;
        const text = getText(res);
        logUsage("mapping-round1", res.usageMetadata, prompt, text);

        const parsed = JSON.parse(text);
        return {
            needsMoreContext: Boolean(parsed.needsMoreContext),
            requestedFiles: (parsed.requestedFiles ?? []).filter((f: unknown): f is string => typeof f === "string"),
            reason: String(parsed.reason || ""),
            affectedFiles: (parsed.affectedFiles ?? []).map((f: any) => ({
                fileId: String(f.fileId),
                confidence: Number(f.confidence) || 50,
                reason: String(f.reason || ""),
            })),
            summary: String(parsed.summary || ""),
            fixApproach: String(parsed.fixApproach || ""),
        };
    } catch (err) {
        console.error("\x1b[31m[issueAnalyzer] Round 1 mapping failed:\x1b[0m", err);
        return null;
    }
}

/**
 * Round 2: Gemini gives a final answer with additional context.
 * No more iteration — this is always the last call.
 */
export async function callGeminiForMappingFinal(
    issue: IssueContextInput,
    allSnippets: CodeSnippet[],
    linkedPRs: LinkedPR[],
): Promise<GeminiMappingResult | null> {
    const client = getClient();
    if (!client) return null;

    const model = client.getGenerativeModel({
        model: "gemini-2.5-pro",
        generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
        },
    });

    const commentText = issue.comments.slice(0, 5)
        .map(c => `${c.author}: ${c.body.slice(0, 300)}`)
        .join("\n");

    const prContext = linkedPRs.length > 0
        ? linkedPRs.map(pr =>
            `PR #${pr.number} (${pr.state}${pr.merged ? ", merged" : ""}): ${pr.title}\n` +
            `Changed files: ${pr.changedFiles.slice(0, 10).join(", ")}`
          ).join("\n")
        : "No linked pull requests.";

    const snippetSection = formatSnippetsForPrompt(allSnippets);

    const prompt = `You are a senior software engineer. This is your FINAL analysis.

You previously requested additional files. Here is ALL the code you have asked for, plus the original snippets.

═══════════════════════════════════════════════
ISSUE
═══════════════════════════════════════════════
Title: ${issue.title}

Body:
${issue.body.slice(0, 2000)}

${commentText ? `Discussion:\n${commentText}\n` : ""}
${prContext !== "No linked pull requests." ? `\nLinked PRs:\n${prContext}\n` : ""}
═══════════════════════════════════════════════
ALL CODE SNIPPETS
═══════════════════════════════════════════════
${snippetSection}

═══════════════════════════════════════════════
INSTRUCTIONS
═══════════════════════════════════════════════
Return your FINAL answer. Identify the affected files with reasoning grounded in the code.

Return JSON:
{
  "affectedFiles": [
    {
      "fileId": "<exact file path>",
      "confidence": <0-100>,
      "reason": "<1-2 sentences based on the code you read>"
    }
  ],
  "summary": "<2-3 sentences about the issue>",
  "fixApproach": "<2-3 sentences on what needs to change>"
}
`;

    try {
        const result = await model.generateContent(prompt);
        const res = await result.response;
        const text = getText(res);
        logUsage("mapping-final", res.usageMetadata, prompt, text);

        const parsed = JSON.parse(text);
        return {
            affectedFiles: (parsed.affectedFiles ?? []).map((f: any) => ({
                fileId: String(f.fileId),
                confidence: Number(f.confidence) || 50,
                reason: String(f.reason || ""),
            })),
            summary: String(parsed.summary || ""),
            fixApproach: String(parsed.fixApproach || ""),
        };
    } catch (err) {
        console.error("\x1b[31m[issueAnalyzer] Final mapping failed:\x1b[0m", err);
        return null;
    }
}

// ── Legacy compat wrapper ─────────────────────────────────────────────────────

/**
 * Backward-compatible wrapper used by the legacy pipeline path.
 * Calls Round 1 and if it gets a final answer, returns it.
 * If Round 1 requests more context, returns what it has (no round 2 in legacy).
 */
export async function callGeminiForMapping(
    issue: IssueContextInput,
    snippets: CodeSnippet[],
    linkedPRs: LinkedPR[],
): Promise<GeminiMappingResult | null> {
    const round1 = await callGeminiForMappingRound1(issue, snippets, linkedPRs);
    if (!round1) return null;

    return {
        affectedFiles: round1.affectedFiles,
        summary: round1.summary,
        fixApproach: round1.fixApproach,
    };
}

// ── Chat ──────────────────────────────────────────────────────────────────────

export async function callGeminiForChatStream(
    systemInstruction: string,
    messages: Array<{ role: string; content: string }>
) {
    const client = getClient();
    if (!client) throw new Error("Vertex AI client could not be initialized. Please check GCP configuration.");

    const model = client.getGenerativeModel({
        model: "gemini-2.5-pro",
        systemInstruction: {
            role: "system",
            parts: [{ text: systemInstruction }]
        },
        generationConfig: { temperature: 0.2 },
    });

    // MAP ROLES: Gemini only accepts "user" and "model"
    const history = messages.slice(0, -1).map(m => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }]
    }));
    
    const lastMessage = messages[messages.length - 1].content;
    const chat = model.startChat({ history });
    const responseStream = await chat.sendMessageStream(lastMessage);

    // Wrap the stream to add a text() helper to each chunk for compatibility with the routes
    const wrappedStream = (async function* () {
        for await (const chunk of responseStream.stream) {
            yield {
                ...chunk,
                text: () => chunk.candidates?.[0]?.content?.parts?.[0]?.text || ""
            };
        }
    })();

    const wrappedResponse = responseStream.response.then(res => ({
        ...res,
        text: () => res.candidates?.[0]?.content?.parts?.[0]?.text || ""
    }));

    return {
        stream: wrappedStream,
        response: wrappedResponse
    };
}

// ── Utility: smart truncation for large files ─────────────────────────────────

/**
 * Smart truncation for large files. Used by the /suggest-fix route.
 * Preserves lines around issue-related terms, drops the middle of huge files.
 */
export function smartTruncate(content: string, issueTerms: string[], maxLines = 300): string {
    const lines = content.split("\n");
    if (lines.length <= maxLines) return content;

    const relevantLineIndices: number[] = [];
    lines.forEach((line, i) => {
        if (issueTerms.some((term) => line.toLowerCase().includes(term.toLowerCase()))) {
            for (let j = Math.max(0, i - 10); j <= Math.min(lines.length - 1, i + 10); j++) {
                relevantLineIndices.push(j);
            }
        }
    });

    if (relevantLineIndices.length > 0) {
        const uniqueIndices = [...new Set(relevantLineIndices)].sort((a, b) => a - b);
        const relevantLines = uniqueIndices.map((i) => `L${i + 1}: ${lines[i]}`);
        return `... [Showing relevant sections] ...\n\n${relevantLines.join("\n")}`;
    }

    return [...lines.slice(0, 150), "\n... omitted ...\n", ...lines.slice(-50)].join("\n");
}

export interface RetrievalReviewResult {
    needMoreContext: boolean;
    confidence: number;
    missing: string[];
}

export async function callGeminiForRetrievalReview(
    userMessage: string,
    snippets: CodeSnippet[],
    currentFileId: string,
): Promise<RetrievalReviewResult | null> {
    const client = getClient();
    if (!client) return null;

    const model = client.getGenerativeModel({
        model: "gemini-2.5-pro",
        generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
        },
    });

    const snippetSection = formatSnippetsForPrompt(snippets);

    const prompt = `You are an AI system retrieval auditor. Your task is to evaluate if the retrieved code snippets provide sufficient context to answer the user's question, or if more information is needed.

User Question:
${userMessage}

Current File in Focus:
${currentFileId}

Retrieved Code Snippets:
═══════════════════════════════════════════════
${snippetSection}
═══════════════════════════════════════════════

Evaluate:
1. Retrieval confidence (a score between 0.0 and 1.0 representing how confident you are that the query can be accurately answered using the current snippets).
2. Context completeness (are all necessary definitions, callers, callees, schemas, or tests present?).
3. Missing information.

You must NOT choose specific files. You may ONLY request information categories.
Allowed categories:
* "usages"
* "callers"
* "callees"
* "implementations"
* "imports"
* "exports"
* "schemas"
* "tests"
* "configuration"
* "related modules"
* "neighboring graph nodes"

Respond in JSON format matching this schema:
{
  "needMoreContext": boolean,
  "confidence": number, // 0.0 to 1.0
  "missing": string[] // subset of the allowed categories list above
}
`;

    try {
        const result = await model.generateContent(prompt);
        const res = await result.response;
        const text = getText(res);
        logUsage("retrieval-review", res.usageMetadata, prompt, text);

        const parsed = JSON.parse(text);
        return {
            needMoreContext: Boolean(parsed.needMoreContext),
            confidence: Number(parsed.confidence) ?? 0.5,
            missing: (parsed.missing ?? []).filter((m: unknown): m is string => typeof m === "string"),
        };
    } catch (err) {
        console.error("\x1b[31m[issueAnalyzer] Retrieval review failed:\x1b[0m", err);
        return null;
    }
}

