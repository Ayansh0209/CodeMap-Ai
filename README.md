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

You paste a GitHub repo URL and get an interactive map(graph) of that codebase: real file dependencies, function-level call graphs, and a clear architectural overview. The core parser uses the TypeScript compiler API (ts-morph) to extract import relationships and function call chains without hallucination.
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

- Deterministic graph extraction for JS/TS (including JSX/TSX)
- GitHub tarball download and safe extraction
- Redis-backed caching and queue processing
- Issue mapping with deterministic results plus optional AI augmentation
- Frontend UI for graph exploration and chat

## How it works (short version)

1. Backend downloads the GitHub repo tarball and extracts it locally.
2. The parser builds normalized graphs from the real source tree.
3. Results are cached in Redis and served via API endpoints.
4. The frontend renders file and function graphs with search and filters.
5. AI adds explanation and issue analysis on top of the real data.

## Project structure

- backend: Express API, parser, queue worker, Redis cache
- frontend: Next.js UI for graphs, issue mapping, and chat

## Getting started

### Prerequisites

- Node.js 18+ (recommended)
- Redis (local or hosted)
- GitHub Personal Access Token (for repo download)

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

All config lives in backend/.env.

Required:

- REDIS_URL: Redis connection string
- GITHUB_TOKEN: GitHub token used for tarball downloads
- PORT: API server port (default: 5000)
- MAX_CONCURRENT_JOBS: worker concurrency (default: 3)
- MAX_QUEUE_SIZE: queue backpressure limit (default: 100)
- JOB_TIMEOUT_MS: per-job timeout in ms (default: 600000)
- GEMINI_API_KEY: enables AI issue mapping and chat
- R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_URL: reserved for future object storage support

## Current language support

- JavaScript and TypeScript, including JSX and TSX
- CommonJS and ES modules

## Future feature 

- Python support via tree-sitter adapter
- Go, Rust, and C++ adapters with the same normalized graph schema
- Monorepo workspace-aware import resolution across package boundaries
- Folder-first view for repositories with more than 400 files
- Pull request creation directly from the issue mapper workflow
- GitHub OAuth for private repository support
- VS Code extension for navigating the graph from inside the editor

## Contributing

See CONTRIBUTING.md if you want to help make this project better and more useful
