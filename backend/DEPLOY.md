# Production Deployment Notes (Render free tier)

## After pulling this branch

```bash
cd backend
npm install        # adds @aws-sdk/client-s3
npm run build
```

## Required actions (do these once)

1. **ROTATE THE REDIS PASSWORD.** The current one leaked in logs. Update
   `REDIS_URL` on Render after rotating.
2. In your Redis provider's settings set the eviction policy to **noeviction**
   (BullMQ requirement — the logs were warning about this on every boot).

## Render environment variables

| Variable | Value | Why |
|---|---|---|
| `RUN_WORKER_IN_SERVER` | `true` | single free-tier instance |
| `MAX_CONCURRENT_JOBS` | `1` | 512MB RAM can parse one repo at a time |
| `PARSE_CHUNK_SIZE` | `20` | flatter RAM peaks than 50 |
| `NODE_OPTIONS` | `--max-old-space-size=384` | GC aggressively instead of being OOM-killed |
| `ANALYZE_RATE_LIMIT` | `10` | per-IP analyses per hour |

Lock tuning (`LOCK_DURATION_MS`, `STALLED_INTERVAL_MS`, `MAX_STALLED_COUNT`)
has safe defaults — no env needed.

## Cloudflare R2 (recommended, free)

Without R2 the system still works: artifacts go to Redis gzipped with a 7-day
TTL. With R2 (10GB free, free egress) artifacts are permanent and Redis stays
small.

1. Cloudflare dashboard → R2 → Create bucket (e.g. `codemap-artifacts`)
2. R2 → Manage API tokens → Create token with Object Read & Write on that bucket
3. Set on Render:
   - `R2_ACCOUNT_ID` (dashboard URL / right sidebar)
   - `R2_ACCESS_KEY_ID`
   - `R2_SECRET_ACCESS_KEY`
   - `R2_BUCKET_NAME`

No code change needed — the artifact store detects the env vars at boot.

## What changed architecturally

- **Sandboxed processor**: in production the job runs in a child process, so
  CPU-heavy parsing can never block BullMQ lock renewal → "job stalled more
  than allowable limit" is structurally fixed. A child OOM kills only the job.
- **Job dedup**: job ID is now `owner--repo`, so the same repo can never run
  twice in parallel.
- **Checkpointing**: each parsed chunk is saved (gzipped, 2h TTL). A retry
  after a crash resumes instead of restarting from zero.
- **Artifact store**: graphs + per-file functions go to R2 (or gzipped Redis
  fallback with TTL). The job result is small; big graphs are served by
  `GET /graph/:owner/:repo` as gzipped JSON with immutable caching.
- **All Redis writes now have TTLs** — Redis can no longer fill up over time.
