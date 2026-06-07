# CodeMap AI — Issue Mapping Evaluation Report

> Generated: 2026-06-07T17:43:29.245Z
> Issues evaluated: **18** / 18 valid / 18 total in dataset

---

## Overall Metrics

| Metric | Score | Bar |
|--------|-------|-----|
| Avg Precision | **0.306** (30.6%) | `██████░░░░░░░░░░░░░░` |
| Avg Recall | **0.059** (5.9%) | `█░░░░░░░░░░░░░░░░░░░` |
| Avg F1 | **0.090** (9.0%) | `██░░░░░░░░░░░░░░░░░░` |
| Recall@5 | **0.059** | `█░░░░░░░░░░░░░░░░░░░` |
| Recall@10 | **0.059** | `█░░░░░░░░░░░░░░░░░░░` |
| Recall@20 | **0.059** | `█░░░░░░░░░░░░░░░░░░░` |
| Non-zero F1 Rate | **33.3%** | `███████░░░░░░░░░░░░░` |
| High Recall Rate (≥50%) | **5.6%** | `█░░░░░░░░░░░░░░░░░░░` |

---

## Performance by Repository Size

| Size | Issues | Precision | Recall | F1 | Recall@5 | Recall@10 |
|------|--------|-----------|--------|----|----------|-----------|
| small | 7 | 0.643 | 0.135 | 0.203 | 0.135 | 0.135 |
| medium | 7 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| large | 4 | 0.250 | 0.028 | 0.050 | 0.028 | 0.028 |

---

## Performance by Repository

| Repository | Issues | Precision | Recall | F1 | Recall@10 |
|------------|--------|-----------|--------|----|-----------|
| `PalisadoesFoundation/talawa-api` | 3 | 1.000 | 0.206 | 0.296 | 0.206 |
| `colinhacks/zod` | 4 | 0.375 | 0.081 | 0.133 | 0.081 |
| `trpc/trpc` | 4 | 0.000 | 0.000 | 0.000 | 0.000 |
| `TryGhost/Ghost` | 3 | 0.000 | 0.000 | 0.000 | 0.000 |
| `nestjs/nest` | 4 | 0.250 | 0.028 | 0.050 | 0.028 |

---

## Miss Pattern Analysis

| Category | Count | % of Misses | Example Files |
|----------|-------|-------------|---------------|
| business_logic | 50 | 63.3% | `envSetup.ts`, `metricsSetup.ts` |
| test | 28 | 35.4% | `envSetup.spec.ts`, `setup.test.ts` |
| config | 1 | 1.3% | `vitest.config.ts` |

---

## Recommendations (Ranked by Impact)

### 1. Retrieval index is missing most relevant files

**Impact:** 🔴 HIGH | **Metric:** recall

Overall recall is below 30%. The Stage 1 token traversal is not surfacing enough candidates. Consider expanding token extraction from issue bodies and lowering MIN_CANDIDATES_FOR_STAGE1 threshold.

> Evidence: *Average recall=0.06 across 18 issues*

### 2. Test files are not surfaced alongside implementation

**Impact:** 🟡 MEDIUM | **Metric:** recall

When a bug fix changes an implementation file, the corresponding test file is often missed. Consider adding neighbouring test-file expansion to Stage 1 graph traversal.

> Evidence: *28 test files missed (35.4%)*

### 3. Top-5 predictions are poorly ranked

**Impact:** 🔴 HIGH | **Metric:** recall@k

Recall@5 is below 20%, meaning the highest-confidence predictions rarely contain the real files. Improving confidence scoring in Stage 3 (e.g. considering architectural importance) would help.

> Evidence: *Average Recall@5=0.06*


---

## Per-Issue Results

### ⚠️ talawa-1 — [Setup2Fix - Implement Simple Signal Handling](https://github.com/PalisadoesFoundation/talawa-api/issues/4324)

**Repo:** `PalisadoesFoundation/talawa-api` | **Size:** small | **Source:** ai

| Metric | Value |
|--------|-------|
| Precision | 1.000 |
| Recall | 0.059 |
| F1 | 0.111 |
| Recall@5 | 0.059 |
| Recall@10 | 0.059 |
| Predicted files | 1 |
| Actual PR files | 17 |
| Matched | 1 |
| Missed | 16 |
| Extra | 0 |
| Snippets fetched | 20 |
| Duration | 27606ms |

**✓ Matched files:**
- `scripts/setup/setup.ts`

