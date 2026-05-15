"use strict";
// models/graph.ts
// ─────────────────────────────────────────────────────────────────────────────
// Core graph types — the canonical shape of a parsed repository.
//
// Every parser, builder, and storage layer outputs these types.
// NEVER rename or remove fields — the frontend, Redis cache, and all routes
// depend on this exact shape.
// ─────────────────────────────────────────────────────────────────────────────
Object.defineProperty(exports, "__esModule", { value: true });
