// src/eval/prValidator.ts
// ─────────────────────────────────────────────────────────────────────────────
// Validates benchmark dataset entries against live GitHub API.
//
// Rejection criteria (benchmark pollution prevention):
//   - PR not merged (open or closed-without-merge)
//   - PR changes >50 files (massive refactor — unrealistic benchmark target)
//   - >80% of changed files are documentation (.md, .mdx, .txt, .rst)
//   - Only lockfile/package.json changes (dependency bumps)
//   - Only generated files (*.generated.ts, migrations, proto files)
//   - Issue not found or PR not found via GitHub API
//   - No code files at all in the PR
//
// Validation is run BEFORE evaluation so bad entries never pollute metrics.
// ─────────────────────────────────────────────────────────────────────────────

import { Octokit } from "@octokit/rest";
import { config } from "../config/config";
import type { DatasetEntry, PRValidationResult, PRRejectionReason } from "./types";

const octokit = new Octokit({ auth: config.github.token });

// ── File classification helpers ───────────────────────────────────────────────

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst", ".adoc", ".wiki"]);
const DOC_PATHS = ["docs/", "documentation/", ".github/", "CHANGELOG", "LICENSE", "README"];

const DEP_FILES = new Set([
    "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "go.sum", "go.mod", "Gemfile.lock", "Cargo.lock", "poetry.lock",
    "requirements.txt", "pipfile.lock",
]);

const GENERATED_PATTERNS = [
    /\.generated\.(ts|js|go|py)$/i,
    /\/migrations\//,
    /\/generated\//,
    /\.pb\.go$/,
    /\.pb\.ts$/,
    /_pb\.d\.ts$/,
    /schema\.graphql$/, // only when this is the only file
    /vendor\//,
];

const SUPPORTED_EXTENSIONS = new Set([
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"
]);

function isSupportedCodeFile(filePath: string): boolean {
    const ext = "." + filePath.toLowerCase().split(".").pop();
    return SUPPORTED_EXTENSIONS.has(ext);
}

const CODE_EXTENSIONS = new Set([
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".go", ".py", ".rs", ".java", ".cpp", ".c", ".h", ".hpp", ".cs", ".rb", ".php", ".swift", ".kt"
]);

function isAnyCodeFile(filePath: string): boolean {
    const ext = "." + filePath.toLowerCase().split(".").pop();
    return CODE_EXTENSIONS.has(ext);
}

function isDocFile(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    const ext = "." + lower.split(".").pop();
    if (DOC_EXTENSIONS.has(ext)) return true;
    return DOC_PATHS.some(p => lower.includes(p.toLowerCase()));
}

function isDepFile(filePath: string): boolean {
    const base = filePath.split("/").pop() ?? filePath;
    return DEP_FILES.has(base);
}

function isGeneratedFile(filePath: string): boolean {
    return GENERATED_PATTERNS.some(p => p.test(filePath));
}

function isCodeFile(filePath: string): boolean {
    return !isDocFile(filePath) && !isDepFile(filePath) && !isGeneratedFile(filePath) && isSupportedCodeFile(filePath);
}

// ── Main validator ────────────────────────────────────────────────────────────

