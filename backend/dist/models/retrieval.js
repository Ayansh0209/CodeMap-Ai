"use strict";
// models/retrieval.ts
// ─────────────────────────────────────────────────────────────────────────────
// Retrieval index types — a separate, AI-oriented data store built at parse
// time and stored in Redis under retrieval:{owner}:{repo}.
//
// PURPOSE:
//   The RetrievalIndex is NOT for visualization. It is specifically designed
//   to power AI-driven issue mapping and chat. It provides retrieval-oriented
//   signals that tell the AI which files and functions are worth fetching
//   from GitHub's raw content API.
//
// CONTRAST WITH SearchIndex:
//   - SearchIndex: keyword tokens for deterministic BM25-style matching
//   - RetrievalIndex: semantic signals (auth checks, DB calls, barrel status,
//     semantic role) for AI-driven context selection
//
// STORAGE:
//   Key: retrieval:{owner}:{repo}
//   No TTL — the commitSha inside the index handles staleness.
//   If a new analysis runs for the same repo with a different SHA, it overwrites.
// ─────────────────────────────────────────────────────────────────────────────
Object.defineProperty(exports, "__esModule", { value: true });
