"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.callGeminiForGraphNavigation = callGeminiForGraphNavigation;
exports.callGeminiForMappingRound1 = callGeminiForMappingRound1;
exports.callGeminiForMappingFinal = callGeminiForMappingFinal;
exports.callGeminiForMapping = callGeminiForMapping;
exports.callGeminiForChatStream = callGeminiForChatStream;
exports.smartTruncate = smartTruncate;
const generative_ai_1 = require("@google/generative-ai");
const config_1 = require("../config/config");
// ── Client ────────────────────────────────────────────────────────────────────
let geminiClient = null;
function getClient() {
    if (!config_1.config.gemini.apiKey)
        return null;
    if (!geminiClient)
        geminiClient = new generative_ai_1.GoogleGenerativeAI(config_1.config.gemini.apiKey);
    return geminiClient;
}
// ── Logging ───────────────────────────────────────────────────────────────────
function logUsage(operation, usage, prompt, response) {
    if (!usage)
        return;
    const { promptTokenCount, candidatesTokenCount } = usage;
    const cost = (promptTokenCount * 0.000000075) + (candidatesTokenCount * 0.0000003);
    console.log(`\n\x1b[1;31m[AI FULL LOG - ${operation.toUpperCase()}]\x1b[0m`);
    console.log(`\x1b[31m--- PROMPT ---\x1b[0m\n\x1b[33m${prompt}\x1b[0m`);
    console.log(`\x1b[31m--- RESPONSE ---\x1b[0m\n\x1b[32m${response}\x1b[0m`);
    console.log(`\x1b[1;31m[COST] $${cost.toFixed(6)}\x1b[0m\n`);
}
// ── Snippet formatter ─────────────────────────────────────────────────────────
/**
 * Format code snippets into a structured prompt section.
 * Each snippet is presented with file path, function name, and source signals.
 */
function formatSnippetsForPrompt(snippets) {
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
async function callGeminiForGraphNavigation(issue, graphMap) {
    const client = getClient();
    if (!client)
        return [];
    const model = client.getGenerativeModel({
        model: "gemini-2.5-pro",
        generationConfig: {
            temperature: 0.1,
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
        const text = res.text();
        logUsage("graph-navigation", res.usageMetadata, prompt, text);
        const parsed = JSON.parse(text);
        const files = (parsed.requestedFiles ?? [])
            .filter((f) => typeof f === "string")
            .slice(0, 15);
        console.log(`\x1b[34m[issueAnalyzer] Gemini graph navigation returned ${files.length} files\x1b[0m`);
        return files;
    }
    catch (err) {
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
async function callGeminiForMappingRound1(issue, snippets, linkedPRs) {
    const client = getClient();
    if (!client)
        return null;
    const model = client.getGenerativeModel({
        model: "gemini-2.5-pro",
        generationConfig: {
            temperature: 0.1,
            responseMimeType: "application/json",
        },
    });
    const commentText = issue.comments.slice(0, 5)
        .map(c => `${c.author}: ${c.body.slice(0, 300)}`)
        .join("\n");
    const prContext = linkedPRs.length > 0
        ? linkedPRs.map(pr => `PR #${pr.number} (${pr.state}${pr.merged ? ", merged" : ""}): ${pr.title}\n` +
            `Changed files: ${pr.changedFiles.slice(0, 10).join(", ")}`).join("\n")
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
Based on the issue and the code snippets above, do ONE of two things:

OPTION A — If you can confidently identify the affected files:
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

OPTION B — If you need to see additional files before answering:
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
- Only request more files if the snippets truly are insufficient
- If you have enough context, always choose Option A
- Confidence 90+ means you can point to specific lines
- Confidence 50-70 means you're in the right area but want more context
- Only include files from the snippets in affectedFiles
`;
    try {
        const result = await model.generateContent(prompt);
        const res = await result.response;
        const text = res.text();
        logUsage("mapping-round1", res.usageMetadata, prompt, text);
        const parsed = JSON.parse(text);
        return {
            needsMoreContext: Boolean(parsed.needsMoreContext),
            requestedFiles: (parsed.requestedFiles ?? []).filter((f) => typeof f === "string"),
            reason: String(parsed.reason || ""),
            affectedFiles: (parsed.affectedFiles ?? []).map((f) => ({
                fileId: String(f.fileId),
                confidence: Number(f.confidence) || 50,
                reason: String(f.reason || ""),
            })),
            summary: String(parsed.summary || ""),
            fixApproach: String(parsed.fixApproach || ""),
        };
    }
    catch (err) {
        console.error("\x1b[31m[issueAnalyzer] Round 1 mapping failed:\x1b[0m", err);
        return null;
    }
}
/**
 * Round 2: Gemini gives a final answer with additional context.
 * No more iteration — this is always the last call.
 */
async function callGeminiForMappingFinal(issue, allSnippets, linkedPRs) {
    const client = getClient();
    if (!client)
        return null;
    const model = client.getGenerativeModel({
        model: "gemini-2.5-pro",
        generationConfig: {
            temperature: 0.1,
            responseMimeType: "application/json",
        },
    });
    const commentText = issue.comments.slice(0, 5)
        .map(c => `${c.author}: ${c.body.slice(0, 300)}`)
        .join("\n");
    const prContext = linkedPRs.length > 0
        ? linkedPRs.map(pr => `PR #${pr.number} (${pr.state}${pr.merged ? ", merged" : ""}): ${pr.title}\n` +
            `Changed files: ${pr.changedFiles.slice(0, 10).join(", ")}`).join("\n")
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
        const text = res.text();
        logUsage("mapping-final", res.usageMetadata, prompt, text);
        const parsed = JSON.parse(text);
        return {
            affectedFiles: (parsed.affectedFiles ?? []).map((f) => ({
                fileId: String(f.fileId),
                confidence: Number(f.confidence) || 50,
                reason: String(f.reason || ""),
            })),
            summary: String(parsed.summary || ""),
            fixApproach: String(parsed.fixApproach || ""),
        };
    }
    catch (err) {
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
async function callGeminiForMapping(issue, snippets, linkedPRs) {
    const round1 = await callGeminiForMappingRound1(issue, snippets, linkedPRs);
    if (!round1)
        return null;
    return {
        affectedFiles: round1.affectedFiles,
        summary: round1.summary,
        fixApproach: round1.fixApproach,
    };
}
// ── Chat ──────────────────────────────────────────────────────────────────────
async function callGeminiForChatStream(systemInstruction, messages) {
    const client = getClient();
    if (!client)
        throw new Error("Gemini key missing");
    const model = client.getGenerativeModel({
        model: "gemini-2.5-pro",
        systemInstruction,
        generationConfig: { temperature: 0.2 },
    });
    // MAP ROLES: Gemini only accepts "user" and "model"
    const history = messages.slice(0, -1).map(m => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }]
    }));
    const lastMessage = messages[messages.length - 1].content;
    const chat = model.startChat({ history });
    return chat.sendMessageStream(lastMessage);
}
// ── Utility: smart truncation for large files ─────────────────────────────────
/**
 * Smart truncation for large files. Used by the /suggest-fix route.
 * Preserves lines around issue-related terms, drops the middle of huge files.
 */
function smartTruncate(content, issueTerms, maxLines = 300) {
    const lines = content.split("\n");
    if (lines.length <= maxLines)
        return content;
    const relevantLineIndices = [];
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
