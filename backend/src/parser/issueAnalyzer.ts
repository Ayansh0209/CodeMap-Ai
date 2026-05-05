// backend/src/parser/issueAnalyzer.ts

import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "../config/config";
import type { IssueComment, LinkedPR } from "../github/issueClient";

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

// Lazy singleton
let geminiClient: GoogleGenerativeAI | null = null;
function getClient(): GoogleGenerativeAI | null {
    if (!config.gemini.apiKey) return null;
    if (!geminiClient) geminiClient = new GoogleGenerativeAI(config.gemini.apiKey);
    return geminiClient;
}

// Build the file list string
function buildFileListString(files: Array<{ id: string; architecturalImportance?: number }>): string {
    return [...files]
        .sort((a, b) => (b.architecturalImportance ?? 0) - (a.architecturalImportance ?? 0))
        .slice(0, 100)
        .map((f) => f.id)
        .join("\n");
}

// Smart truncation
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

function extractTechnicalTerms(text: string): string[] {
    const matches = text.match(/\b([a-z][a-zA-Z0-9_]{2,}|[A-Z][a-zA-Z0-9_]{2,})\b/g) ?? [];
    return [...new Set(matches.slice(0, 20))];
}

// Logging
function logUsage(operation: string, usage: any, prompt: string, response: string) {
    if (!usage) return;
    const { promptTokenCount, candidatesTokenCount } = usage;
    const cost = (promptTokenCount * 0.000000075) + (candidatesTokenCount * 0.0000003);
    console.log(`\n\x1b[1;31m[AI FULL LOG - ${operation.toUpperCase()}]\x1b[0m`);
    console.log(`\x1b[31m--- PROMPT ---\x1b[0m\n\x1b[31m${prompt.slice(0, 500)}...\x1b[0m`);
    console.log(`\x1b[31m--- RESPONSE ---\x1b[0m\n\x1b[31m${response}\x1b[0m`);
    console.log(`\x1b[1;31m[COST] $${cost.toFixed(6)}\x1b[0m\n`);
}

// Main Mapping
export async function callGeminiForMapping(
    issue: IssueContextInput,
    files: Array<{ id: string; architecturalImportance?: number }>,
    keywordHints: string[],
): Promise<GeminiMappingResult | null> {
    const client = getClient();
    if (!client) return null;

    const model = client.getGenerativeModel({
        model: "gemini-flash-latest",
        generationConfig: { 
            temperature: 0.1, 
            responseMimeType: "application/json" // FORCES JSON OUTPUT
        },
    });

    const fileListStr = buildFileListString(files);
    const prompt = `You are a software expert. Return JSON with affectedFiles: [{fileId, confidence, reason}], summary, fixApproach. \n\nISSUE: ${issue.title}\nBODY: ${issue.body.slice(0, 1000)}\n\nFILES:\n${fileListStr}`;

    try {
        const result = await model.generateContent(prompt);
        const res = await result.response;
        const text = res.text();
        logUsage("mapping", res.usageMetadata, prompt, text);

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
        console.error("[issueAnalyzer] Mapping failed:", err);
        return null;
    }
}

// Chat
export async function callGeminiForChatStream(
    systemInstruction: string,
    messages: Array<{ role: string; content: string }>
) {
    const client = getClient();
    if (!client) throw new Error("Gemini key missing");

    const model = client.getGenerativeModel({
        model: "gemini-flash-latest",
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
