# CodeMap AI
CodeMap AI helps developers — especially **beginners in open source** — understand **large repositories faster** without getting lost trying to figure out where to start.

Instead of manually searching through hundreds of files, CodeMap AI helps you:

- visualize **repository structure** and **file relationships**
- understand **function flow** and **import flow**
- **map GitHub issues** to potentially affected files
- explore connected code through a **graph-based view**
- ask **repository-aware AI questions** grounded in the actual codebase

##  Issue Mapping

One of the hardest parts of contributing to open source is figuring out:

- Which files are actually related to this issue?
- Where should I start reading?
- Which functions/files are connected?

The **Issue Mapping** system tries to give contributors a starting point by identifying files and functions likely related to a GitHub issue using the **repository graph** and retrieved code context.

## How it works

The repository graph and relationships are generated using a fully **deterministic parser** — not AI guesses.

AI is only used on top of the parsed graph to:
- explain repository flow
- help reason about issues
- help navigate the codebase

The AI chat system uses a **graph-guided retrieval** approach inspired by **code review graph systems**, which helps reduce token usage while improving **repository-grounded responses**.

> ⚠️ **CodeMap AI is still evolving** and may contain bugs or incorrect mappings in some cases.  
> If you find something broken or have ideas/features that could improve the project, feel free to open an issue or contribute.

 **If you find the project useful, consider starring the repository.**
If you find the project useful, consider starring the repository ⭐

> Note: I may change the name in the future or you can suggest a good name

## What it does

You paste a GitHub repo URL and get an interactive map(graph) of that codebase: real file dependencies, function-level call graphs, and a clear architectural overview. The core parser uses ts-morph for JS/TS and tree-sitter for Python, Go, C, and C++ to extract import relationships and function call chains without hallucination.
### Visual Preview

Here’s a sneak peek at what CodeMap AI gives you:

![File dependency graph example](frontend/public/image.png)
*Visualizing real file dependencies in a large codebase.*
<img width="1919" height="906" alt="image" src="https://github.com/user-attachments/assets/bcdba9dd-a3f7-4afb-9296-b0265c9b617b" />
The files affected or need change for a particlaur issue and by using ai chat you can correct it 

![Function call graph example](frontend/public/image-1.png)
*See which functions call which, with direct links to the code.*

![Issue mapping example](frontend/public/image-2.png)
*Map GitHub issues to the files that matter most for a fix.*




## Key features

- File dependency graph with real import edges
- Function-level call graph with direct GitHub line links
- Issue mapper that maps a GitHub issue to the most relevant files, so you can search an issue and see which files might need changes
- AI chat grounded in actual file content and issue context
- Dead code detection, circular dependency detection, and architectural importance scoring


## What has been done so far

- Deterministic graph extraction for JS/TS (including JSX/TSX) via ts-morph
- Deterministic graph extraction for Python, Go, C, and C++ via web-tree-sitter (WASM)
- GitHub tarball download and safe extraction
- BullMQ-based job queue with Redis for background repo analysis
- S3-compatible object storage (Backblaze B2 / Cloudflare R2 / Supabase / etc.) for large artifact persistence
- Redis caching with gzipped fallback when object storage is not configured
- Issue mapping with deterministic results plus optional Gemini AI augmentation
- AI chat grounded in actual repository code via graph-guided retrieval
- Frontend UI for graph exploration, issue mapping, and chat

## How it works (short version)

1. Backend downloads the GitHub repo tarball and extracts it locally.
2. A BullMQ worker parses the source tree using ts-morph (JS/TS) or web-tree-sitter (Python/Go/C/C++).
3. Parsed graphs and function data are stored in S3-compatible object storage (or gzipped Redis fallback).
4. The frontend renders file and function graphs with search and filters.
5. Gemini AI adds explanation, issue analysis, and chat on top of the real data.

## Tech stack

| Layer | Technology |
|---|---|
| **Backend API** | Express 5, TypeScript |
| **Job Queue** | BullMQ (Redis-backed) |
| **JS/TS Parser** | ts-morph (TypeScript Compiler API) |
| **Multi-lang Parser** | web-tree-sitter (WASM) — Python, Go, C, C++ |
| **Object Storage** | Any S3-compatible provider (Backblaze B2, Cloudflare R2, Supabase, Storj, Wasabi, MinIO) |
| **Cache / Queue Store** | Redis (ioredis) |
| **AI** | Gemini API / Google Vertex AI |
| **Frontend** | Next.js 16, React 19, Tailwind CSS 4 |
| **Graph Rendering** | D3.js, Dagre |
| **Syntax Highlighting** | highlight.js |