**✗ Missed files:**
- `scripts/setup/services/envSetup.ts`
- `scripts/setup/services/metricsSetup.ts`
- `scripts/setup/services/minioSetup.ts`
- `scripts/setup/services/oauthSetup.ts`
- `scripts/setup/services/observabilitySetup.ts`
- `scripts/setup/services/postgresSetup.ts`
- `scripts/setup/services/reCaptchaSetup.ts`
- `scripts/setup/services/restAuthSetup.ts`
- `scripts/setup/services/setupOrchestrator.ts`
- `scripts/setup/services/sharedSetup.ts`
- `scripts/setup/services/validationSetup.ts`
- `setup.ts`
- `test/scripts/setup/envSetup.spec.ts`
- `test/scripts/setup/setup.test.ts`
- `test/scripts/setup/updateEnvVariable.test.ts`
- `test/unit/setup/gracefulCleanup.test.ts`


### ⚠️ talawa-2 — [Setup2Fix - Simplify Main Orchestrator](https://github.com/PalisadoesFoundation/talawa-api/issues/4323)

**Repo:** `PalisadoesFoundation/talawa-api` | **Size:** small | **Source:** ai

| Metric | Value |
|--------|-------|
| Precision | 1.000 |
| Recall | 0.059 |
| F1 | 0.111 |
| Recall@5 | 0.059 |
| Recall@10 | 0.059 |
| Predicted files | 1 |
| Actual PR files | 17 |
| Matched | 1 |
| Missed | 16 |
| Extra | 0 |
| Snippets fetched | 20 |
| Duration | 25519ms |

**✓ Matched files:**
- `scripts/setup/setup.ts`

**✗ Missed files:**
- `scripts/setup/services/envSetup.ts`
- `scripts/setup/services/metricsSetup.ts`
- `scripts/setup/services/minioSetup.ts`
- `scripts/setup/services/oauthSetup.ts`
- `scripts/setup/services/observabilitySetup.ts`
- `scripts/setup/services/postgresSetup.ts`
- `scripts/setup/services/reCaptchaSetup.ts`
- `scripts/setup/services/restAuthSetup.ts`
- `scripts/setup/services/setupOrchestrator.ts`
- `scripts/setup/services/sharedSetup.ts`
- `scripts/setup/services/validationSetup.ts`
- `setup.ts`
- `test/scripts/setup/envSetup.spec.ts`
- `test/scripts/setup/setup.test.ts`
- `test/scripts/setup/updateEnvVariable.test.ts`
- `test/unit/setup/gracefulCleanup.test.ts`


### ✅ talawa-4 — [Fix: Remove Oauth account linking from SignInWithOAuth](https://github.com/PalisadoesFoundation/talawa-api/issues/5333)

**Repo:** `PalisadoesFoundation/talawa-api` | **Size:** small | **Source:** ai

| Metric | Value |
|--------|-------|
| Precision | 1.000 |
| Recall | 0.500 |
| F1 | 0.667 |
| Recall@5 | 0.500 |
| Recall@10 | 0.500 |
| Predicted files | 1 |
| Actual PR files | 2 |
| Matched | 1 |
| Missed | 1 |
| Extra | 0 |
| Snippets fetched | 20 |
| Duration | 29840ms |

**✓ Matched files:**
- `src/graphql/types/Mutation/signInWithOAuth.ts`

**✗ Missed files:**
- `test/graphql/types/Mutation/signInWithOAuth.test.ts`


### ❌ zod-1 — [[i18n] Request for internationalization (locales)](https://github.com/colinhacks/zod/issues/4168)

**Repo:** `colinhacks/zod` | **Size:** small | **Source:** ai

| Metric | Value |
|--------|-------|
| Precision | 0.000 |
| Recall | 0.000 |
| F1 | 0.000 |
| Recall@5 | 0.000 |
| Recall@10 | 0.000 |
| Predicted files | 3 |
| Actual PR files | 2 |
| Matched | 0 |
| Missed | 2 |
| Extra | 3 |
| Snippets fetched | 20 |
| Duration | 60151ms |

**✗ Missed files:**
- `packages/core/src/locales.ts`
- `packages/core/src/locales/ko.ts`

**+ Extra files (predicted but not in PR):**
- `packages/core/locales.ts`
- `packages/docs/content/error-customization.mdx`
- `packages/core/src/locales/en.ts`


### ⚠️ zod-2 — [zod v4 compilation causes JavaScript heap out of memory](https://github.com/colinhacks/zod/issues/5204)

**Repo:** `colinhacks/zod` | **Size:** small | **Source:** ai

