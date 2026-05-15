"use strict";
// src/parser/entryScorer.ts
// ─────────────────────────────────────────────────────────────────────────────
// Deterministic entry point scoring for repo files.
//
// Replaces naive filename checks (index.ts, server.js) with a weighted signal
// system that correctly identifies TRUE application entry points vs. examples,
// tests, scaffolding, or library barrel files.
//
// Score interpretation:
//   >= ENTRY_THRESHOLD  → isEntryPoint = true
//   < ENTRY_THRESHOLD   → isEntryPoint = false (but score still stored for debug)
//
// Design goals:
//   - Purely deterministic — no AI, no heuristics beyond simple string/AST checks
//   - All signals are auditable via entryReasons[] on the FileNode
//   - Penalties ensure example/demo/scaffold folders never dominate
// ─────────────────────────────────────────────────────────────────────────────
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ENTRY_THRESHOLD = void 0;
exports.applyEntryScoring = applyEntryScoring;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
// ── Constants ─────────────────────────────────────────────────────────────────
/** Files that score at or above this threshold are marked isEntryPoint = true */
exports.ENTRY_THRESHOLD = 15;
function safeReadJson(filePath) {
    try {
        const raw = fs_1.default.readFileSync(filePath, "utf-8");
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
/**
 * Normalize a package.json path field (relative to package dir) to a
 * canonical forward-slash path relative to repo root.
 */
function normalizePkgPath(raw, pkgDir, repoRoot) {
    const abs = path_1.default.resolve(pkgDir, raw);
    // Strip extensions for matching — some package.json use ".js" but source is ".ts"
    const rel = path_1.default.relative(repoRoot, abs).replace(/\\/g, "/");
    return rel.replace(/\.(js|mjs|cjs|jsx|ts|tsx)$/, "");
}
/**
 * Extract canonical entry paths from a package.json.
 * Handles main, module, bin (string or object), and simple exports.
 */
function loadPackageEntryFields(pkgJsonPath, repoRoot) {
    const parsed = safeReadJson(pkgJsonPath);
    if (!parsed)
        return { main: null, module: null, bin: [], exports: [] };
    const pkgDir = path_1.default.dirname(pkgJsonPath);
    const main = typeof parsed.main === "string"
        ? normalizePkgPath(parsed.main, pkgDir, repoRoot)
        : null;
    const module_ = typeof parsed.module === "string"
        ? normalizePkgPath(parsed.module, pkgDir, repoRoot)
        : null;
    // bin: either a string or { name: path } object
    const binPaths = [];
    if (typeof parsed.bin === "string") {
        binPaths.push(normalizePkgPath(parsed.bin, pkgDir, repoRoot));
    }
    else if (parsed.bin && typeof parsed.bin === "object") {
        for (const v of Object.values(parsed.bin)) {
            if (typeof v === "string")
                binPaths.push(normalizePkgPath(v, pkgDir, repoRoot));
        }
    }
    // exports: only handle simple string value at "." or root string
    const exportPaths = [];
    const exportsField = parsed.exports;
    if (typeof exportsField === "string") {
        exportPaths.push(normalizePkgPath(exportsField, pkgDir, repoRoot));
    }
    else if (exportsField && typeof exportsField === "object") {
        const dot = exportsField["."];
        if (typeof dot === "string")
            exportPaths.push(normalizePkgPath(dot, pkgDir, repoRoot));
    }
    return { main, module: module_, bin: binPaths, exports: exportPaths };
}
// ── Path penalty helpers ───────────────────────────────────────────────────────
/**
 * Folder segments that strongly indicate this file is NOT a primary entry point.
 * Any file inside these directories gets a heavy penalty.
 */
const PENALTY_FOLDER_SEGMENTS = new Set([
    "example", "examples",
    "demo", "demos",
    "test", "tests", "__tests__",
    "spec", "specs",
    "fixture", "fixtures",
    "seed", "seeds",
    "migration", "migrations",
    "scaffold", "scaffolds",
    "scripts", // build/deploy scripts — not runtime entry
    "tools",
    "bench", "benchmarks",
    "docs", "documentation",
    "storybook", ".storybook",
    "e2e",
    "cypress",
    "mocks", "__mocks__",
]);
/**
 * Entry-point filename stems (without extension).
 * Files with these names get a moderate bonus.
 */
const ENTRY_STEMS = new Set([
    "index", "main", "server", "app",
    "entry", "start", "init",
    "bootstrap", "run",
    "cli", "bin",
]);
/**
 * Next.js app router semantic files.
 * These are inherently entry points for specific routes/layouts.
 */
const NEXTJS_SEMANTIC_STEMS = new Set([
    "page", "layout", "route", "loading", "error", "middleware"
]);
// ── Scorer ────────────────────────────────────────────────────────────────────
function scoreFile(input) {
    const { file, inDegree, outDegree, hasStartupSignals, hasRouteHandlers, pkgFields } = input;
    const filePath = file.id; // forward-slash relative path
    let score = 0;
    const reasons = [];
    function add(pts, reason) {
        score += pts;
        reasons.push(`${reason} ${pts > 0 ? "+" : ""}${pts}`);
    }
    // ── Penalties (applied first — disqualifiers) ─────────────────────────────
    // Check every path segment for known penalty folders
    const segments = filePath.split("/");
    const penaltySegment = segments.find((s) => PENALTY_FOLDER_SEGMENTS.has(s.toLowerCase()));
    if (penaltySegment) {
        add(-50, `in "${penaltySegment}/" folder (example/test/script penalty)`);
    }
    // Config files are never entry points regardless of name
    if (file.kind === "config") {
        add(-30, "config file kind");
    }
    // Declaration files are never entry points
    if (file.kind === "declaration") {
        add(-100, "declaration file (.d.ts)");
    }
    // Test files are never entry points
    if (file.kind === "test") {
        add(-50, "test file kind");
    }
    // ── Bonus: package.json explicit entry references ─────────────────────────
    // Strip extension for comparison (source might be .ts but pkg references .js)
    const filePathNoExt = filePath.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
    if (pkgFields.main && filePathNoExt === pkgFields.main) {
        add(20, `package.json "main"`);
    }
    if (pkgFields.module && filePathNoExt === pkgFields.module) {
        add(20, `package.json "module"`);
    }
    if (pkgFields.bin.includes(filePathNoExt)) {
        add(20, `package.json "bin"`);
    }
    if (pkgFields.exports.includes(filePathNoExt)) {
        add(15, `package.json "exports" root`);
    }
    // ── Bonus: filename stem ──────────────────────────────────────────────────
    const stem = path_1.default.basename(filePath, path_1.default.extname(filePath)).toLowerCase();
    if (ENTRY_STEMS.has(stem)) {
        add(15, `entry filename stem "${stem}"`);
    }
    else if (NEXTJS_SEMANTIC_STEMS.has(stem)) {
        add(15, `Next.js semantic file "${stem}"`);
    }
    // ── Bonus: root depth ─────────────────────────────────────────────────────
    // Files at repo root (depth 1) get the full bonus.
    // Files one level deep (src/index.ts) get a smaller bonus.
    // Deeper files get nothing.
    const depth = filePath.split("/").length; // 1 = root file, 2 = one folder deep
    if (depth === 1) {
        add(10, "root-level file");
    }
    else if (depth === 2) {
        add(5, "one directory deep");
    }
    // ── Bonus: AST startup signals ────────────────────────────────────────────
    if (hasStartupSignals) {
        add(10, "server startup call (app.listen / createServer)");
    }
    if (hasRouteHandlers) {
        add(8, "route handler registration (app.get/post/use)");
    }
    // ── Bonus: graph topology ─────────────────────────────────────────────────
    // A true entry point is typically imported by NOTHING (inDegree = 0)
    // but imports several things (outDegree > 0). This avoids promoting
    // leaf utility files.
    if (inDegree === 0 && outDegree > 0) {
        add(8, `graph root (inDegree=0, outDegree=${outDegree})`);
    }
    // High in-degree files are likely shared utilities, not entry points
    if (inDegree >= 10) {
        add(-5, `high import count (inDegree=${inDegree}, likely utility)`);
    }
    return { score, reasons };
}
/**
 * Score all files and update their isEntryPoint, entryScore, and entryReasons fields.
 * Mutates fileNodes in-place so the rest of the builder pipeline is unaffected.
 *
 * Call this AFTER all fileNodes and importEdges are assembled (so degree counts
 * are accurate).
 */
function applyEntryScoring(fileNodes, importEdges, options) {
    const { repoRoot, startupSignals, routeHandlers } = options;
    // ── Load package.json ─────────────────────────────────────────────────────
    const pkgFields = loadPackageEntryFields(path_1.default.join(repoRoot, "package.json"), repoRoot);
    // ── Build degree maps from import edges ───────────────────────────────────
    const inDegree = new Map();
    const outDegree = new Map();
    for (const edge of importEdges) {
        outDegree.set(edge.source, (outDegree.get(edge.source) ?? 0) + 1);
        inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
    }
    // ── Score each file ───────────────────────────────────────────────────────
    let entryCount = 0;
    for (const file of fileNodes) {
        const result = scoreFile({
            file,
            inDegree: inDegree.get(file.id) ?? 0,
            outDegree: outDegree.get(file.id) ?? 0,
            hasStartupSignals: startupSignals.get(file.id) ?? false,
            hasRouteHandlers: routeHandlers.get(file.id) ?? false,
            pkgFields,
        });
        file.entryScore = result.score;
        file.entryReasons = result.reasons;
        file.isEntryPoint = result.score >= exports.ENTRY_THRESHOLD;
        if (file.isEntryPoint)
            entryCount++;
    }
    console.log(`[entryScorer] scored ${fileNodes.length} files — ` +
        `${entryCount} entry points (threshold=${exports.ENTRY_THRESHOLD})`);
}