export async function validateEntry(entry: DatasetEntry): Promise<PRValidationResult> {
    // 1. Verify issue exists
    try {
        await octokit.issues.get({
            owner: entry.owner,
            repo: entry.repo,
            issue_number: entry.issueNumber,
        });
    } catch (err: any) {
        const reason: PRRejectionReason = err?.status === 404 ? "issue_not_found" : "issue_not_found";
        return {
            entry,
            valid: false,
            rejectionReason: reason,
            prFiles: [],
            codeFileCount: 0,
            summary: `Issue #${entry.issueNumber} not found: ${err?.message}`,
        };
    }

    // 2. Verify PR exists and is merged
    let prData: any;
    try {
        const { data } = await octokit.pulls.get({
            owner: entry.owner,
            repo: entry.repo,
            pull_number: entry.prNumber,
        });
        prData = data;
    } catch (err: any) {
        return {
            entry,
            valid: false,
            rejectionReason: "pr_not_found",
            prFiles: [],
            codeFileCount: 0,
            summary: `PR #${entry.prNumber} not found: ${err?.message}`,
        };
    }

    if (!prData.merged) {
        return {
            entry,
            valid: false,
            rejectionReason: "not_merged",
            prFiles: [],
            codeFileCount: 0,
            summary: `PR #${entry.prNumber} is not merged (state=${prData.state})`,
        };
    }

    // 3. Fetch changed files
    let allFiles: string[] = [];
    try {
        // GitHub API paginates at 30, max 300. Fetch up to 3 pages.
        for (let page = 1; page <= 3; page++) {
            const { data: pageFiles } = await octokit.pulls.listFiles({
                owner: entry.owner,
                repo: entry.repo,
                pull_number: entry.prNumber,
                per_page: 100,
                page,
            });
            allFiles.push(...pageFiles.map(f => f.filename));
            if (pageFiles.length < 100) break;
        }
    } catch (err: any) {
        return {
            entry,
            valid: false,
            rejectionReason: "pr_not_found",
            prFiles: [],
            codeFileCount: 0,
            summary: `Failed to list PR files: ${err?.message}`,
        };
    }

    // 4. Check rejection criteria

    // Too large
    if (allFiles.length > 50) {
        return {
            entry,
            valid: false,
            rejectionReason: "too_many_files",
            prFiles: allFiles,
            codeFileCount: allFiles.filter(isCodeFile).length,
            summary: `PR #${entry.prNumber} has ${allFiles.length} changed files — too large for meaningful benchmark`,
        };
    }

    const docFiles = allFiles.filter(isDocFile);
    const depFiles = allFiles.filter(isDepFile);
    const generatedFiles = allFiles.filter(isGeneratedFile);
    const codeFiles = allFiles.filter(isCodeFile);

    // Docs only
    if (docFiles.length > 0 && codeFiles.length === 0) {
        return {
            entry,
            valid: false,
            rejectionReason: "docs_only",
            prFiles: allFiles,
            codeFileCount: 0,
            summary: `PR #${entry.prNumber} only changes documentation files`,
        };
    }

    // Mostly docs (>80%)
    if (allFiles.length > 0 && docFiles.length / allFiles.length > 0.8) {
        return {
            entry,
            valid: false,
            rejectionReason: "docs_only",
            prFiles: allFiles,
            codeFileCount: codeFiles.length,
            summary: `PR #${entry.prNumber} is ${Math.round(docFiles.length / allFiles.length * 100)}% documentation`,
        };
    }

    // Deps only
    if (depFiles.length > 0 && codeFiles.length === 0) {
        return {
            entry,
            valid: false,
            rejectionReason: "deps_only",
            prFiles: allFiles,
            codeFileCount: 0,
            summary: `PR #${entry.prNumber} only changes dependency files`,
        };
    }

    // Dep-heavy check (e.g. >70% deps and <=2 code files)
    if (allFiles.length > 0 && depFiles.length / allFiles.length > 0.7 && codeFiles.length <= 2) {
        return {
            entry,
            valid: false,
            rejectionReason: "deps_only",
            prFiles: allFiles,
            codeFileCount: codeFiles.length,
            summary: `PR #${entry.prNumber} is dependency-heavy (${Math.round(depFiles.length / allFiles.length * 100)}% dependencies) with only ${codeFiles.length} code files`,
        };
    }

    // Generated only
    if (generatedFiles.length > 0 && codeFiles.length === 0) {
        return {
            entry,
            valid: false,
            rejectionReason: "generated_only",
            prFiles: allFiles,
            codeFileCount: 0,
            summary: `PR #${entry.prNumber} only changes generated/migration files`,
        };
    }

    // No code files at all or unsupported language
    if (codeFiles.length === 0) {
        const hasAnyCode = allFiles.some(isAnyCodeFile);
        return {
            entry,
            valid: false,
            rejectionReason: hasAnyCode ? "unsupported_language" : "no_code_files",
            prFiles: allFiles,
            codeFileCount: 0,
            summary: hasAnyCode
                ? `PR #${entry.prNumber} contains code in unsupported languages`
                : `PR #${entry.prNumber} has no recognizable code files`,
        };
    }

    return {
        entry,
        valid: true,
        prFiles: allFiles,
        codeFileCount: codeFiles.length,
        summary: `OK — ${allFiles.length} total files, ${codeFiles.length} code files`,
    };
}

export async function validateAll(
    dataset: DatasetEntry[],
    onProgress?: (done: number, total: number, result: PRValidationResult) => void
): Promise<PRValidationResult[]> {
    const results: PRValidationResult[] = [];

    for (let i = 0; i < dataset.length; i++) {
        const entry = dataset[i];
        const result = await validateEntry(entry);
        results.push(result);
        onProgress?.(i + 1, dataset.length, result);

        // Rate-limit: GitHub allows ~80 core requests/minute authenticated
        await new Promise(r => setTimeout(r, 400));
    }

    return results;
}