| Metric | Value |
|--------|-------|
| Precision | 0.500 |
| Recall | 0.125 |
| F1 | 0.200 |
| Recall@5 | 0.125 |
| Recall@10 | 0.125 |
| Predicted files | 2 |
| Actual PR files | 8 |
| Matched | 1 |
| Missed | 7 |
| Extra | 1 |
| Snippets fetched | 20 |
| Duration | 28205ms |

**✓ Matched files:**
- `packages/zod/src/v4/classic/schemas.ts`

**✗ Missed files:**
- `packages/zod/src/v4/classic/tests/codec.test.ts`
- `packages/zod/src/v4/core/schemas.ts`
- `packages/zod/src/v4/core/versions.ts`
- `packages/zod/src/v4/mini/schemas.ts`
- `packages/zod/src/v4/mini/tests/codec.test.ts`
- `play.ts`
- `scripts/write-stub-package-jsons.ts`

**+ Extra files (predicted but not in PR):**
- `packages/zod/src/v4/core/registries.ts`


### ❌ zod-3 — [cidrv6 JSON schema emits an incomplete pattern that rejects valid IPv6 CIDRs](https://github.com/colinhacks/zod/issues/5944)

**Repo:** `colinhacks/zod` | **Size:** small | **Source:** ai

| Metric | Value |
|--------|-------|
| Precision | 0.000 |
| Recall | 0.000 |
| F1 | 0.000 |
| Recall@5 | 0.000 |
| Recall@10 | 0.000 |
| Predicted files | 1 |
| Actual PR files | 2 |
| Matched | 0 |
| Missed | 2 |
| Extra | 1 |
| Snippets fetched | 20 |
| Duration | 67309ms |

**✗ Missed files:**
- `packages/zod/src/v4/classic/tests/string.test.ts`
- `packages/zod/src/v4/core/regexes.ts`

**+ Extra files (predicted but not in PR):**
- `packages/zod/src/v4/classic/schemas.ts`


### ⚠️ zod-4 — [Circular imports between `schemas` and `iso`](https://github.com/colinhacks/zod/issues/5275)

**Repo:** `colinhacks/zod` | **Size:** small | **Source:** ai

| Metric | Value |
|--------|-------|
| Precision | 1.000 |
| Recall | 0.200 |
| F1 | 0.333 |
| Recall@5 | 0.200 |
| Recall@10 | 0.200 |
| Predicted files | 1 |
| Actual PR files | 5 |
| Matched | 1 |
| Missed | 4 |
| Extra | 0 |
| Snippets fetched | 20 |
| Duration | 25512ms |

**✓ Matched files:**
- `packages/zod/src/v4/classic/schemas.ts`

**✗ Missed files:**
- `packages/treeshake/tests/no-circular-imports.test.ts`
- `packages/treeshake/vitest.config.ts`
- `packages/zod/src/v4/classic/iso.ts`
- `packages/zod/src/v4/classic/tests/no-circular-imports.test.ts`


### ❌ trpc-1 — [bug(tanstack-react-query): mutationOptions doesn't contain keyPrefix](https://github.com/trpc/trpc/issues/7369)

**Repo:** `trpc/trpc` | **Size:** medium | **Source:** ai

| Metric | Value |
|--------|-------|
| Precision | 0.000 |
| Recall | 0.000 |
| F1 | 0.000 |
| Recall@5 | 0.000 |
| Recall@10 | 0.000 |
| Predicted files | 1 |
| Actual PR files | 3 |
| Matched | 0 |
| Missed | 3 |
| Extra | 1 |
| Snippets fetched | 20 |
| Duration | 60393ms |

**✗ Missed files:**
- `packages/tanstack-react-query/src/internals/createOptionsProxy.ts`
- `packages/tanstack-react-query/src/internals/mutationOptions.ts`
- `packages/tanstack-react-query/test/mutationOptions.test.tsx`

**+ Extra files (predicted but not in PR):**
- `packages/tanstack-react-query/src/createTRPCOptionsProxy.ts`


### ❌ trpc-2 — [bug(server): handle React 19 proxy coercion in createInnerProxy](https://github.com/trpc/trpc/issues/7335)

**Repo:** `trpc/trpc` | **Size:** medium | **Source:** ai

| Metric | Value |
|--------|-------|
| Precision | 0.000 |
| Recall | 0.000 |
| F1 | 0.000 |
| Recall@5 | 0.000 |
| Recall@10 | 0.000 |
| Predicted files | 4 |
| Actual PR files | 2 |
| Matched | 0 |
| Missed | 2 |
| Extra | 4 |
| Snippets fetched | 20 |
| Duration | 100131ms |

