import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { redisConnection } from "../queue/jobQueue";
import { clusterRepositoryFiles, computeModuleDependencies } from "../processing/clustering";
import { VertexAI } from "@google-cloud/vertexai";
import { config } from "../config/config";
import * as fs from "fs";
import * as path from "path";

const router = Router();

const architectureRequestSchema = z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    commitSha: z.string().min(6),
    model: z.enum(["gemini-2.5-pro", "gemini-2.5-flash"]).optional(),
});

// ── Vertex AI Client helper ───────────────────────────────────────────────────
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
            console.error("Failed to parse GCP_SA_KEY in architecture router:", e);
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
                console.error("Failed to parse api.json in architecture router:", e);
            }
        }
    }

    if (!project) {
        console.warn("[architecture] GCP Project ID is missing. VertexAI client will not initialize.");
        return null;
    }
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

// ── GET /architecture/debug ───────────────────────────────────────────────────
router.get("/debug", async (req: Request, res: Response, next: NextFunction) => {
    try {
        const parsed = architectureRequestSchema.safeParse(req.query);
        if (!parsed.success) {
            return res.status(400).json({ error: "Invalid parameters", details: parsed.error.flatten() });
        }

        const { owner, repo, commitSha, model } = parsed.data;
        const modelName = model || "gemini-2.5-flash";
        const debugKey = `architecture:debug:v1:${modelName}:${owner}:${repo}:${commitSha}`;
        const cachedDebug = await redisConnection.get(debugKey);

        if (cachedDebug) {
            return res.json(JSON.parse(cachedDebug));
        }

        // If no debug entry but main cache exists, return cache hit metadata
        const mainKey = `architecture:v1:${modelName}:${owner}:${repo}:${commitSha}`;
        const mainExists = await redisConnection.exists(mainKey);
        if (mainExists) {
            return res.json({
                cacheHit: true,
                message: "Architecture map is cached, but detailed debug logs are unavailable."
            });
        }

        return res.status(404).json({ error: "No architecture debug metrics found for this repository/commit." });
    } catch (err) {
        next(err);
    }
});

