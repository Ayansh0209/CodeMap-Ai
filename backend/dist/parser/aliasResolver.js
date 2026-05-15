"use strict";
// src/parser/aliasResolver.ts
// ─────────────────────────────────────────────────────────────────────────────
// Deterministic alias resolution for TypeScript/JavaScript repos.
//
// Resolution priority (config-first):
//   1. tsconfig.json / jsconfig.json  → compilerOptions.paths + baseUrl
//   2. package.json "imports" field    → Node.js subpath imports (#alias)
//   3. package.json "exports" field    → self-referencing the package
//   4. Workspace / monorepo packages   → sibling packages in workspace
//   5. Framework fallbacks             → only if NO config was found
//
// All resolved paths are cached after first lookup. The cache is keyed by
// (specifier + fromFile) so re-running the same import costs O(1).
// ─────────────────────────────────────────────────────────────────────────────
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AliasResolver = void 0;
exports.isNodeBuiltin = isNodeBuiltin;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
// ── Node.js built-in modules ──────────────────────────────────────────────────
// Complete list as of Node 20. "node:" prefix is also accepted.
const NODE_BUILTINS = new Set([
    "assert", "async_hooks", "buffer", "child_process", "cluster", "console",
    "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain",
    "events", "fs", "http", "http2", "https", "inspector", "module", "net",
    "os", "path", "perf_hooks", "process", "punycode", "querystring",
    "readline", "repl", "stream", "string_decoder", "sys", "timers",
    "tls", "trace_events", "tty", "url", "util", "v8", "vm", "wasi",
    "worker_threads", "zlib",
]);
/** True if the specifier is a Node.js built-in (with or without the "node:" prefix) */
function isNodeBuiltin(specifier) {
    const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
    return NODE_BUILTINS.has(bare);
}
// ── File system helpers ───────────────────────────────────────────────────────
const EXTENSIONS_TO_TRY = [
    "", // exact match first
    ".ts", ".tsx",
    ".js", ".jsx",
    ".mjs", ".cjs",
    "/index.ts", "/index.tsx",
    "/index.js", "/index.jsx",
];
function tryResolveOnDisk(candidate) {
    for (const ext of EXTENSIONS_TO_TRY) {
        if (fs_1.default.existsSync(candidate + ext))
            return candidate + ext;
    }
    return null;
}
function safeReadJson(filePath) {
    try {
        const raw = fs_1.default.readFileSync(filePath, "utf-8");
        // Strip JS-style comments (tsconfig allows them, some tooling too)
        const stripped = raw
            .replace(/\/\/.*$/gm, "")
            .replace(/\/\*[\s\S]*?\*\//g, "");
        return JSON.parse(stripped);
    }
    catch {
        return null;
    }
}
// ── AliasResolver class ───────────────────────────────────────────────────────
class AliasResolver {
    constructor(repoRoot) {
        // Resolution cache: "specifier|fromAbsFile" → AliasResult
        this.cache = new Map();
        this.repoRoot = repoRoot;
        const { entries, hasConfig } = this.loadAllAliases();
        this.aliases = entries;
        this.hasConfigAlias = hasConfig;
        const pkgJson = safeReadJson(path_1.default.join(repoRoot, "package.json"));
        this.selfPackage = typeof pkgJson?.name === "string" ? pkgJson.name : null;
        this.workspacePkgs = this.detectWorkspacePackages(pkgJson);
        this.logSummary();
    }
    // ── Public API ────────────────────────────────────────────────────────────
    /**
     * Try to resolve a specifier as an alias/internal import.
     * Returns null if the specifier is clearly NOT an alias (e.g., relative "./foo").
     * Never throws.
     */
    resolve(specifier, fromAbsFile) {
        // Relative imports are never aliases — let ImportResolver handle them
        if (specifier.startsWith(".") || specifier.startsWith("/"))
            return null;
        // Node builtins are always external — no alias resolution needed
        if (isNodeBuiltin(specifier)) {
            return { kind: "external", packageName: specifier };
        }
        const cacheKey = `${specifier}|${fromAbsFile}`;
        if (this.cache.has(cacheKey))
            return this.cache.get(cacheKey);
        const result = this.resolveUncached(specifier, fromAbsFile);
        this.cache.set(cacheKey, result);
        return result;
    }
    // ── Core resolution logic ─────────────────────────────────────────────────
    resolveUncached(specifier, fromAbsFile) {
        // 1. Self-referencing by package name (e.g., "myapp/utils" in myapp)
        if (this.selfPackage && specifier === this.selfPackage) {
            const candidate = path_1.default.join(this.repoRoot, "src");
            const resolved = tryResolveOnDisk(candidate);
            if (resolved)
                return this.makeInternal(resolved);
        }
        if (this.selfPackage && specifier.startsWith(this.selfPackage + "/")) {
            const remainder = specifier.slice(this.selfPackage.length + 1);
            const candidate = path_1.default.join(this.repoRoot, remainder);
            const resolved = tryResolveOnDisk(candidate);
            if (resolved)
                return this.makeInternal(resolved);
        }
        // 2. Workspace packages (monorepo siblings)
        const pkgName = specifier.includes("/") && specifier.startsWith("@")
            ? specifier.split("/").slice(0, 2).join("/")
            : specifier.split("/")[0];
        const workspaceSrcDir = this.workspacePkgs.get(pkgName);
        if (workspaceSrcDir) {
            const remainder = specifier.slice(pkgName.length + 1) || "";
            const candidate = remainder
                ? path_1.default.join(workspaceSrcDir, remainder)
                : workspaceSrcDir;
            const resolved = tryResolveOnDisk(candidate);
            if (resolved)
                return this.makeInternal(resolved);
        }
        // 3. Alias table (tsconfig paths, jsconfig paths, package.json imports,
        //    framework fallbacks). Entries are already sorted longest-prefix-first.
        for (const entry of this.aliases) {
            if (!specifier.startsWith(entry.prefix))
                continue;
            const remainder = entry.isWildcard
                ? specifier.slice(entry.prefix.length)
                : "";
            for (const targetBase of entry.targets) {
                const candidate = remainder
                    ? path_1.default.join(targetBase, remainder)
                    : targetBase;
                const resolved = tryResolveOnDisk(candidate);
                if (resolved)
                    return this.makeInternal(resolved);
            }
            // If it was explicitly configured by the user, and it didn't exist on disk,
            // it's truly an unresolved alias.
            // If it's a safety fallback (e.g. we guessed 'redux/' might be 'src/redux/'),
            // we should just continue and eventually fall back to 'external'.
            if (entry.isExplicit) {
                return { kind: "unresolved" };
            }
        }
        return { kind: "external", packageName: pkgName };
    }
    makeInternal(absPath) {
        const relativePath = path_1.default.relative(this.repoRoot, absPath).replace(/\\/g, "/");
        return { kind: "internal", resolvedPath: relativePath };
    }
    // ── Alias table building ─────────────────────────────────────────────────
    loadAllAliases() {
        const entries = [];
        let hasConfig = false;
        // ── 1. Root tsconfig.json (highest priority) ─────────────────────────
        const tsConfigResult = this.loadTsOrJsConfigAt(path_1.default.join(this.repoRoot, "tsconfig.json"));
        if (tsConfigResult.length > 0) {
            entries.push(...tsConfigResult);
            hasConfig = true;
        }
        // ── 2. Root jsconfig.json ────────────────────────────────────────────
        const jsConfigResult = this.loadTsOrJsConfigAt(path_1.default.join(this.repoRoot, "jsconfig.json"));
        if (jsConfigResult.length > 0) {
            entries.push(...jsConfigResult);
            hasConfig = true;
        }
        // ── 3. Subdirectory configs (1 level deep) ───────────────────────────
        // Many repos have structure like frontend/, backend/, client/, server/
        // Each may have its own tsconfig/jsconfig with path aliases.
        const subConfigResults = this.loadSubdirectoryConfigs();
        if (subConfigResults.length > 0) {
            entries.push(...subConfigResults);
            hasConfig = true;
        }
        // ── 4. package.json "imports" (Node.js subpath imports #foo) ─────────
        const importEntries = this.loadPackageImports();
        if (importEntries.length > 0) {
            entries.push(...importEntries);
            hasConfig = true;
        }
        // ── 5. Safety fallbacks — ALWAYS ADDED at the lowest priority ────────
        // These cover common setups like CRA, Next.js without tsconfig paths,
        // Vite projects, or missing baseUrl. They are marked isExplicit=false
        // so if they don't resolve on disk, they fall through to external.
        entries.push(...this.safetyFallbacks());
        // Sort longest prefix first so more specific aliases win
        entries.sort((a, b) => b.prefix.length - a.prefix.length);
        return { entries, hasConfig };
    }
    /**
     * Load a single tsconfig.json or jsconfig.json from a specific absolute path.
     * Resolves baseUrl and paths relative to the config file's directory.
     */
    loadTsOrJsConfigAt(configPath) {
        const parsed = safeReadJson(configPath);
        if (!parsed)
            return [];
        const opts = (parsed.compilerOptions ?? {});
        const configDir = path_1.default.dirname(configPath);
        const entries = [];
        // baseUrl: resolve bare non-relative imports relative to this directory
        const rawBaseUrl = opts.baseUrl;
        if (rawBaseUrl) {
            const baseUrlAbs = path_1.default.resolve(configDir, rawBaseUrl);
            entries.push({
                prefix: "",
                targets: [baseUrlAbs],
                isWildcard: true,
                isExplicit: true,
            });
        }
        // paths: explicit alias mappings
        const paths = (opts.paths ?? {});
        for (const [alias, rawTargets] of Object.entries(paths)) {
            const isWildcard = alias.endsWith("/*");
            const prefix = isWildcard ? alias.slice(0, -2) : alias;
            // Resolve target paths relative to the config file's directory
            const targets = rawTargets.map((t) => {
                const bare = t.endsWith("/*") ? t.slice(0, -2) : t;
                return path_1.default.resolve(configDir, bare);
            });
            entries.push({ prefix, targets, isWildcard, isExplicit: true });
        }
        if (entries.length > 0) {
            console.log(`[aliasResolver] loaded ${entries.length} alias entries from ${configPath}`);
        }
        return entries;
    }
    /**
     * Scan immediate subdirectories for tsconfig.json / jsconfig.json.
     * This handles repos like E-commerce-website where the config lives
     * at frontend/jsconfig.json or client/tsconfig.json, not at the root.
     * Only scans 1 level deep to avoid performance issues.
     */
    loadSubdirectoryConfigs() {
        const entries = [];
        let dirEntries;
        try {
            dirEntries = fs_1.default.readdirSync(this.repoRoot);
        }
        catch {
            return [];
        }
        for (const entry of dirEntries) {
            const subDir = path_1.default.join(this.repoRoot, entry);
            try {
                if (!fs_1.default.statSync(subDir).isDirectory())
                    continue;
            }
            catch {
                continue;
            }
            // Skip node_modules, hidden dirs, and common non-source dirs
            if (entry.startsWith(".") || entry === "node_modules" || entry === "dist" || entry === "build")
                continue;
            for (const configName of ["tsconfig.json", "jsconfig.json"]) {
                const configPath = path_1.default.join(subDir, configName);
                const result = this.loadTsOrJsConfigAt(configPath);
                if (result.length > 0) {
                    entries.push(...result);
                }
            }
        }
        return entries;
    }
    loadPackageImports() {
        // Node.js "imports" field enables #-prefixed package-internal paths
        // e.g., "#utils" → "./src/utils.js"
        const pkgPath = path_1.default.join(this.repoRoot, "package.json");
        const parsed = safeReadJson(pkgPath);
        if (!parsed)
            return [];
        const imports = parsed.imports;
        if (!imports)
            return [];
        const entries = [];
        for (const [key, value] of Object.entries(imports)) {
            // Only handle string or simple condition-object targets
            const rawTarget = typeof value === "string"
                ? value
                : value?.default
                    ?? value?.require;
            if (!rawTarget)
                continue;
            const isWildcard = key.endsWith("/*");
            const prefix = isWildcard ? key.slice(0, -2) : key;
            const targetAbs = path_1.default.resolve(this.repoRoot, rawTarget.endsWith("/*") ? rawTarget.slice(0, -2) : rawTarget);
            entries.push({ prefix, targets: [targetAbs], isWildcard, isExplicit: true });
        }
        return entries;
    }
    /** Safety fallbacks for common directory structures. Lowest priority. */
    safetyFallbacks() {
        const root = this.repoRoot;
        const src = path_1.default.join(root, "src");
        const hasSrc = fs_1.default.existsSync(src);
        const srcOrRoot = hasSrc ? src : root;
        // Discover all possible source directories for alias targets.
        // For monorepo-style projects (e.g., E-commerce-website/frontend/src/),
        // we also check immediate subdirectory /src/ paths.
        const srcCandidates = [srcOrRoot];
        try {
            const rootEntries = fs_1.default.readdirSync(root);
            for (const entry of rootEntries) {
                if (entry.startsWith(".") || entry === "node_modules" || entry === "dist" || entry === "build")
                    continue;
                const subDir = path_1.default.join(root, entry);
                try {
                    if (!fs_1.default.statSync(subDir).isDirectory())
                        continue;
                }
                catch {
                    continue;
                }
                // If subDir/src exists, add it as a candidate
                const subSrc = path_1.default.join(subDir, "src");
                if (fs_1.default.existsSync(subSrc))
                    srcCandidates.push(subSrc);
                // Also add subDir itself (e.g., frontend/ could be the root of source)
                srcCandidates.push(subDir);
            }
        }
        catch { /* ignore */ }
        const fallbacks = [
            // Next.js / CRA / Vite convention: @/ → src/ (try all candidates)
            { prefix: "@/", targets: srcCandidates, isWildcard: true, isExplicit: false },
            { prefix: "~/", targets: srcCandidates, isWildcard: true, isExplicit: false },
            { prefix: "#/", targets: srcCandidates, isWildcard: true, isExplicit: false },
            // Bare @ alias: @components → src/components (try all candidates)
            { prefix: "@", targets: srcCandidates, isWildcard: true, isExplicit: false },
        ];
        // Bare folder fallbacks (e.g., "redux/product/productSlice")
        const commonDirs = [
            "components", "lib", "utils", "redux", "store",
            "services", "models", "context", "hooks", "config",
            "features", "pages", "layouts", "middleware",
            "helpers", "api", "actions", "reducers", "slices",
        ];
        for (const dir of commonDirs) {
            // Build targets: try each srcCandidate/<dir> path
            const targets = [];
            for (const base of srcCandidates) {
                targets.push(path_1.default.join(base, dir));
            }
            // Also try root/<dir> directly
            targets.push(path_1.default.join(root, dir));
            fallbacks.push({
                prefix: `${dir}/`,
                targets,
                isWildcard: true,
                isExplicit: false,
            });
        }
        return fallbacks;
    }
    // ── Workspace / monorepo detection ───────────────────────────────────────
    /**
     * Detect sibling workspace packages so that imports like "my-ui" in a
     * monorepo can resolve to the actual source instead of being marked external.
     *
     * Only scans one level of known workspace locations to stay lightweight:
     *   - "workspaces" glob from root package.json (npm/yarn)
     *   - "packages/*", "apps/*", "libs/*" as common monorepo conventions
     */
    detectWorkspacePackages(rootPkgJson) {
        const result = new Map();
        // Candidate workspace directories to scan
        const candidateDirs = [];
        // From package.json "workspaces" field (npm/yarn)
        const workspaces = rootPkgJson?.workspaces;
        const wsDirs = Array.isArray(workspaces)
            ? workspaces
            : workspaces?.packages ?? [];
        for (const ws of wsDirs) {
            // Handle "packages/*" glob — just take the literal directory name
            const dirName = ws.replace(/\/\*/g, "").replace(/\*/g, "");
            candidateDirs.push(path_1.default.join(this.repoRoot, dirName));
        }
        // Common monorepo conventions (add if they exist on disk)
        for (const dir of ["packages", "apps", "libs", "modules", "services"]) {
            const abs = path_1.default.join(this.repoRoot, dir);
            if (fs_1.default.existsSync(abs))
                candidateDirs.push(abs);
        }
        // Scan each candidate directory for sub-packages
        for (const dir of candidateDirs) {
            if (!fs_1.default.existsSync(dir))
                continue;
            let entries;
            try {
                entries = fs_1.default.readdirSync(dir);
            }
            catch {
                continue;
            }
            for (const entry of entries) {
                const pkgDir = path_1.default.join(dir, entry);
                const pkgJsonPath = path_1.default.join(pkgDir, "package.json");
                const pkgJson = safeReadJson(pkgJsonPath);
                if (!pkgJson || typeof pkgJson.name !== "string")
                    continue;
                // Map package name → its src directory (prefer /src, fall back to root)
                const srcDir = path_1.default.join(pkgDir, "src");
                result.set(pkgJson.name, fs_1.default.existsSync(srcDir) ? srcDir : pkgDir);
            }
        }
        return result;
    }
    // ── Diagnostics ───────────────────────────────────────────────────────────
    logSummary() {
        const aliasCount = this.aliases.filter((a) => a.prefix !== "").length;
        const hasBaseUrl = this.aliases.some((a) => a.prefix === "");
        const wsPkgCount = this.workspacePkgs.size;
        console.log(`[aliasResolver] loaded — ` +
            `aliases: ${aliasCount}, ` +
            `baseUrl: ${hasBaseUrl}, ` +
            `workspace pkgs: ${wsPkgCount}, ` +
            `self: ${this.selfPackage ?? "none"}, ` +
            `framework fallbacks: ${!this.hasConfigAlias}`);
        if (aliasCount > 0) {
            const preview = this.aliases
                .filter((a) => a.prefix !== "")
                .slice(0, 8)
                .map((a) => `"${a.prefix}${a.isWildcard ? "*" : ""}"`)
                .join(", ");
            console.log(`[aliasResolver] alias prefixes: ${preview}`);
        }
    }
}
exports.AliasResolver = AliasResolver;