**✗ Missed files:**
- `packages/server/src/unstable-core-do-not-import/createProxy.test.ts`
- `packages/server/src/unstable-core-do-not-import/createProxy.ts`

**+ Extra files (predicted but not in PR):**
- `packages/server/src/core/internals/utils.ts`
- `examples/.experimental/next-app-dir/src/app/server-action/UseActionExample.tsx`
- `examples/.experimental/next-app-dir/src/app/server-action/ReactHookFormExample.tsx`
- `examples/.experimental/next-app-dir/src/app/server-action/FormWithUseActionExample.tsx`


### ❌ trpc-3 — [Accessibility: 42 links without accessible text on trpc.io (WCAG scan)](https://github.com/trpc/trpc/issues/7264)

**Repo:** `trpc/trpc` | **Size:** medium | **Source:** ai

| Metric | Value |
|--------|-------|
| Precision | 0.000 |
| Recall | 0.000 |
| F1 | 0.000 |
| Recall@5 | 0.000 |
| Recall@10 | 0.000 |
| Predicted files | 0 |
| Actual PR files | 2 |
| Matched | 0 |
| Missed | 2 |
| Extra | 0 |
| Snippets fetched | 20 |
| Duration | 42513ms |

**✗ Missed files:**
- `www/src/components/TwitterWall/index.tsx`
- `www/src/components/sponsors/SponsorBubbles.jsx`


### ❌ trpc-4 — [bug: tRPC error handling with Node VM](https://github.com/trpc/trpc/issues/7272)

**Repo:** `trpc/trpc` | **Size:** medium | **Source:** ai

| Metric | Value |
|--------|-------|
| Precision | 0.000 |
| Recall | 0.000 |
| F1 | 0.000 |
| Recall@5 | 0.000 |
| Recall@10 | 0.000 |
| Predicted files | 3 |
| Actual PR files | 2 |
| Matched | 0 |
| Missed | 2 |
| Extra | 3 |
| Snippets fetched | 20 |
| Duration | 46445ms |

**✗ Missed files:**
- `packages/server/src/unstable-core-do-not-import/error/TRPCError.ts`
- `packages/tests/server/regression/issue-7272-node-vm-error-message.test.ts`

**+ Extra files (predicted but not in PR):**
- `packages/client/src/TRPCClientError.ts`
- `packages/client/src/links/loggerLink.ts`
- `packages/client/src/links/httpBatchStreamLink.ts`


### ❌ ghost-1 — [Members CSV export should include site name in filename (consistent with JSON export)](https://github.com/TryGhost/Ghost/issues/28310)

**Repo:** `TryGhost/Ghost` | **Size:** medium | **Source:** ai

| Metric | Value |
|--------|-------|
| Precision | 0.000 |
| Recall | 0.000 |
| F1 | 0.000 |
| Recall@5 | 0.000 |
| Recall@10 | 0.000 |
| Predicted files | 0 |
| Actual PR files | 4 |
| Matched | 0 |
| Missed | 4 |
| Extra | 0 |
| Snippets fetched | 20 |
| Duration | 74659ms |

**✗ Missed files:**
- `apps/posts/src/views/members/components/members-actions.tsx`
- `apps/posts/src/views/members/members.tsx`
- `apps/posts/test/unit/views/members/members-actions.test.tsx`
- `e2e/tests/admin/members/export.test.ts`


### ❌ ghost-2 — [Added TK support to subtitle](https://github.com/TryGhost/Ghost/pull/20310)

**Repo:** `TryGhost/Ghost` | **Size:** medium | **Source:** ai

| Metric | Value |
|--------|-------|
| Precision | 0.000 |
| Recall | 0.000 |
| F1 | 0.000 |
| Recall@5 | 0.000 |
| Recall@10 | 0.000 |
| Predicted files | 0 |
| Actual PR files | 1 |
| Matched | 0 |
| Missed | 1 |
| Extra | 0 |
| Snippets fetched | 20 |
| Duration | 47726ms |

**✗ Missed files:**
- `ghost/core/core/server/GhostServer.js`


### ❌ ghost-3 — [Released Portal v2.37.5](https://github.com/TryGhost/Ghost/pull/19812)

**Repo:** `TryGhost/Ghost` | **Size:** medium | **Source:** ai

| Metric | Value |
|--------|-------|
| Precision | 0.000 |
| Recall | 0.000 |
| F1 | 0.000 |
| Recall@5 | 0.000 |
| Recall@10 | 0.000 |
| Predicted files | 1 |
| Actual PR files | 2 |
| Matched | 0 |
| Missed | 2 |
| Extra | 1 |
| Snippets fetched | 20 |
| Duration | 45534ms |

