import { extractSearchIntent } from "./issueUnderstanding";
import { traverseGraph, CandidateFileEntry, isNoisePath } from "./issueMapper";
import { fetchSnippets, CodeSnippet } from "./snippetFetcher";
import { loadRetrievalIndex } from "./issuePipeline";
import { redisConnection } from "../queue/jobQueue";
import { RetrievalIndex, RetrievalFileEntry } from "../models/retrieval";
import { fetchIssue } from "../github/issueClient";
import { callGeminiForRetrievalReview } from "./issueAnalyzer";
import { config } from "../config/config";


export interface ChatContext {
  systemInstruction: string;
  snippets: CodeSnippet[];
  candidateCount: number;
}

function buildSystemInstruction(
  currentFileId: string,
  snippets: CodeSnippet[],
  retrieval: RetrievalIndex | null,
  candidateSetFiles: CandidateFileEntry[],
  issueTitle?: string,
  issueBody?: string
): string {
  // Group snippets by fileId
  const grouped = new Map<string, CodeSnippet[]>();
  for (const s of snippets) {
    if (!grouped.has(s.fileId)) {
      grouped.set(s.fileId, []);
    }
    grouped.get(s.fileId)!.push(s);
  }

  const sections: string[] = [];
  let snippetIdx = 1;

  for (const [fileId, fileSnippets] of grouped.entries()) {
    const fileEntry = retrieval?.files.find(f => f.fileId === fileId);
    const candidateEntry = candidateSetFiles.find(c => c.fileId === fileId);
    const propagationReason = candidateEntry?.source ?? "unknown";

    const headerLines: string[] = [
      `==================================================`,
      `MODULE CONTEXT HEADER: ${fileId}`,
      `==================================================`,
      `Semantic Role: ${fileEntry?.semanticRole ?? "unknown"}`,
      `Propagation Reason: ${propagationReason}`
    ];

    if (fileEntry) {
      const importsStr = (fileEntry.imports && fileEntry.imports.length > 0)
        ? fileEntry.imports.join(", ")
        : "(none)";
      headerLines.push(`Imports: ${importsStr}`);

      const functionsList = fileEntry.functions || [];
      const exportedFuncs = functionsList.filter(fn => fn.isExported).map(fn => fn.name);
      const exportsStr = exportedFuncs.length > 0
        ? exportedFuncs.join(", ")
        : "(none)";
      headerLines.push(`Exports: ${exportsStr}`);

      const structuresStr = (fileEntry.structures && fileEntry.structures.length > 0)
        ? fileEntry.structures.map(st => st.name).join(", ")
        : "(none)";
      headerLines.push(`Structures: ${structuresStr}`);
    } else {
      headerLines.push(`Imports: (unknown)`);
      headerLines.push(`Exports: (unknown)`);
      headerLines.push(`Structures: (unknown)`);
    }
    headerLines.push(`==================================================`);

    const formattedSnippets = fileSnippets.map((s) => {
      const snippetHeader = [
        `--- Snippet ${snippetIdx++} ---`,
        `File: ${s.fileId}`,
        `Function: ${s.functionName} (lines ${s.startLine}–${s.endLine})`
      ].join("\n");
      return `${snippetHeader}\n\`\`\`\n${s.body}\n\`\`\``;
    }).join("\n\n");

    sections.push(`${headerLines.join("\n")}\n\n${formattedSnippets}`);
  }

  const snippetSection = sections.length === 0
    ? "(No snippets — answer from conversation history only)"
    : sections.join("\n\n\n");

  return [
    "You are an expert code reviewer and software engineer with deep knowledge of this codebase.",
    "",
    "BEHAVIORAL RULES — follow these strictly:",
    "- When asked to fix or implement: write ACTUAL CODE with exact file paths and line numbers",
    "- Show changes as before/after blocks or unified diffs",
    "- Never give theoretical explanations when the user expects working code",
    "- Reference exact function names and line numbers from the snippets below",
    "- If you need more code context to answer precisely, name the exact file and function",
    "",
    `CURRENT FILE IN FOCUS: ${currentFileId}`,
    issueTitle ? `\nACTIVE ISSUE: ${issueTitle}\n${issueBody?.slice(0, 400) ?? ""}` : "",
    "",
    `RETRIEVED CODE CONTEXT (${snippets.length} snippets from graph traversal):`,
    snippetSection,
    "",
    "Answer the user's question based on the code above. Be specific, be direct, write real code."
  ].join("\n");
}

