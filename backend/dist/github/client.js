"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchRepoMetadata = fetchRepoMetadata;
const rest_1 = require("@octokit/rest");
const config_1 = require("../config/config");
const octokit = new rest_1.Octokit({
    auth: config_1.config.github.token,
});
async function fetchRepoMetadata(owner, repo) {
    const { data } = await octokit.repos.get({ owner, repo });
    const sizeMB = data.size / 1024;
    if (data.private) {
        throw new Error("Private repositories are not supported yet");
    }
    if (sizeMB > 500) {
        throw new Error(`Repository too large: ${sizeMB.toFixed(0)}MB. Maximum is 500MB`);
    }
    // get latest commit SHA on default branch
    // this SHA is your cache key - immutable forever
    const { data: commit } = await octokit.repos.getCommit({
        owner,
        repo,
        ref: data.default_branch,
    });
    return {
        defaultBranch: data.default_branch,
        commitSha: commit.sha,
        sizeMB,
        isPrivate: data.private,
        owner,
        repo,
    };
}
