"use strict";
// models/index.ts
// ─────────────────────────────────────────────────────────────────────────────
// Barrel re-export — every type from every model file is re-exported here.
//
// WHY THIS EXISTS:
//   All existing code imports from "../models/schema" which now lives here.
//   The original schema.ts has been split into focused files for maintainability,
//   but all existing import paths continue to work via this barrel.
//
// IMPORT ORDER:
//   graph.ts       → core graph types (FileNode, FunctionNode, etc.)
//   builder.ts     → builder I/O contracts (BuilderInput, BuilderOutput)
//   search.ts      → search index types (SearchIndex, SearchIndexEntry)
//   issueMapping.ts → issue mapping results (CandidateFile, IssueMappingResult)
//   retrieval.ts   → AI retrieval index (RetrievalIndex, RetrievalFileEntry)
// ─────────────────────────────────────────────────────────────────────────────
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
__exportStar(require("./graph"), exports);
__exportStar(require("./builder"), exports);
__exportStar(require("./search"), exports);
__exportStar(require("./issueMapping"), exports);
__exportStar(require("./retrieval"), exports);
