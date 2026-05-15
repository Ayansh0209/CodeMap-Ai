"use strict";
// backend/src/github/issueClient.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchIssue = fetchIssue;
exports.fetchOpenIssues = fetchOpenIssues;
exports.fetchIssueComments = fetchIssueComments;
exports.fetchLinkedPRs = fetchLinkedPRs;
exports.fetchRawFile = fetchRawFile;
const rest_1 = require("@octokit/rest");
const config_1 = require("../config/config");
const octokit = new rest_1.Octokit({ auth: config_1.config.github.token });
// Fetch a single issue
async function fetchIssue(owner, repo, issueNumber) {
    const { data } = await octokit.issues.get({
        owner, repo, issue_number: issueNumber
    });
    return {
        number: data.number,
        title: data.title,
        body: data.body ?? "",
        htmlUrl: data.html_url,
        labels: data.labels
            .map((l) => (typeof l === "string" ? l : l.name ?? ""))
            .filter(Boolean),
        state: data.state,
    };
}
// Fetch open issues list (summary only)
async function fetchOpenIssues(owner, repo, limit = 100) {
    const { data } = await octokit.issues.listForRepo({
        owner, repo,
        state: "open",
        per_page: Math.min(limit, 100),
        sort: "updated",
        direction: "desc",
    });
    return data
        .filter((i) => !i.pull_request) // exclude PRs from issue list
        .map((i) => ({
        number: i.number,
        title: i.title,
        body: i.body ?? "",
        htmlUrl: i.html_url,
        labels: i.labels
            .map((l) => (typeof l === "string" ? l : l.name ?? ""))
            .filter(Boolean),
        state: i.state,
    }));
}
// Fetch comments on an issue
async function fetchIssueComments(owner, repo, issueNumber, limit = 10) {
    try {
        const { data } = await octokit.issues.listComments({
            owner, repo,
            issue_number: issueNumber,
            per_page: Math.min(limit, 30),
        });
        return data.map((c) => ({
            author: c.user?.login ?? "unknown",
            body: c.body ?? "",
            createdAt: c.created_at,
        }));
    }
    catch {
        return [];
    }
}
// Fetch PRs linked to this issue using timeline events
// This is the reliable way — GitHub tracks cross-references automatically
async function fetchLinkedPRs(owner, repo, issueNumber) {
    try {
        // Use timeline API to find cross-referenced PRs
        const { data: timeline } = await octokit.issues.listEventsForTimeline({
            owner,
            repo,
            issue_number: issueNumber,
            per_page: 100,
            headers: {
                accept: "application/vnd.github.mockingbird-preview+json",
            },
        });
        // Find cross-reference events that are PRs
        const prNumbers = new Set();
        for (const event of timeline) {
            if (event.event === "cross-referenced" &&
                event.source?.type === "issue" &&
                event.source?.issue?.pull_request) {
                prNumbers.add(event.source.issue.number);
            }
        }
        if (prNumbers.size === 0)
            return [];
        const prs = [];
        for (const prNumber of [...prNumbers].slice(0, 5)) {
            try {
                const { data: prData } = await octokit.pulls.get({
                    owner,
                    repo,
                    pull_number: prNumber,
                });
                const { data: filesData } = await octokit.pulls.listFiles({
                    owner,
                    repo,
                    pull_number: prNumber,
                    per_page: 30,
                });
                prs.push({
                    number: prNumber,
                    title: prData.title,
                    state: prData.state,
                    merged: prData.merged ?? false,
                    changedFiles: filesData.map((f) => f.filename),
                    htmlUrl: prData.html_url,
                });
            }
            catch {
                continue;
            }
        }
        console.log(`[issueClient] found ${prs.length} linked PRs for #${issueNumber} via timeline`);
        return prs;
    }
    catch {
        return [];
    }
}
// Fetch raw file content from GitHub using native fetch
async function fetchRawFile(owner, repo, commitSha, fileId) {
    try {
        const url = `https://raw.githubusercontent.com/${owner}/${repo}/${commitSha}/${fileId}`;
        const response = await fetch(url, {
            headers: {
                Authorization: `token ${config_1.config.github.token}`,
            },
        });
        if (!response.ok) {
            console.log(`[issueClient] Failed to fetch ${fileId}: ${response.statusText}`);
            return "";
        }
        const content = await response.text();
        const lines = content.split("\n").length;
        console.log(`[issueClient] fetched ${fileId} — ${lines} lines`);
        return content;
    }
    catch (err) {
        console.error(`[issueClient] Error fetching ${fileId}:`, err);
        return "";
    }
}
