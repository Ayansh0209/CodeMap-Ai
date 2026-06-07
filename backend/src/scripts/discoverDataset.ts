#!/usr/bin/env tsx
// src/scripts/discoverDataset.ts
// ─────────────────────────────────────────────────────────────────────────────
// Automatically discovers valid issue/PR pairs from GitHub API.
//
// For each target repo:
//   1. Fetch recently closed issues
//   2. For each issue, scan its timeline for cross-referenced merged PRs
//   3. Validate the PR against our criteria (not docs-only, not deps-only, etc.)
//   4. Collect until we have enough valid entries per repo
//
// Output: prints dataset.ts entries you can paste directly into dataset.ts
//
// Usage:
//   npx tsx src/scripts/discoverDataset.ts
//   npx tsx src/scripts/discoverDataset.ts --repo PalisadoesFoundation/talawa-api --count 5
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { Octokit } from "@octokit/rest";
import { config } from "../config/config";

const octokit = new Octokit({ auth: config.github.token });

// ── Target repos ───────────────────────────────────────────────────────────────

const TARGET_REPOS = [
    { owner: "PalisadoesFoundation", repo: "talawa-api",  size: "small",      want: 5 },
    { owner: "colinhacks",           repo: "zod",          size: "small",      want: 4 },
    { owner: "trpc",                 repo: "trpc",         size: "medium",     want: 4 },
    { owner: "nestjs",               repo: "nest",         size: "large",      want: 4 },
    { owner: "TryGhost",             repo: "Ghost",        size: "medium",     want: 4 },
];

// CLI overrides
const args = process.argv.slice(2);
const repoFilter = args.includes("--repo") ? args[args.indexOf("--repo") + 1] : null;
const countArg   = args.includes("--count") ? parseInt(args[args.indexOf("--count") + 1]) : null;

// ── File classification (same as prValidator) ─────────────────────────────────