function expandGraphByCategory(
  missingCategories: string[],
  retrieval: RetrievalIndex,
  seeds: string[],
  graphFileIds: Set<string>
): CandidateFileEntry[] {
  const fileMap = new Map<string, RetrievalFileEntry>();
  for (const f of retrieval.files) {
    fileMap.set(f.fileId, f);
  }

  const expandedCandidates = new Map<string, { fileId: string; score: number; source: CandidateFileEntry["source"] }>();

  for (const cat of missingCategories) {
    const category = cat.toLowerCase().trim();

    if (category === "usages" || category === "callers") {
      for (const seed of seeds) {
        const entry = fileMap.get(seed);
        if (!entry) continue;

        for (const imp of entry.importedBy) {
          if (graphFileIds.has(imp) && !isNoisePath(imp)) {
            expandedCandidates.set(imp, { fileId: imp, score: 90, source: "neighborhood" });
          }
        }

        const seedFnIds = new Set(entry.functions.map(fn => fn.id));
        for (const fileEntry of retrieval.files) {
          if (fileEntry.fileId === seed || !graphFileIds.has(fileEntry.fileId) || isNoisePath(fileEntry.fileId)) continue;
          let callsSeed = false;
          for (const fn of fileEntry.functions) {
            for (const call of fn.calls) {
              if (seedFnIds.has(call) || call.startsWith(seed + "::")) {
                callsSeed = true;
                break;
              }
            }
            if (callsSeed) break;
          }
          if (callsSeed) {
            expandedCandidates.set(fileEntry.fileId, { fileId: fileEntry.fileId, score: 90, source: "neighborhood" });
          }
        }
      }
    }

    if (category === "callees" || category === "implementations" || category === "imports") {
      for (const seed of seeds) {
        const entry = fileMap.get(seed);
        if (!entry) continue;

        for (const dep of entry.imports) {
          if (graphFileIds.has(dep) && !isNoisePath(dep)) {
            expandedCandidates.set(dep, { fileId: dep, score: 90, source: "neighborhood" });
          }
        }

        for (const fn of entry.functions) {
          for (const call of fn.calls) {
            const path = call.split("::")[0];
            if (path && path !== seed && graphFileIds.has(path) && !isNoisePath(path)) {
              expandedCandidates.set(path, { fileId: path, score: 90, source: "neighborhood" });
            }
          }
        }
      }
    }

    if (category === "exports") {
      for (const seed of seeds) {
        const entry = fileMap.get(seed);
        if (!entry) continue;

        for (const imp of entry.importedBy) {
          if (graphFileIds.has(imp) && !isNoisePath(imp)) {
            expandedCandidates.set(imp, { fileId: imp, score: 85, source: "neighborhood" });
          }
        }
      }
    }

    if (category === "schemas" || category === "configuration") {
      const isSchemaOrConfigFallback = (filePath: string) => {
        const lower = filePath.toLowerCase();
        return lower.includes("schema") ||
               lower.includes("config") ||
               lower.includes("model") ||
               lower.includes("drizzle") ||
               lower.includes("prisma") ||
               lower.includes("db") ||
               lower.endsWith(".json") ||
               lower.includes("settings");
      };

      const neighborSeeds = new Set<string>();
      for (const seed of seeds) {
        const entry = fileMap.get(seed);
        if (!entry) continue;
        for (const imp of entry.importedBy) neighborSeeds.add(imp);
        for (const dep of entry.imports) neighborSeeds.add(dep);
      }

      let metadataHitCount = 0;
      let graphHitCount = 0;
      let fallbackHitCount = 0;

      const evaluateCandidate = (filePath: string): { matches: boolean; hitType: "metadata" | "graph" | "fallback" | null; reason: string } => {
        const entry = fileMap.get(filePath);
        if (!entry) return { matches: false, hitType: null, reason: "no_entry" };
        if (entry.semanticRole === "test" || entry.isBarrel) {
          return { matches: false, hitType: null, reason: `excluded_role:${entry.semanticRole || "barrel"}` };
        }

        const hasStructures = entry.structures && entry.structures.length > 0;
        const hasFunctions = entry.functions && entry.functions.length > 0;

        // 1. Metadata Hit: structure-dominant files (no functions or high ratio of structures to functions)
        const isMetadataHit = hasStructures && (!hasFunctions || (entry.functions.length / entry.structures.length) <= 0.25);
        if (isMetadataHit) {
          metadataHitCount++;
          return { matches: true, hitType: "metadata", reason: `metadata_hit (structs:${entry.structures.length}, fns:${entry.functions.length})` };
        }

        // 2. Graph Topology Hit: highly imported by others (inDegree >= 2) but imports few (outDegree <= 2)
        const inDegree = entry.importedBy ? entry.importedBy.length : 0;
        const outDegree = entry.imports ? entry.imports.length : 0;
        const isGraphHit = inDegree >= 2 && outDegree <= 2 && (hasStructures || !hasFunctions);
        if (isGraphHit) {
          graphHitCount++;
          return { matches: true, hitType: "graph", reason: `graph_hit (in:${inDegree}, out:${outDegree})` };
        }

        // 3. Fallback Hit: existing path heuristic matching
        const isFallbackHit = isSchemaOrConfigFallback(filePath);
        if (isFallbackHit) {
          fallbackHitCount++;
          return { matches: true, hitType: "fallback", reason: "fallback_hit" };
        }

        return { matches: false, hitType: null, reason: "no_match" };
      };

      for (const neighbor of neighborSeeds) {
        if (graphFileIds.has(neighbor) && !isNoisePath(neighbor)) {
          const evalResult = evaluateCandidate(neighbor);
          if (evalResult.matches) {
            expandedCandidates.set(neighbor, { fileId: neighbor, score: 85, source: "neighborhood" });
          }
        }
      }

      if (expandedCandidates.size === 0) {
        for (const fileEntry of retrieval.files) {
          const path = fileEntry.fileId;
          if (graphFileIds.has(path) && !isNoisePath(path)) {
            const evalResult = evaluateCandidate(path);
            if (evalResult.matches) {
              expandedCandidates.set(path, { fileId: path, score: 80, source: "neighborhood" });
            }
          }
        }
      }
    }

    if (category === "tests") {
      const isTestFile = (filePath: string) => {
        return /\.(test|spec)\.(ts|js|tsx|jsx)$|\/__(tests?|mocks?)__\//i.test(filePath);
      };

      const neighbors = new Set<string>();
      for (const seed of seeds) {
        const entry = fileMap.get(seed);
        if (!entry) continue;
        for (const imp of entry.importedBy) neighbors.add(imp);
        for (const dep of entry.imports) neighbors.add(dep);
      }

      for (const neighbor of neighbors) {
        if (graphFileIds.has(neighbor) && !isNoisePath(neighbor) && isTestFile(neighbor)) {
          expandedCandidates.set(neighbor, { fileId: neighbor, score: 85, source: "neighborhood" });
        }
      }

      if (expandedCandidates.size === 0) {
        for (const fileEntry of retrieval.files) {
          if (graphFileIds.has(fileEntry.fileId) && !isNoisePath(fileEntry.fileId) && isTestFile(fileEntry.fileId)) {
            expandedCandidates.set(fileEntry.fileId, { fileId: fileEntry.fileId, score: 80, source: "neighborhood" });
          }
        }
      }
    }

    if (category === "related modules" || category === "neighboring graph nodes") {
      for (const seed of seeds) {
        const entry = fileMap.get(seed);
        if (!entry) continue;

        for (const imp of entry.importedBy) {
          if (graphFileIds.has(imp) && !isNoisePath(imp)) {
            expandedCandidates.set(imp, { fileId: imp, score: 80, source: "neighborhood" });
          }
        }
        for (const dep of entry.imports) {
          if (graphFileIds.has(dep) && !isNoisePath(dep)) {
            expandedCandidates.set(dep, { fileId: dep, score: 80, source: "neighborhood" });
          }
        }
      }
    }
  }

  return Array.from(expandedCandidates.values());
}

