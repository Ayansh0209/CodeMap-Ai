"use strict";
// models/search.ts
// ─────────────────────────────────────────────────────────────────────────────
// Search index types — the schema for the pre-built keyword search index
// stored in Redis under search:{owner}:{repo}.
//
// The SearchIndex powers the deterministic keyword-matching step of issue
// mapping (issueMapper.ts / queryEngine.ts). It is separate from the
// RetrievalIndex (retrieval.ts), which is built for AI-driven selection.
// ─────────────────────────────────────────────────────────────────────────────
Object.defineProperty(exports, "__esModule", { value: true });