// ── POST /architecture ────────────────────────────────────────────────────────
router.post("/", async (req: Request, res: Response, next: NextFunction) => {
    const totalRequestStart = Date.now();
    try {
        const parsed = architectureRequestSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
        }

        const { owner, repo, commitSha, model } = parsed.data;
        const modelName = model || "gemini-2.5-flash";
        const cacheKey = `architecture:v1:${modelName}:${owner}:${repo}:${commitSha}`;

        // 1. Check Redis Cache
        const cached = await redisConnection.get(cacheKey);
        if (cached) {
            // Cache hit debug update
            const debugKey = `architecture:debug:v1:${modelName}:${owner}:${repo}:${commitSha}`;
            const cachedDebug = await redisConnection.get(debugKey);
            if (cachedDebug) {
                const debugObj = JSON.parse(cachedDebug);
                debugObj.cacheHit = true;
                debugObj.totalTimeMs = Date.now() - totalRequestStart;
                await redisConnection.set(debugKey, JSON.stringify(debugObj));
            }
            return res.json(JSON.parse(cached));
        }

        // 2. Load Repo Graph
        const repoGraphKey = `repo:${owner}:${repo}:${commitSha}`;
        const rawRepoData = await redisConnection.get(repoGraphKey);
        if (!rawRepoData) {
            return res.status(404).json({
                error: "Repository has not been analyzed yet. Please run analyze first."
            });
        }

        const repoData = JSON.parse(rawRepoData);
        const fileGraph = repoData._inlineFileGraph;
        if (!fileGraph || !fileGraph.files) {
            return res.status(500).json({ error: "Repository analysis data is incomplete (missing files list)." });
        }

        // 3. Deterministic Clustering
        const modules = clusterRepositoryFiles(fileGraph.files, fileGraph.importEdges || []);

        // 4. Summarize Clusters for Gemini (Enhanced Hybrid Approach B+C)
        const clustersForGemini = modules.filter(m => m.id !== "module_infra");
        const clustersSummary = clustersForGemini.map((m) => {
            const fileObjs = m.files
                .map(filePath => fileGraph.files.find((f: any) => f.id === filePath))
                .filter(Boolean);

            // Sort files by architectural importance to find top 20 files as candidates
            const sortedFiles = [...fileObjs].sort((a, b) => (b.architecturalImportance ?? 0) - (a.architecturalImportance ?? 0));
            const candidateFiles = sortedFiles.slice(0, 20).map(f => f.id);

            // Sort files by architectural importance to find top 8 files for details
            const topFiles = sortedFiles.slice(0, 8).map(f => ({
                path: f.id,
                importance: f.architecturalImportance ?? 0,
                role: f.semanticRole ?? f.kind ?? "source",
                tech: f.externalImports ?? []
            }));

            // Aggregate external imports (technologies) used in this cluster
            const techCounts = new Map<string, number>();
            for (const f of fileObjs) {
                if (f.externalImports) {
                    for (const lib of f.externalImports) {
                        techCounts.set(lib, (techCounts.get(lib) || 0) + 1);
                    }
                }
            }
            const topTech = [...techCounts.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 8)
                .map(([lib]) => lib);

            // Extract representative subdirectories containing files
            const subdirsCount = new Map<string, number>();
            for (const f of fileObjs) {
                const parts = f.id.split("/");
                if (parts.length > 1) {
                    const parent = parts.slice(0, -1).join("/");
                    subdirsCount.set(parent, (subdirsCount.get(parent) || 0) + 1);
                }
            }
            const topSubdirs = [...subdirsCount.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([dir, count]) => `${dir} (${count} files)`);

            return {
                id: m.id,
                defaultName: m.name,
                fileCount: m.files.length,
                candidateFiles,
                topImportantFiles: topFiles,
                topTechnologies: topTech,
                representativeDirectories: topSubdirs
            };
        });

        // 5. Build AI Naming Prompt
        const prompt = `You are an expert software architect. You are analyzing the codebase of the repository: ${owner}/${repo}.

We have deterministically grouped the codebase files into logical clusters. Please provide a domain-specific, concise name, a 1-2 sentence description, an importance score (0.0 to 1.0), and 2-4 representative files for each cluster.

Here are the clusters:
${JSON.stringify(clustersSummary, null, 2)}

Instructions:
1. The name should be clear, professional, and specific to the domain of the files (e.g. "API Handlers" or "Database Connections", NOT generic "module_0" or directory paths).
2. The description must be 1-2 sentences explaining what the files in the module do.
3. The importance score should rank the module (0.0 = low importance, 1.0 = highly critical core component).
4. Select 2-4 representative files that are central, entry points, or primary interface definitions for this cluster. You MUST choose them strictly from the provided candidateFiles list.
5. You MUST respond with a valid JSON object matching the schema below. Do not include markdown code fence syntax (e.g. \`\`\`json) or any extra conversational text.

Response Schema:
{
  "modules": [
    {
      "id": "module_id_matching_input",
      "name": "Concise Domain-Specific Name",
      "description": "Short description of the module.",
      "importance": 0.8,
      "representativeFiles": ["path/to/file1.ts", "path/to/file2.ts"]
    }
  ]
}
`;

        // 6. Call Gemini
        const client = getClient();
        if (!client) {
            throw new Error("Vertex AI client could not be initialized. Please check GCP configuration.");
        }

        const generativeModel = client.getGenerativeModel({
            model: modelName,
            generationConfig: {
                temperature: 0,
                responseMimeType: "application/json",
            },
        });

        const geminiStart = Date.now();
        const result = await generativeModel.generateContent(prompt);
        const resObj = await result.response;
        const geminiEnd = Date.now();
        const textResponse = getText(resObj);

        // 7. Parse Gemini Naming and Merge back
        const geminiOutput = JSON.parse(textResponse);
        const geminiModules = geminiOutput.modules || [];

        for (const m of modules) {
            if (m.id === "module_infra") {
                const infraKeyFiles = [
                    "readme.md", "package.json", "docker-compose.yml", "dockerfile", 
                    "tsconfig.json", "drizzle.config.ts", "drizzle.config.js", 
                    "eslint.config.js", ".eslintrc.js", "next.config.js"
                ];
                const selectedReps = m.files.filter(f => {
                    const base = f.split("/").pop()?.toLowerCase();
                    return base && infraKeyFiles.includes(base);
                });
                m.representativeFiles = selectedReps.slice(0, 4);
                if ((!m.representativeFiles || m.representativeFiles.length === 0) && m.files.length > 0) {
                    m.representativeFiles = m.files.slice(0, 2);
                }
                continue;
            }

            const match = geminiModules.find((gm: any) => gm.id === m.id);
            if (match) {
                m.name = match.name || m.name;
                m.description = match.description || m.description;
                m.importance = Number(match.importance) ?? m.importance;
                const reps = Array.isArray(match.representativeFiles) ? match.representativeFiles : [];
                // Validate that the returned files actually belong to this module's file list
                m.representativeFiles = reps.filter((rf: string) => m.files.includes(rf));
                if ((!m.representativeFiles || m.representativeFiles.length === 0) && m.files.length > 0) {
                    m.representativeFiles = m.files.slice(0, 2);
                }
            } else {
                m.representativeFiles = m.files.slice(0, 2);
            }
        }

        // 8. Compute Module Dependencies
        const dependencies = computeModuleDependencies(modules, fileGraph.importEdges || []);

        const finalResponse = {
            modules,
            dependencies
        };

        // 9. Caching
        await redisConnection.set(cacheKey, JSON.stringify(finalResponse));

        // 10. Cost & Debug Metrics Logging
        const INPUT_PRICE = modelName === "gemini-2.5-flash" ? 0.000000075 : 0.00000125;
        const OUTPUT_PRICE = modelName === "gemini-2.5-flash" ? 0.0000003 : 0.00001;

        const promptTokens = resObj.usageMetadata?.promptTokenCount ?? 0;
        const responseTokens = resObj.usageMetadata?.candidatesTokenCount ?? 0;
        const totalTokens = promptTokens + responseTokens;

        const calculatedCost = (promptTokens * INPUT_PRICE) + (responseTokens * OUTPUT_PRICE);
        const estimatedCost = `$${calculatedCost.toFixed(6)}`;

        // Debug assertions and prints requested
        const usage = resObj.usageMetadata;

        if (
          usage?.totalTokenCount &&
          usage?.promptTokenCount &&
          usage.totalTokenCount < usage.promptTokenCount
        ) {
          console.error("TOKEN ACCOUNTING ERROR");
        }
        console.dir(resObj.usageMetadata, { depth: null });
        const totalTime = Date.now() - totalRequestStart;
        const generationTime = geminiEnd - geminiStart;
        const postProcessingTime = Date.now() - geminiEnd;

        const debugMetrics = {
            cacheHit: false,
            fileCount: fileGraph.files.length,
            clusterCount: modules.length,
            promptTokens,
            responseTokens,
            totalTokens,
            estimatedCost,
            generationTimeMs: generationTime,
            postProcessingTimeMs: postProcessingTime,
            totalTimeMs: totalTime
        };

        const debugKey = `architecture:debug:v1:${modelName}:${owner}:${repo}:${commitSha}`;
        await redisConnection.set(debugKey, JSON.stringify(debugMetrics));
        return res.json(finalResponse);

    } catch (err) {
        console.error("[architecture] Error generating architecture:", err);
        next(err);
    }
});

export default router;