const DOC_EXT  = new Set([".md", ".mdx", ".txt", ".rst", ".adoc"]);
const DEP_FILES = new Set(["package-lock.json","yarn.lock","pnpm-lock.yaml","go.sum","go.mod","Cargo.lock","poetry.lock"]);
const GEN_PAT   = [/\.generated\.(ts|js|go)$/i, /\/migrations\//, /\/generated\//, /\.pb\.go$/, /vendor\//];

const SUPPORTED_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

function isCode(f: string): boolean {
    const p = f.toLowerCase();
    const ext = "." + (p.split(".").pop() ?? "");
    const base = p.split("/").pop() ?? p;
    if (DOC_EXT.has(ext)) return false;
    if (DEP_FILES.has(base)) return false;
    if (GEN_PAT.some(r => r.test(p))) return false;
    return SUPPORTED_EXT.has(ext);
}

// ── Per-PR validation ─────────────────────────────────────────────────────────

async function validatePR(
    owner: string,
    repo: string,
    prNumber: number
): Promise<{ valid: boolean; files: string[]; reason?: string }> {
    try {
        const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
        if (!pr.merged) return { valid: false, files: [], reason: "not_merged" };

        const allFiles: string[] = [];
        for (let page = 1; page <= 2; page++) {
            const { data: f } = await octokit.pulls.listFiles({
                owner, repo, pull_number: prNumber, per_page: 100, page
            });
            allFiles.push(...f.map(x => x.filename));
            if (f.length < 100) break;
        }

        if (allFiles.length > 50) return { valid: false, files: allFiles, reason: "too_many_files" };
        const codeFiles = allFiles.filter(isCode);
        if (codeFiles.length === 0) return { valid: false, files: allFiles, reason: "no_code_files" };

        const docRatio = (allFiles.length - codeFiles.length) / allFiles.length;
        if (docRatio > 0.8) return { valid: false, files: allFiles, reason: "mostly_docs" };

        return { valid: true, files: allFiles };
    } catch (err: any) {
        console.log(`      validatePR error: ${err.message}`);
        return { valid: false, files: [], reason: "api_error" };
    }
}

// ── Timeline PR discovery ─────────────────────────────────────────────────────

async function findLinkedMergedPR(
    owner: string,
    repo: string,
    issueNumber: number
): Promise<number | null> {
    try {
        const { data: timeline } = await octokit.issues.listEventsForTimeline({
            owner, repo, issue_number: issueNumber, per_page: 100,
            headers: { accept: "application/vnd.github.mockingbird-preview+json" },
        });

        for (const event of timeline) {
            if (
                event.event === "cross-referenced" &&
                (event as any).source?.type === "issue" &&
                (event as any).source?.issue?.pull_request
            ) {
                const prNumber: number = (event as any).source.issue.number;
                return prNumber;
            }
        }
        return null;
    } catch {
        return null;
    }
}

// ── Issue body length check ───────────────────────────────────────────────────

function hasGoodContext(body: string | null): boolean {
    if (!body) return false;
    return body.trim().length >= 100; // at least 100 chars of context
}

// ── Main discovery per repo ───────────────────────────────────────────────────

interface DiscoveredEntry {
    id: string;
    owner: string;
    repo: string;
    size: string;
    issueNumber: number;
    prNumber: number;
    issueTitle: string;
    prFiles: string[];
    codeFileCount: number;
}

async function discoverRepo(
    owner: string,
    repo: string,
    size: string,
    want: number
): Promise<DiscoveredEntry[]> {
    const found: DiscoveredEntry[] = [];
    let page = 1;

    console.log(`\n  Searching ${owner}/${repo} (want ${want} entries)...`);

    while (found.length < want && page <= 10) {
        let issues: any[];
        try {
            const { data } = await octokit.issues.listForRepo({
                owner, repo,
                state: "closed",
                per_page: 30,
                page,
                sort: "updated",
                direction: "desc",
            });
            // Filter out PRs from issue list
            issues = data.filter((i: any) => !i.pull_request);
        } catch (err: any) {
            console.log(`    Error fetching issues: ${err?.message}`);
            break;
        }

        if (issues.length === 0) break;

        for (const issue of issues) {
            if (found.length >= want) break;
            if (!hasGoodContext(issue.body)) continue;

            // Avoid issues that are just "Closes #X" comments
            const body: string = issue.body ?? "";
            if (body.trim().length < 100) continue;

            // Rate limit pause
            await new Promise(r => setTimeout(r, 300));

            const prNumber = await findLinkedMergedPR(owner, repo, issue.number);
            if (!prNumber) continue;

            await new Promise(r => setTimeout(r, 300));

            const { valid, files, reason } = await validatePR(owner, repo, prNumber);
            if (!valid) {
                process.stdout.write(`    ⚠ #${issue.number} → PR #${prNumber}: ${reason}\n`);
                continue;
            }

            const codeFiles = files.filter(isCode);
            const repoSlug = repo.replace(/\./g, "_").replace(/-/g, "_");
            const entryId = `${repoSlug}-${found.length + 1}`;

            found.push({
                id: entryId,
                owner,
                repo,
                size,
                issueNumber: issue.number,
                prNumber,
                issueTitle: issue.title,
                prFiles: files,
                codeFileCount: codeFiles.length,
            });

            console.log(
                `    ✅ #${issue.number} → PR #${prNumber} (${codeFiles.length} code files): ${issue.title.slice(0, 60)}`
            );
        }

        page++;
        await new Promise(r => setTimeout(r, 500));
    }

    if (found.length < want) {
        console.log(`    ⚠ Only found ${found.length}/${want} valid entries`);
    }

    return found;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
    console.log(`║  CodeMap AI — Dataset Discovery                              ║`);
    console.log(`╚══════════════════════════════════════════════════════════════╝`);

    let targets = TARGET_REPOS;
    if (repoFilter) {
        const [o, r] = repoFilter.split("/");
        targets = targets.filter(t => t.owner === o && t.repo === r);
    }
    if (countArg) {
        targets = targets.map(t => ({ ...t, want: countArg }));
    }

    const allDiscovered: DiscoveredEntry[] = [];

    for (const target of targets) {
        const entries = await discoverRepo(target.owner, target.repo, target.size, target.want);
        allDiscovered.push(...entries);
    }

    // ── Output dataset.ts snippet ─────────────────────────────────────────────
    console.log(`\n\n${"═".repeat(70)}`);
    console.log(`  VERIFIED DATASET ENTRIES — paste these into dataset.ts`);
    console.log(`${"═".repeat(70)}\n`);

    for (const e of allDiscovered) {
        console.log(`    {`);
        console.log(`        id: "${e.id}",`);
        console.log(`        owner: "${e.owner}",`);
        console.log(`        repo: "${e.repo}",`);
        console.log(`        size: "${e.size}",`);
        console.log(`        issueNumber: ${e.issueNumber},`);
        console.log(`        prNumber: ${e.prNumber},`);
        console.log(`        description: "${e.issueTitle.replace(/"/g, '\\"').slice(0, 80)}",`);
        console.log(`        tags: [],`);
        console.log(`    },`);
    }

    console.log(`\n${"═".repeat(70)}`);
    console.log(`  Total discovered: ${allDiscovered.length} valid entries`);
    console.log(`  Run validateDataset.ts to confirm.\n`);
}

main().catch(err => {
    console.error("Discovery failed:", err);
    process.exit(1);
});