**✗ Missed files:**
- `ghost/admin/app/components/dashboard/onboarding-checklist.js`
- `ghost/admin/app/components/modal-share.js`

**+ Extra files (predicted but not in PR):**
- `apps/activitypub/src/hooks/use-activity-pub-queries.ts`


### ❌ nest-1 — [`ClientRedis` send() never errors when connection drops (routingMap not cleared)](https://github.com/nestjs/nest/issues/17016)

**Repo:** `nestjs/nest` | **Size:** large | **Source:** ai

| Metric | Value |
|--------|-------|
| Precision | 0.000 |
| Recall | 0.000 |
| F1 | 0.000 |
| Recall@5 | 0.000 |
| Recall@10 | 0.000 |
| Predicted files | 1 |
| Actual PR files | 2 |
| Matched | 0 |
| Missed | 2 |
| Extra | 1 |
| Snippets fetched | 20 |
| Duration | 21361ms |

**✗ Missed files:**
- `packages/microservices/client/client-redis.ts`
- `packages/microservices/test/client/client-redis.spec.ts`

**+ Extra files (predicted but not in PR):**
- `packages/microservices/client/client-proxy.ts`


### ⚠️ nest-2 — [SSE close listener is registered too late, so disconnects can be missed and listeners can leak](https://github.com/nestjs/nest/issues/17017)

**Repo:** `nestjs/nest` | **Size:** large | **Source:** ai

| Metric | Value |
|--------|-------|
| Precision | 1.000 |
| Recall | 0.111 |
| F1 | 0.200 |
| Recall@5 | 0.111 |
| Recall@10 | 0.111 |
| Predicted files | 1 |
| Actual PR files | 9 |
| Matched | 1 |
| Missed | 8 |
| Extra | 0 |
| Snippets fetched | 25 |
| Duration | 28304ms |

**✓ Matched files:**
- `packages/core/router/router-response-controller.ts`

**✗ Missed files:**
- `integration/nest-application/sse/e2e/express.spec.ts`
- `integration/nest-application/sse/e2e/fastify.spec.ts`
- `integration/nest-application/sse/e2e/utils.ts`
- `integration/nest-application/sse/src/app.controller.ts`
- `packages/core/helpers/handler-metadata-storage.ts`
- `packages/core/router/router-execution-context.ts`
- `packages/core/test/router/router-execution-context.spec.ts`
- `packages/core/test/router/router-response-controller.spec.ts`


### ❌ nest-3 — [Request-scoped providers silently treated as singletons after](https://github.com/nestjs/nest/issues/17007)

**Repo:** `nestjs/nest` | **Size:** large | **Source:** ai

| Metric | Value |
|--------|-------|
| Precision | 0.000 |
| Recall | 0.000 |
| F1 | 0.000 |
| Recall@5 | 0.000 |
| Recall@10 | 0.000 |
| Predicted files | 1 |
| Actual PR files | 3 |
| Matched | 0 |
| Missed | 3 |
| Extra | 1 |
| Snippets fetched | 20 |
| Duration | 32578ms |

**✗ Missed files:**
- `integration/injector/e2e/injector.spec.ts`
- `packages/core/injector/instance-wrapper.ts`
- `packages/core/test/injector/instance-wrapper.spec.ts`

**+ Extra files (predicted but not in PR):**
- `packages/core/injector/container.ts`


### ❌ nest-4 — [useWebSocketAdapter is unreachable from DI: silent no-op when called after init(), no path to provide it as a provider](https://github.com/nestjs/nest/issues/16992)

**Repo:** `nestjs/nest` | **Size:** large | **Source:** ai

| Metric | Value |
|--------|-------|
| Precision | 0.000 |
| Recall | 0.000 |
| F1 | 0.000 |
| Recall@5 | 0.000 |
| Recall@10 | 0.000 |
| Predicted files | 3 |
| Actual PR files | 2 |
| Matched | 0 |
| Missed | 2 |
| Extra | 3 |
| Snippets fetched | 20 |
| Duration | 25498ms |

**✗ Missed files:**
- `packages/core/nest-application.ts`
- `packages/core/test/nest-application.spec.ts`

**+ Extra files (predicted but not in PR):**
- `packages/core/metadata-scanner.ts`
- `packages/core/discovery/discovery-service.ts`
- `integration/discovery/src/webhooks.explorer.ts`

