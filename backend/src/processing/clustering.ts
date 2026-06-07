import { FileNode, ImportEdge } from "../models/schema";

export interface RepoModule {
    id: string;
    name: string;
    description: string;
    importance: number;
    files: string[];
    representativeFiles?: string[];
}

export interface ModuleDependency {
    source: string;
    target: string;
    count: number;
}

/**
 * Extracts a core noun (domain entity) from a filename stem.
 * e.g., "createUserResolver.ts" -> "User"
 */
function extractEntityNoun(filename: string): string {
    const stem = filename.split(".")[0];
    const tokens = stem
        .split(/(?=[A-Z])|[^a-zA-Z]/)
        .map(t => t.toLowerCase().trim())
        .filter(t => t.length > 0);

    const IGNORE_KEYWORDS = new Set([
        "create", "delete", "update", "get", "list", "add", "remove", "patch", "fetch",
        "resolver", "resolvers", "type", "types", "query", "queries", "mutation", "mutations",
        "service", "services", "controller", "controllers", "test", "tests", "spec", "specs",
        "model", "models", "schema", "schemas", "handler", "handlers", "api", "apis", "index",
        "field", "fields", "input", "inputs", "payload", "payloads", "validator", "validators",
        "helper", "helpers", "util", "utils", "config", "configs", "route", "routes"
    ]);

    const entityToken = tokens.find(t => !IGNORE_KEYWORDS.has(t));
    if (!entityToken) {
        return "Core";
    }
    return entityToken.charAt(0).toUpperCase() + entityToken.slice(1);
}

/**
 * Computes the common prefix of two directory paths.
 */
function getCommonPrefix(path1: string, path2: string): string {
    if (path1 === path2) return path1;
    if (!path1 || !path2) return "";
    
    const parts1 = path1.split("/");
    const parts2 = path2.split("/");
    const common: string[] = [];
    
    for (let i = 0; i < Math.min(parts1.length, parts2.length); i++) {
        if (parts1[i] === parts2[i]) {
            common.push(parts1[i]);
        } else {
            break;
        }
    }
    return common.join("/");
}

/**
 * Determines the merged folder path name.
 */
function getMergedName(path1: string, path2: string, size1: number, size2: number): string {
    const prefix = getCommonPrefix(path1, path2);
    // Use the common prefix if it's specific enough (at least depth 2)
    if (prefix && prefix.split("/").length >= 2) {
        return prefix;
    }
    // Otherwise, default to the name of the larger cluster
    return size1 >= size2 ? path1 : path2;
}

/**
 * Helper to determine if a file is configuration, script, or documentation.
 */
function isInfrastructureFile(fileId: string, kind: string): boolean {
    const pathLower = fileId.toLowerCase().replace(/\\/g, "/");
    
    // 1. Path starts with docs/, .github/, scripts/, tools/, docker/, website/, site/
    const isDocOrScriptDir = 
        pathLower.startsWith("docs/") ||
        pathLower.startsWith(".github/") ||
        pathLower.startsWith("scripts/") ||
        pathLower.startsWith("tools/") ||
        pathLower.startsWith("docker/") ||
        pathLower.startsWith("website/") ||
        pathLower.startsWith("site/");
    
    // 2. Extension is .md, .json, .yaml, .yml, .toml, .lock, .sh, .bat
    const hasInfraExtension = 
        pathLower.endsWith(".md") ||
        pathLower.endsWith(".json") ||
        pathLower.endsWith(".yaml") ||
        pathLower.endsWith(".yml") ||
        pathLower.endsWith(".toml") ||
        pathLower.endsWith(".lock") ||
        pathLower.endsWith(".sh") ||
        pathLower.endsWith(".bat");
    
    // 3. File kind is "config"
    const isConfigKind = kind === "config";

    // 4. Filename starts with config. or common config formats
    const filename = pathLower.split("/").pop() || "";
    const isConfigFilename =
        filename.includes("config.") ||
        filename.startsWith("tsconfig") ||
        filename.startsWith(".eslintrc") ||
        filename.startsWith(".prettierrc") ||
        filename.startsWith(".babelrc") ||
        filename.startsWith(".env");

    return isDocOrScriptDir || hasInfraExtension || isConfigKind || isConfigFilename;
}

/**
 * Groups files into 5-15 logical modules using an advanced balanced clustering algorithm.
 */
