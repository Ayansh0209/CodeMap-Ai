// src/eval/dataset.ts
// ─────────────────────────────────────────────────────────────────────────────
// Curated benchmark dataset: real GitHub JS/TS issues with verified merged PRs.
// All repositories are under the 500MB limit for local environments.
// ─────────────────────────────────────────────────────────────────────────────

import type { DatasetEntry } from "./types";

export const BENCHMARK_DATASET: DatasetEntry[] = [

    // ── SMALL — PalisadoesFoundation/talawa-api (JS/TS) ─────────────────────
    {
        id: "talawa-1",
        owner: "PalisadoesFoundation",
        repo: "talawa-api",
        size: "small",
        issueNumber: 4324,
        prNumber: 5351,
        description: "Setup2Fix - Implement Simple Signal Handling",
        tags: ["feature", "infrastructure"],
    },
    {
        id: "talawa-2",
        owner: "PalisadoesFoundation",
        repo: "talawa-api",
        size: "small",
        issueNumber: 4323,
        prNumber: 5351,
        description: "Setup2Fix - Simplify Main Orchestrator",
        tags: ["refactor", "infrastructure"],
    },
    {
        id: "talawa-4",
        owner: "PalisadoesFoundation",
        repo: "talawa-api",
        size: "small",
        issueNumber: 5333,
        prNumber: 5334,
        description: "Fix: Remove OAuth account linking from SignInWithOAuth",
        tags: ["bug", "auth"],
    },

    // ── SMALL — colinhacks/zod (Pure TS) ────────────────────────────────────
    {
        id: "zod-1",
        owner: "colinhacks",
        repo: "zod",
        size: "small",
        issueNumber: 4168,
        prNumber: 4206,
        description: "[i18n] Request for internationalization (locales)",
        tags: ["feature"],
    },
    {
        id: "zod-2",
        owner: "colinhacks",
        repo: "zod",
        size: "small",
        issueNumber: 5204,
        prNumber: 5222,
        description: "zod v4 compilation causes JavaScript heap out of memory",
        tags: ["bug"],
    },
    {
        id: "zod-3",
        owner: "colinhacks",
        repo: "zod",
        size: "small",
        issueNumber: 5944,
        prNumber: 5945,
        description: "cidrv6 JSON schema emits an incomplete pattern that rejects valid IPv6 CIDRs",
        tags: ["bug"],
    },
    {
        id: "zod-4",
        owner: "colinhacks",
        repo: "zod",
        size: "small",
        issueNumber: 5275,
        prNumber: 5926,
        description: "Circular imports between `schemas` and `iso`",
        tags: ["bug"],
    },

    // ── MEDIUM — trpc/trpc (Pure TS) ────────────────────────────────────────
    {
        id: "trpc-1",
        owner: "trpc",
        repo: "trpc",
        size: "medium",
        issueNumber: 7369,
        prNumber: 7370,
        description: "bug(tanstack-react-query): mutationOptions doesn't contain keyPrefix",
        tags: ["bug"],
    },
    {
        id: "trpc-2",
        owner: "trpc",
        repo: "trpc",
        size: "medium",
        issueNumber: 7335,
        prNumber: 7336,
        description: "bug(server): handle React 19 proxy coercion in createInnerProxy",
        tags: ["bug"],
    },
    {
        id: "trpc-3",
        owner: "trpc",
        repo: "trpc",
        size: "medium",
        issueNumber: 7264,
        prNumber: 7302,
        description: "Accessibility: 42 links without accessible text on trpc.io (WCAG scan)",
        tags: ["accessibility"],
    },
    {
        id: "trpc-4",
        owner: "trpc",
        repo: "trpc",
        size: "medium",
        issueNumber: 7272,
        prNumber: 7280,
        description: "bug: tRPC error handling with Node VM",
        tags: ["bug"],
    },

    // ── MEDIUM — TryGhost/Ghost (JS/TS, under 500MB) ────────────────────────
    {
        id: "ghost-1",
        owner: "TryGhost",
        repo: "Ghost",
        size: "medium",
        issueNumber: 28310,
        prNumber: 28358,
        description: "Members CSV export should include site name in filename",
        tags: ["feature"],
    },
    {
        id: "ghost-2",
        owner: "TryGhost",
        repo: "Ghost",
        size: "medium",
        issueNumber: 20310,
        prNumber: 20401,
        description: "Newsletter unsubscribe link not working",
        tags: ["bug"],
    },
    {
        id: "ghost-3",
        owner: "TryGhost",
        repo: "Ghost",
        size: "medium",
        issueNumber: 19812,
        prNumber: 19897,
        description: "Portal signup broken after recent auth changes",
        tags: ["bug"],
    },

    // ── LARGE — nestjs/nest (Pure TS, under 500MB) ──────────────────────────
    {
        id: "nest-1",
        owner: "nestjs",
        repo: "nest",
        size: "large",
        issueNumber: 17016,
        prNumber: 17024,
        description: "`ClientRedis` send() never errors when connection drops (routingMap not cleared)",
        tags: ["bug"],
    },
    {
        id: "nest-2",
        owner: "nestjs",
        repo: "nest",
        size: "large",
        issueNumber: 17017,
        prNumber: 17018,
        description: "SSE close listener is registered too late, so disconnects can be missed and list",
        tags: ["bug"],
    },
    {
        id: "nest-3",
        owner: "nestjs",
        repo: "nest",
        size: "large",
        issueNumber: 17007,
        prNumber: 17009,
        description: "Request-scoped providers silently treated as singletons after",
        tags: ["bug"],
    },
    {
        id: "nest-4",
        owner: "nestjs",
        repo: "nest",
        size: "large",
        issueNumber: 16992,
        prNumber: 16997,
        description: "useWebSocketAdapter is unreachable from DI: silent no-op when called after init(",
        tags: ["bug"],
    },

];

export function getDatasetBySize(size: DatasetEntry["size"]): DatasetEntry[] {
    return BENCHMARK_DATASET.filter(e => e.size === size);
}

export function getDatasetByRepo(owner: string, repo: string): DatasetEntry[] {
    return BENCHMARK_DATASET.filter(e => e.owner === owner && e.repo === repo);
}

export function getEntryById(id: string): DatasetEntry | undefined {
    return BENCHMARK_DATASET.find(e => e.id === id);
}