## Getting started

### Prerequisites

- Node.js 20+ (recommended)
- Redis (local or hosted — used for BullMQ queue and caching)
- GitHub Personal Access Token (for repo download)
- *(Optional)* S3-compatible object storage credentials (Backblaze B2, Cloudflare R2, etc.) — falls back to gzipped Redis without it
- *(Optional)* Gemini API key for AI chat and issue mapping

### Install

```bash
# backend
cd backend
npm install

# frontend
cd ../frontend
npm install
```

### Configure environment

Create backend/.env with the variables below.

### Run locally

In separate terminals:

```bash
# terminal 1: backend API
cd backend
npm run dev
```

```bash
# terminal 2: background worker
cd backend
npm run worker
```

```bash
# terminal 3: frontend
cd frontend
npm run dev
```

Frontend: http://localhost:3000
Backend: http://localhost:5000

## Configuration

All config lives in `backend/.env` — see `backend/.env.example` for the full template.

### Required

| Variable | Description |
|---|---|
| `REDIS_URL` | Redis connection string |
| `GITHUB_TOKEN` | GitHub token for tarball downloads |
| `PORT` | API server port (default: 5000) |

### Object Storage (recommended for production)

Works with **any S3-compatible provider** — set credentials + bucket + endpoint. Without this, artifacts are stored gzipped in Redis (fine for local dev).

| Variable | Description |
|---|---|
| `R2_ACCESS_KEY_ID` | S3 access key |
| `R2_SECRET_ACCESS_KEY` | S3 secret key |
| `R2_BUCKET_NAME` | Bucket name |
| `R2_ENDPOINT` | S3 endpoint URL (for B2, Supabase, Storj, Wasabi) |
| `R2_REGION` | Region (blank = "auto" for R2; B2/Supabase need a real region) |
| `R2_ACCOUNT_ID` | Cloudflare R2 only (alternative to R2_ENDPOINT) |

### AI (optional)

| Variable | Description |
|---|---|
| `GEMINI_API_KEY` | Enables AI issue mapping and chat |
| `GCP_PROJECT_ID` | Google Cloud project (for Vertex AI) |
| `GCP_LOCATION` | GCP region (default: us-central1) |

### Queue tuning (safe defaults)

| Variable | Default | Description |
|---|---|---|
| `MAX_CONCURRENT_JOBS` | 1 | Worker concurrency |
| `MAX_QUEUE_SIZE` | 100 | Queue backpressure limit |
| `JOB_TIMEOUT_MS` | 600000 | Per-job timeout (ms) |
| `ARTIFACT_TTL_SECONDS` | 604800 | Redis artifact cache TTL (7 days) |
| `RESULT_TTL_SECONDS` | 604800 | Cached result TTL by SHA (7 days) |

## Current language support

### JavaScript / TypeScript (via ts-morph)
- JavaScript (`.js`, `.mjs`, `.cjs`) and TypeScript (`.ts`)
- JSX (`.jsx`) and TSX (`.tsx`)
- CommonJS and ES modules

### Python (via tree-sitter)
- Python (`.py`)
- Relative and absolute import resolution
- Function and class method extraction

### Go (via tree-sitter)
- Go (`.go`)
- Package-based import resolution
- Function and method extraction

### C / C++ (via tree-sitter)
- C (`.c`, `.h`) and C++ (`.cpp`, `.cc`, `.cxx`, `.c++`, `.hpp`, `.hh`, `.hxx`)
- `#include` resolution for both quoted and angle-bracket includes
- Smart `.h` header classification (parsed as C or C++ based on repo majority)
- Function, method, and constructor extraction

## Future features

- Rust adapter with the same normalized graph schema
- Java / Kotlin support
- Monorepo workspace-aware import resolution across package boundaries
- Folder-first view for repositories with more than 400 files
- Pull request creation directly from the issue mapper workflow
- GitHub OAuth for private repository support
- VS Code extension for navigating the graph from inside the editor

## Contributing

See CONTRIBUTING.md if you want to help make this project better and more useful