export async function buildChatContext(params: {
  currentFileId: string;
  userMessage: string;
  owner: string;
  repo: string;
  commitSha: string;
  graphFileIds: Set<string>;
  issueNumber?: number;
}): Promise<ChatContext> {
  const { currentFileId, userMessage, owner, repo, commitSha, graphFileIds, issueNumber } = params;

  // 1. Check Redis cache first using v2 prefix to bust stale caches
  const cacheKey = `issue-chat-ctx:v2:${owner}:${repo}:${issueNumber ?? "no-issue"}:${currentFileId}:${commitSha}`;

  try {
    const cached = await redisConnection.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      return {
        systemInstruction: parsed.systemInstruction,
        snippets: parsed.snippets,
        candidateCount: parsed.candidateCount ?? 0,
      };
    }
  } catch (err) {
    console.warn("[chatContextBuilder] Redis cache get failed:", err);
  }

  // 2. Fetch issue title and body if issueNumber is present
  let issueTitle = "";
  let issueBody = "";
  let issueMappedFiles: string[] = [];

  if (issueNumber) {
    // Try to load from issue-map cache first
    const issueCacheKey = `issue-map:${owner}:${repo}:${issueNumber}:${commitSha}`;
    try {
      const cachedMap = await redisConnection.get(issueCacheKey);
      if (cachedMap) {
        const parsedMap = JSON.parse(cachedMap);
        issueTitle = parsedMap.issueTitle || "";
        issueBody = parsedMap.issueBody || "";
        if (Array.isArray(parsedMap.affectedFiles)) {
          issueMappedFiles = parsedMap.affectedFiles.map((f: any) => f.fileId);
        }
      }
    } catch (err) {
      console.warn("[chatContextBuilder] Redis cache get for issue-map failed:", err);
    }

    // Fallback: fetch from GitHub if title/body are empty
    if (!issueTitle) {
      try {
        const issue = await fetchIssue(owner, repo, issueNumber);
        issueTitle = issue.title;
        issueBody = issue.body;
      } catch (err) {
        console.warn(`[chatContextBuilder] Failed to fetch issue #${issueNumber} from GitHub:`, err);
      }
    }
  }

  // 3. Extract intent from user message
  let intent = extractSearchIntent(userMessage, "", []);

  // Filter stopwords
  const CHAT_STOPWORDS = new Set([
    "tell", "show", "how", "why", "what", "give", "me", "you", "fix", "issue", "code", "file",
    "explain", "describe", "understand", "where", "who", "when", "does", "do", "can", "help",
    "please", "find", "get", "write", "make", "create", "change", "update", "delete", "remove",
    "add", "view", "read", "about", "here", "there", "this", "that"
  ]);

  const usefulEntities = intent.entities.filter(e => !CHAT_STOPWORDS.has(e.toLowerCase()));

  if (usefulEntities.length === 0 && (issueTitle || issueBody)) {
    intent = extractSearchIntent(issueTitle, issueBody, []);
  } else {
    intent.entities = usefulEntities;
  }

  // 4. Load retrieval index
  const retrieval = await loadRetrievalIndex(owner, repo);
  if (!retrieval) {
    return {
      systemInstruction: `You are an expert code reviewer.\nCURRENT FILE: ${currentFileId}\n(No code index available — answer from conversation only)`,
      snippets: [],
      candidateCount: 0
    };
  }

  // 5. Build seeds list based on whether issueNumber is present
  const seeds: string[] = [];
  if (issueNumber && issueMappedFiles.length > 0) {
    for (const fileId of issueMappedFiles) {
      if (graphFileIds.has(fileId)) {
        seeds.push(fileId);
      }
    }
  }

  const useCurrentFileAsPrimarySeed = seeds.length === 0;
  if (useCurrentFileAsPrimarySeed && graphFileIds.has(currentFileId)) {
    seeds.push(currentFileId);
  }

  // 6. Run graph traversal using seeds (faked as PR changed files)
  const fakePRs = seeds.length > 0 ? [{
    number: 0,
    title: "seeds",
    state: "open",
    merged: false,
    changedFiles: seeds,
    htmlUrl: ""
  }] : [];

  const candidateSet = traverseGraph(intent, retrieval, fakePRs, graphFileIds);

  // If no issueNumber (currentFileId is primary seed), force-unshift currentFileId with high score to keep it first
  if (useCurrentFileAsPrimarySeed) {
    const alreadyIncluded = candidateSet.files.some(c => c.fileId === currentFileId);
    if (!alreadyIncluded && graphFileIds.has(currentFileId)) {
      candidateSet.files.unshift({ fileId: currentFileId, source: "keyword", score: 10000 });
    } else if (alreadyIncluded) {
      for (const file of candidateSet.files) {
        if (file.fileId === currentFileId) {
          file.score = 10000;
        }
      }
    }
  }

  // Sort candidates by score descending to rank snippets by retrieval relevance
  candidateSet.files.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  // 7. Fetch snippets
  const snippets = await fetchSnippets(candidateSet.files, retrieval, intent, owner, repo, commitSha);
  // Rank snippets by existing retrieval relevance (mapping fileId to candidate's score)
  const candidateScoreMap = new Map<string, number>();
  for (const c of candidateSet.files) {
    candidateScoreMap.set(c.fileId, c.score ?? 0);
  }

  const rankedSnippets = [...snippets].sort((a, b) => {
    const scoreA = candidateScoreMap.get(a.fileId) ?? 0;
    const scoreB = candidateScoreMap.get(b.fileId) ?? 0;
    return scoreB - scoreA;
  });

  // 8. Adaptive Snippet Budget (MAX_SNIPPET_CHARS = 25000)
  const MAX_SNIPPET_CHARS = 25000;
  let finalSnippets: CodeSnippet[] = [];
  let accumulatedChars = 0;
  for (const snippet of rankedSnippets) {
    if (accumulatedChars + snippet.body.length > MAX_SNIPPET_CHARS) {
      break;
    }
    finalSnippets.push(snippet);
    accumulatedChars += snippet.body.length;
  }

  // 9. Problem 3 Fallback: If finalSnippets is empty and we have an issue number,
  // fetch the core affected files directly from Redis cache and load them as snippets instead.
  if (finalSnippets.length === 0 && issueNumber && issueMappedFiles.length > 0) {
    const fallbackCandidates = issueMappedFiles.map(fileId => ({
      fileId,
      source: "keyword" as const,
      score: 100
    }));

    try {
      const fallbackSnippets = await fetchSnippets(fallbackCandidates, retrieval, intent, owner, repo, commitSha);
      let accumulatedFallbackChars = 0;
      for (const snippet of fallbackSnippets) {
        if (accumulatedFallbackChars + snippet.body.length > MAX_SNIPPET_CHARS) {
          break;
        }
        finalSnippets.push(snippet);
        accumulatedFallbackChars += snippet.body.length;
      }
    } catch (err) {
      console.warn("[chatContextBuilder] Failed to fetch fallback snippets from issue-map affectedFiles:", err);
    }
  }

  // Iterative Retrieval Review and Expansion
  let finalCandidates = [...candidateSet.files];
  if (config.chat.enableIterativeRetrieval) {
    const review = await callGeminiForRetrievalReview(userMessage, finalSnippets, currentFileId);
    if (review) {
      if (review.needMoreContext && review.missing && review.missing.length > 0) {
        // Stage 3: Graph Expansion
        const seedsForExpansion = finalSnippets.map(s => s.fileId);
        if (seedsForExpansion.length === 0) {
          seedsForExpansion.push(...seeds);
        }

        const expandedCandidates = expandGraphByCategory(review.missing, retrieval, seedsForExpansion, graphFileIds);
        
        const existingFileIds = new Set(candidateSet.files.map(c => c.fileId));
        const newCandidates = expandedCandidates.filter(c => !existingFileIds.has(c.fileId));

        if (newCandidates.length > 0) {
          finalCandidates.push(...newCandidates);

          const expandedSnippets = await fetchSnippets(newCandidates, retrieval, intent, owner, repo, commitSha);
          const allSnippets = [...finalSnippets, ...expandedSnippets];
          const candidateScoreMap = new Map<string, number>();
          for (const c of finalCandidates) {
            candidateScoreMap.set(c.fileId, c.score ?? 0);
          }

          const rankedAllSnippets = allSnippets.sort((a, b) => {
            const scoreA = candidateScoreMap.get(a.fileId) ?? 0;
            const scoreB = candidateScoreMap.get(b.fileId) ?? 0;
            return scoreB - scoreA;
          });

          finalSnippets = [];
          let accumulatedChars = 0;
          for (const snippet of rankedAllSnippets) {
            if (accumulatedChars + snippet.body.length > MAX_SNIPPET_CHARS) {
              break;
            }
            finalSnippets.push(snippet);
            accumulatedChars += snippet.body.length;
          }
        } else {
        }
      }
    } else {
      console.warn(`[IterativeRetrieval] Gemini retrieval review returned null.`);
    }
  }

  // 10. Build system instruction string
  const systemInstruction = buildSystemInstruction(
    currentFileId,
    finalSnippets,
    retrieval,
    finalCandidates,
    issueTitle,
    issueBody
  );

  // 11. Cache result
  try {
    await redisConnection.set(
      cacheKey,
      JSON.stringify({ systemInstruction, snippets: finalSnippets, candidateCount: finalCandidates.length }),
      "EX",
      300
    );
  } catch (err) {
    console.warn("[chatContextBuilder] Redis cache set failed:", err);
  }

  return { systemInstruction, snippets: finalSnippets, candidateCount: finalCandidates.length };
}
