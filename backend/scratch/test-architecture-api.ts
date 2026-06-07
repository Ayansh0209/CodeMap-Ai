import { redisConnection } from "../src/queue/jobQueue";
import { clusterRepositoryFiles } from "../src/processing/clustering";
import { VertexAI } from "@google-cloud/vertexai";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

function getClient(): VertexAI | null {
    let project = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
    const location = process.env.GCP_LOCATION || "us-central1";

    const apiJsonPath = path.join(process.cwd(), "api.json");
    const hasApiJson = fs.existsSync(apiJsonPath);

    let googleAuthOptions: any = undefined;
    if (hasApiJson) {
        try {
            const apiConfig = JSON.parse(fs.readFileSync(apiJsonPath, "utf8"));
            if (apiConfig.project_id && !project) {
                project = apiConfig.project_id;
            }
            googleAuthOptions = {
                keyFilename: apiJsonPath
            };
        } catch (e) {
            console.error("Failed to parse api.json:", e);
        }
    }

    if (!project) {
        console.warn("GCP Project ID is missing.");
        return null;
    }
    return new VertexAI({ 
        project, 
        location,
        googleAuthOptions
    });
}

function getText(res: any): string {
    if (res.text && typeof res.text === "function") {
        try {
            return res.text();
        } catch (e) {}
    }
    return res.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function run() {
    const talawaKeys = await redisConnection.keys("repo:PalisadoesFoundation:talawa-api:*");
    if (talawaKeys.length === 0) {
        console.error("No Talawa API cache found in Redis.");
        process.exit(1);
    }
    const key = talawaKeys[0];
    console.log("Loading cache key:", key);
    const rawData = await redisConnection.get(key);
    if (!rawData) {
        console.error("Failed to load repo data.");
        process.exit(1);
    }

    const repoData = JSON.parse(rawData);
    const fileGraph = repoData._inlineFileGraph;
    if (!fileGraph || !fileGraph.files) {
        console.error("No files in graph.");
        process.exit(1);
    }

    // 1. Cluster files
    const modules = clusterRepositoryFiles(fileGraph.files, fileGraph.importEdges || []);
    console.log(`Clustered into ${modules.length} modules.`);

    // 2. Prepare summaries
    const clustersForGemini = modules.filter(m => m.id !== "module_infra");
    const clustersSummary = clustersForGemini.map((m) => {
        const fileObjs = m.files
            .map(filePath => fileGraph.files.find((f: any) => f.id === filePath))
            .filter(Boolean);

        const sortedFiles = [...fileObjs].sort((a, b) => (b.architecturalImportance ?? 0) - (a.architecturalImportance ?? 0));
        const candidateFiles = sortedFiles.slice(0, 20).map(f => f.id);

        const topFiles = sortedFiles.slice(0, 8).map(f => ({
            path: f.id,
            importance: f.architecturalImportance ?? 0,
            role: f.semanticRole ?? f.kind ?? "source",
            tech: f.externalImports ?? []
        }));

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

    // 3. Build Prompt
    const prompt = `You are an expert software architect. You are analyzing the codebase of the repository: PalisadoesFoundation/talawa-api.

We have deterministically grouped the codebase files into logical clusters. Please provide a domain-specific, concise name, a 1-2 sentence description, an importance score (0.0 to 1.0), and 2-4 representative files for each cluster.

Here are the clusters:
${JSON.stringify(clustersSummary, null, 2)}

Instructions:
1. The name should be clear, professional, and specific to the domain of the files.
2. The description must be 1-2 sentences.
3. The importance score should rank the module.
4. Select 2-4 representative files that are central, entry points, or primary interface definitions for this cluster. You MUST choose them strictly from the provided candidateFiles list.
5. You MUST respond with a valid JSON object matching the schema below. Do not include markdown code fence syntax or extra conversational text.

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

    // 4. Initialize client and call Gemini
    const client = getClient();
    if (!client) {
        console.error("Failed to initialize Vertex AI client.");
        process.exit(1);
    }

    const generativeModel = client.getGenerativeModel({
        model: "gemini-2.5-flash",
        generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
        },
    });

    console.log("Calling Gemini 2.5 Flash...");
    const geminiStart = Date.now();
    const result = await generativeModel.generateContent(prompt);
    const resObj = await result.response;
    const geminiEnd = Date.now();
    const textResponse = getText(resObj);

    console.log(`Gemini completed in ${geminiEnd - geminiStart}ms.`);
    
    // 5. Parse output and merge back
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
            m.representativeFiles = reps.filter((rf: string) => m.files.includes(rf));
            if ((!m.representativeFiles || m.representativeFiles.length === 0) && m.files.length > 0) {
                m.representativeFiles = m.files.slice(0, 2);
            }
        } else {
            m.representativeFiles = m.files.slice(0, 2);
        }
    }

    console.log("\n=== MERGED MODULES RESULTS ===");
    for (const m of modules) {
        console.log(`\nModule ID: ${m.id}`);
        console.log(`Name: ${m.name}`);
        console.log(`Description: ${m.description}`);
        console.log(`Importance: ${m.importance}`);
        console.log(`Representative Files:`, m.representativeFiles);
        console.log(`Total Files: ${m.files.length}`);
    }

    await redisConnection.quit();
}

run().catch(console.error);
