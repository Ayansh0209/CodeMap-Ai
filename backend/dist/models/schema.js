"use strict";
// models/schema.ts
// ─────────────────────────────────────────────────────────────────────────────
// COMPATIBILITY SHIM — do not add new types here.
//
// This file has been split into focused modules:
//   models/graph.ts        — FileNode, FunctionNode, ImportEdge, CallEdge, GraphData
//   models/builder.ts      — BuilderInput, BuilderOutput
//   models/search.ts       — SearchIndex, SearchIndexEntry
//   models/issueMapping.ts — CandidateFile, CandidateFunction, IssueMappingResult
//   models/retrieval.ts    — RetrievalIndex, RetrievalFileEntry, RetrievalFunction
//
// All existing imports of the form:
//   import { FileNode } from "../models/schema"
// continue to work unchanged via this re-export.
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
__exportStar(require("./index"), exports);