export function clusterRepositoryFiles(files: FileNode[], edges: ImportEdge[]): RepoModule[] {
    if (files.length === 0) return [];

    const infraFiles = files.filter(f => isInfrastructureFile(f.id, f.kind));
    const sourceFiles = files.filter(f => !isInfrastructureFile(f.id, f.kind));

    const resultModules: RepoModule[] = [];

    if (sourceFiles.length > 0) {
        const totalSourceFiles = sourceFiles.length;
        const MAX_CLUSTER_SIZE = Math.max(40, Math.floor(totalSourceFiles / 4));

        // Helper to extract folder path
        const getFolder = (fileId: string): string => {
            const parts = fileId.split("/");
            if (parts.length <= 1) return "";
            return parts.slice(0, parts.length - 1).join("/");
        };

        // 1. Group files by parent directory
        const folderGroups = new Map<string, string[]>();
        for (const file of sourceFiles) {
            const folder = getFolder(file.id);
            const list = folderGroups.get(folder) ?? [];
            list.push(file.id);
            folderGroups.set(folder, list);
        }

        // Calculate recursive file count for each directory path
        const recursiveCounts = new Map<string, number>();
        for (const folder of folderGroups.keys()) {
            let count = 0;
            for (const [f, list] of folderGroups.entries()) {
                if (f === folder || f.startsWith(folder + "/")) {
                    count += list.length;
                }
            }
            recursiveCounts.set(folder, count);
        }

        // Identify Protected Monoliths (folders containing > 15% of codebase or > 40 files)
        const protectedMonoliths = new Set<string>();
        for (const [folder, count] of recursiveCounts.entries()) {
            if (count > 40 || count > totalSourceFiles * 0.15) {
                protectedMonoliths.add(folder);
            }
        }

        // 2. Perform initial clustering with flat folder subdivision
        interface Cluster {
            dir: string;
            files: string[];
        }
        
        let clusters: Cluster[] = [];

        for (const [folder, fileList] of folderGroups.entries()) {
            // Find if folder is a monolith or is inside a monolith
            const isMonolith = protectedMonoliths.has(folder);
            
            if (isMonolith && fileList.length > 25) {
                const entityGroups = new Map<string, string[]>();
                
                for (const fileId of fileList) {
                    const filename = fileId.split("/").pop() || "";
                    const entity = extractEntityNoun(filename);
                    const list = entityGroups.get(entity) ?? [];
                    list.push(fileId);
                    entityGroups.set(entity, list);
                }

                const sharedFiles: string[] = [];
                for (const [entity, groupFiles] of entityGroups.entries()) {
                    if (groupFiles.length >= 3) {
                        clusters.push({
                            dir: folder ? `${folder}/${entity}` : entity,
                            files: groupFiles
                        });
                    } else {
                        sharedFiles.push(...groupFiles);
                    }
                }

                if (sharedFiles.length > 0) {
                    clusters.push({
                        dir: folder ? `${folder}/Shared` : "Shared",
                        files: sharedFiles
                    });
                }
            } else {
                clusters.push({
                    dir: folder,
                    files: fileList
                });
            }
        }

        // Map each file to its current cluster index
        const fileToClusterIndex = new Map<string, number>();
        const updateFileMapping = () => {
            fileToClusterIndex.clear();
            clusters.forEach((c, idx) => {
                c.files.forEach(f => fileToClusterIndex.set(f, idx));
            });
        };
        updateFileMapping();

        // 3. Size-bounded merge phase using inter-cluster coupling scores
        const targetClustersCount = infraFiles.length > 0 ? 14 : 15;
        while (clusters.length > targetClustersCount) {
            interface PairCoupling {
                i: number;
                j: number;
                score: number;
            }

            const couplings: PairCoupling[] = [];
            const clusterEdges = new Map<string, number>();

            for (const edge of edges) {
                const cI = fileToClusterIndex.get(edge.source);
                const cJ = fileToClusterIndex.get(edge.target);
                if (cI !== undefined && cJ !== undefined && cI !== cJ) {
                    const key = cI < cJ ? `${cI}->${cJ}` : `${cJ}->${cI}`;
                    clusterEdges.set(key, (clusterEdges.get(key) || 0) + 1);
                }
            }

            for (const [key, count] of clusterEdges.entries()) {
                const [cI, cJ] = key.split("->").map(Number);
                const sizeSum = clusters[cI].files.length + clusters[cJ].files.length;
                couplings.push({
                    i: cI,
                    j: cJ,
                    score: count / sizeSum
                });
            }

            couplings.sort((a, b) => b.score - a.score);

            let merged = false;

            // Try to merge the highest coupled pair that satisfies the size limit
            for (const pair of couplings) {
                const cI = clusters[pair.i];
                const cJ = clusters[pair.j];
                const newSize = cI.files.length + cJ.files.length;

                if (newSize <= MAX_CLUSTER_SIZE) {
                    cI.dir = getMergedName(cI.dir, cJ.dir, cI.files.length, cJ.files.length);
                    cI.files.push(...cJ.files);
                    clusters.splice(pair.j, 1);
                    merged = true;
                    break;
                }
            }

            // Fallback: If no merges fit the size limit, merge the absolute smallest cluster
            // with its SMALLEST connected sibling to prevent the giant monolith snowball effect
            if (!merged) {
                let smallestIdx = -1;
                let smallestSize = Infinity;
                
                for (let idx = 0; idx < clusters.length; idx++) {
                    if (clusters[idx].files.length < smallestSize) {
                        smallestSize = clusters[idx].files.length;
                        smallestIdx = idx;
                    }
                }

                if (smallestIdx !== -1) {
                    let bestSiblingIdx = -1;
                    let minSiblingSize = Infinity;

                    for (let idx = 0; idx < clusters.length; idx++) {
                        if (idx === smallestIdx) continue;
                        
                        let edgeCount = 0;
                        for (const edge of edges) {
                            const src = fileToClusterIndex.get(edge.source);
                            const tgt = fileToClusterIndex.get(edge.target);
                            if (
                                (src === smallestIdx && tgt === idx) || 
                                (src === idx && tgt === smallestIdx)
                            ) {
                                edgeCount++;
                            }
                        }

                        if (edgeCount > 0) {
                            const size = clusters[idx].files.length;
                            if (size < minSiblingSize) {
                                minSiblingSize = size;
                                bestSiblingIdx = idx;
                            }
                        }
                    }

                    // If no connected sibling, merge with absolute smallest cluster
                    if (bestSiblingIdx === -1) {
                        let minSize = Infinity;
                        for (let idx = 0; idx < clusters.length; idx++) {
                            if (idx === smallestIdx) continue;
                            if (clusters[idx].files.length < minSize) {
                                minSize = clusters[idx].files.length;
                                bestSiblingIdx = idx;
                            }
                        }
                    }

                    const mergeTarget = Math.min(smallestIdx, bestSiblingIdx);
                    const mergeSource = Math.max(smallestIdx, bestSiblingIdx);

                    const cT = clusters[mergeTarget];
                    const cS = clusters[mergeSource];

                    cT.dir = getMergedName(cT.dir, cS.dir, cT.files.length, cS.files.length);
                    cT.files.push(...cS.files);
                    clusters.splice(mergeSource, 1);
                    merged = true;
                } else {
                    break;
                }
            }

            updateFileMapping();
        }

        // 4. Format into RepoModule objects
        resultModules.push(...clusters.map((c, index) => {
            const displayName = c.dir === "" ? "Root/Core" : c.dir;
            return {
                id: `module_${index}`,
                name: displayName,
                description: `Source files in ${displayName}`,
                importance: 0.5,
                files: c.files,
            };
        }));
    }

    if (infraFiles.length > 0) {
        resultModules.push({
            id: "module_infra",
            name: "Project Infrastructure & Docs",
            description: "Configuration files, documentation, and build or deployment scripts",
            importance: 0.1,
            files: infraFiles.map(f => f.id),
        });
    }

    return resultModules;
}

/**
 * Computes inter-module dependencies based on import relationships between files.
 */
export function computeModuleDependencies(modules: RepoModule[], edges: ImportEdge[]): ModuleDependency[] {
    const fileToModuleId = new Map<string, string>();
    for (const m of modules) {
        for (const file of m.files) {
            fileToModuleId.set(file, m.id);
        }
    }

    const depCounts = new Map<string, number>();

    for (const edge of edges) {
        const sourceModule = fileToModuleId.get(edge.source);
        const targetModule = fileToModuleId.get(edge.target);

        if (sourceModule && targetModule && sourceModule !== targetModule) {
            const key = `${sourceModule}->${targetModule}`;
            depCounts.set(key, (depCounts.get(key) || 0) + 1);
        }
    }

    const dependencies: ModuleDependency[] = [];
    for (const [key, count] of depCounts.entries()) {
        const [source, target] = key.split("->");
        dependencies.push({ source, target, count });
    }

    return dependencies;
}
