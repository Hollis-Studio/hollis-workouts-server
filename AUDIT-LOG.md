# hollis-workouts-server — Overnight Blind-Audit Orchestration Log

**Orchestrator:** Claude (acting senior SWE manager)
**Started:** 2026-05-25 ~19:30 local
**Mandate:** Re-audit the workouts server with rounds of blind audit agents (3–4 at a
time), comparing against the reference prod server at `hollis-health-app/server/`.
Double-verify every finding before patching. Defer scaling/infra-only items inline as
`//DEFERRED(audit): <rationale>`. Loop until a fresh blind wave returns no findings of
interest. Log every executive decision here.

**Repos**
- Target (under audit): `/Users/isaaclandes/Documents/SRC/Hollis/hollis-workouts-server`
- Reference (prod gold standard): `/Users/isaaclandes/Documents/SRC/Hollis/hollis-health-app/server`

**Ground rules I am operating under**
- No git operations (working tree is user-owned). No worktrees — all agents on the local main tree.
- Audit agents are READ-ONLY; only the orchestrator edits code, after independent verification.
- After every patch batch: `npm run typecheck` + `npm test` must stay green.
- userId always from `req.userId` (JWT), never from request body (IDOR invariant).

---

## Baseline (pre-audit)
- `npm run typecheck` → clean (no errors).
- `npm test` → **323 passed / 14 files**.
- This is the known-good state to protect across all patches.

---

## Severity rubric
- **BLOCKER** — security hole, data corruption/loss, correctness bug reachable in prod. Fix now.
- **MAJOR** — wrong behavior or real operational risk under normal conditions. Fix now.
- **MINOR** — robustness/consistency/observability gap. Fix if cheap + safe.
- **DEFERRED** — scaling/infra/future-work that does not block the Firebase→PG flip. Mark inline.

---

## Decision ledger
(Each entry: finding → independent verification → decision → result.)

### Round 1 — launched 2026-05-25 ~19:32
Wave 1 agents (blind, disjoint domains):
- A: Security & auth
- B: Operational readiness & lifecycle
- C: Data correctness & Prisma
- D: HTTP/API hardening & middleware

**Wave 1 returned ~45 findings across the 4 agents (heavy overlap). Deduplicated +
independently verified by re-reading every cited file. Triage below.**

#### FIX NOW (verified real)

| # | Finding | Sev | Decision |
|---|---------|-----|----------|
| R1-1 | No graceful shutdown (SIGTERM/SIGINT); `app.listen` handle discarded; `beforeExit` is a dead hook on Fargate | BLOCKER | Add lifecycle in index.ts: capture server, SIGTERM/SIGINT → drain + `prisma.$disconnect()` + 15s force-exit. |
| R1-2 | No `unhandledRejection` / `uncaughtException` handlers | BLOCKER | Add both; log FATAL + graceful shutdown + exit(1). |
| R1-3 | No `server.on('error')` (bind failure invisible) | MAJOR | Add; log fatal + exit(1). |
| R1-4 | App assembled inline in index.ts; test `buildApp()` duplicates it → drift | MAJOR | Extract `createApp()` into `src/app.ts`; index.ts + test setup both consume it. Backbone of this round. |
| R1-5 | No security headers (helmet absent) | MAJOR(D)/MINOR(A) | Add a dependency-free `securityHeaders` middleware (nosniff, X-Frame-Options DENY, HSTS, Referrer-Policy, DNS-prefetch off). Chose a tiny middleware over the `helmet` dep: minimal JSON API + avoids an install touching the @hollis-studio scope. |
| R1-6 | No 404 catch-all → Express default HTML 404 | MAJOR | Add JSON `{ok:false,err:NOT_FOUND}` catch-all before errorHandler. |
| R1-7 | `req.requestId` referenced in errorHandler but never set | MAJOR | Add request-context middleware: set requestId (x-amzn-trace-id ▸ x-request-id ▸ randomUUID), echo `X-Request-Id`, emit access log on finish (also covers "no request logger" B5/D6). |
| R1-8 | Rate limiter mounted AFTER body parser | MINOR | Reorder: health → rate limiter → json parser → routes. Health bypasses both rate-limit and auth. |
| R1-9 | `express.urlencoded` on a JSON-only API (extra surface) | MINOR | Remove. |
| R1-10 | Env validation lazy, not explicit fail-fast | MAJOR | Add explicit `validateEnv()` at top of index.ts body (runs before `listen`; ESM import-order nuance noted — pool is built at import with raw env but never connects until a query, and validateEnv throws before listen). |
| R1-11 | CRUD factory cursor on `id` but `orderBy: createdAt` → unstable pagination (skip/dup on tied timestamps) | MAJOR | `orderBy: [{createdAt:desc},{id:desc}]`. Same in exercises.ts (`[{name:asc},{id:asc}]`) and sessions.ts (add `{id:desc}` tiebreaker). |
| R1-12 | sessions `completedAt: desc` → Postgres NULLS FIRST: active sessions float to top, contradicting documented "nulls last" | MAJOR | `{completedAt:{sort:"desc",nulls:"last"}}`. |
| R1-13 | progression/cardio baseline list discards `cursor`, returns no `nextCursor`, silently truncates at limit (breaks sync for >50 tracked exercises) | MAJOR | Real cursor pagination: `orderBy:[{lastUpdated:desc},{canonicalExerciseId:desc}]`, cursor on `userId_canonicalExerciseId`, return `nextCursor`=last canonicalExerciseId. |
| R1-14 | baseline PUT always 201 even on update | MINOR (3 agents flagged) | `findUnique` (existence) + keep atomic `upsert`, choose 200/201 from the pre-check. Preserves atomicity AND existing upsert-mock tests. |
| R1-15 | metric-basket composite id (≤272 chars) rejected by `idSchema.max(128)` | MAJOR | Bump `idSchema` max to 512 (real ids are short; only the composite snapshot id is long). |
| R1-16 | sessions UPDATE/DELETE where omits `userId` (weaker than factory) | MINOR | Add `userId` to both where clauses (defense-in-depth; `toMatchObject` tests unaffected). |
| R1-17 | `IDENTITY_JWT_SECRET` min length 8 (64-bit) | MAJOR | `z.string().min(32)` (256-bit HS256 floor). |
| R1-18 | exercises.ts JSDoc says `Cache-Control: public` but code is `private` | MINOR | Fix the comment (code is correct). |
| R1-19 | Dockerfile clones `hollis-shared` + `@hollis/*` file: refs + no token secret + no USER + no HEALTHCHECK — inconsistent with package.json (now `@hollis-studio/*` from GitHub Packages via NODE_AUTH_TOKEN) → container build would 401 | MAJOR | Rewrite mirroring reference: `--mount=type=secret,id=npmrc` for `npm ci`, drop dead hollis-shared stages, non-root user, HEALTHCHECK `/healthz`. NOT build-tested locally (no docker); aligned to reference + verified against package.json/.npmrc. |
| R1-20 | pg Pool no `connectionTimeoutMillis` (pool exhaustion hangs instead of erroring) | MINOR | Add `connectionTimeoutMillis` + conservative `max` + `idleTimeoutMillis` (max value marked //DEFERRED — needs load tuning). |

#### DEFERRED (marked inline `//DEFERRED(audit)` with rationale)

| # | Finding | Sev | Why deferred |
|---|---------|-----|--------------|
| R1-D1 | Prisma TLS `rejectUnauthorized:false` default when no CA | MAJOR | Deploy-gated; already has env override + startup warning + TODO(deploy). Flipping default to true now would break the not-yet-provisioned RDS connection (RDS CA not in default trust store). Keep + sharpen inline marker. |
| R1-D2 | baseline Int columns (reps/RIR/HR) accept floats via bare `z.number()` → Postgres 500 | MAJOR-ish | Canonical fix belongs in `@hollis-studio/contracts` (add `.int()`); app only ever sends integers; worst case is a 500, not corruption. Inline marker pointing at the contract. |
| R1-D3 | injuries `?muscleGroup` filter not enum-validated | MINOR | Input-quality only; Prisma is injection-safe; bad value yields empty result. Avoids coupling route to the MuscleGroup enum. |
| R1-D4 | sessions `?since` + `?cursor` combo can throw P2025 → 500 | MINOR | Requires a stale cursor reused with a narrowing filter; low likelihood. Documented; revisit if observed. |
| R1-D5 | ECS task def is a placeholder; pool `max` sizing; Dockerfile base SHA-pin | DEFERRED | Pure deploy/scaling/infra; tracked for the flip, not code-blocking. |
| R1-D6 | `LOG_DB_QUERIES` has no prod guard | MINOR | Defaults off; logs only SQL templates (never params). Low value. |

#### ACCEPTED — no action (logged so re-audits don't re-flag)

- DELETE returns `200 {deleted:true}` not `204`: conventional + tests rely on the body. Acceptable.
- Health routes use `{ok:true,...}` not the `{ok,data}` envelope: deliberate liveness/ALB contract.
- Retry-After fixed at 60s vs `resetTime`: cosmetic UX; clients still back off.
- Global 2mb body limit vs per-route limits: acceptable for this workload (note kept).

#### Execution plan (typecheck+test green after EACH batch)
1. Backbone: `src/app.ts` createApp + middleware (R1-4,5,6,7,8,9) + index.ts lifecycle (R1-1,2,3,10) + setup.ts uses createApp.
2. Data/routes: R1-11..18 (crud, exercises, sessions, baselines, common.ts, env.ts).
3. Artifact: R1-19 Dockerfile, R1-20 + R1-D1 prisma.ts.
4. Tests: update baseline tests (pagination + 200-update), add 404/requestId/headers tests.

---

#### Execution results — Round 1 COMPLETE ✅

Baseline 323 → **333 tests pass** (+10 new), typecheck clean after every batch.

- **Batch 1 (backbone)** — created `src/app.ts` (`createApp()`), rewrote `src/index.ts`
  (validateEnv fail-fast + SIGTERM/SIGINT graceful shutdown + prisma.$disconnect +
  unhandledRejection/uncaughtException + server.on('error')), new `src/middleware/
  requestContext.ts` (requestId + access log) and `securityHeaders.ts`, reordered stack
  (health → rate-limit → json), removed urlencoded, added 404 catch-all, pointed test
  `buildApp()` at `createApp()`. Closed R1-1..10.
  - **Bonus find during remediation (R1-21):** `auth.ts` had `import "../types/express.js"`
    — a `.d.ts` emits no JS, so this would **MODULE_NOT_FOUND at runtime in production**
    (masked in tests because auth is mocked). Removed it from auth.ts (and avoided it in the
    new middleware); the ambient augmentation applies via tsconfig include. Latent prod-crash
    fixed.
- **Batch 2 (data/routes)** — pagination tiebreakers (crud.ts, exercises.ts, sessions.ts);
  `completedAt` NULLS LAST; sessions UPDATE/DELETE where + userId; baseline real cursor
  pagination + correct 200/201 (findUnique + atomic upsert); `idSchema` max→512; JWT secret
  min→32; exercises cache doc fix. Closed R1-11..18.
- **Batch 3 (artifact/infra)** — Dockerfile rewrite (GitHub Packages secret mount, drop dead
  hollis-shared stages, non-root `workouts` user, Node-fetch HEALTHCHECK on /healthz); pg Pool
  `connectionTimeoutMillis`/`idleTimeoutMillis`/`max`; sharpened TLS deferral marker. Closed
  R1-19, R1-20; inline //DEFERRED markers placed for R1-D1, R1-D5.
- **Batch 4 (tests)** — new `appBehavior.test.ts` (404 JSON, security headers, X-Request-Id
  echo/honor, health bypass, x-powered-by suppressed) + baseline 200-update/nextCursor/cursor
  tests. +10 tests.

Inline //DEFERRED(audit) markers placed: R1-D1 (TLS, prisma.ts), R1-D2 (Int/float, both
baseline routes), R1-D5 (pool max, prisma.ts). R1-D3/D4/D6 logged here only (no code touch
needed). Dockerfile NOT build-tested locally (no docker daemon) — aligned to reference +
verified against package.json/.npmrc.

### Round 2 — launched 2026-05-25 (fresh blind wave; re-audits current state incl. new files)

Wave 2a agents: (A) adversarial review of the NEW lifecycle/middleware code; (B) exhaustive
contracts-vs-persistence parity across all 14 resources. Verified every finding against the
actual `@hollis-studio/contracts` dist source.

#### FIX NOW (verified real — NEW issues Round 1 missed)

| # | Finding | Sev | Decision/Result |
|---|---------|-----|-----------------|
| R2-1 | `programs.ts` hand-rolled an inline body schema that **diverged from the canonical `ProgramSchema`**: deloadPercent max 100 vs **0..1**; dayOfWeek min 0 vs **-1** rest-day sentinel; goalMode **required** vs optional+`useSmartProgress` transform; `schedule`/`exercises` missing **`.min(1)`**; ProgramSet/CardioTargets targetDuration min 0 vs **1**; RIR no max vs **max 10**; repThreshold no min vs **min 1**. | **BLOCKER** | Replaced inline schema with `ProgramSchema.omit({id,userId,createdAt,updatedAt}).extend({createdAt:optional})` — fixes all divergences at once + prevents future drift (mirrors sessions/baselines). Fixed test fixture (`deloadPercent: 40`→`0.4`, which itself encoded the bug). Added 3 regression tests (deloadPercent>1 → 400, dayOfWeek -1 → accepted, empty-exercises day → 400). |
| R2-2 | `X-Request-Id` echoed verbatim from client header → log/response-header injection + bloat | MINOR | `requestContext.ts`: sanitize client value against `/^[\x20-\x7E]{1,128}$/`, else randomUUID. ALB's X-Amzn-Trace-Id still trusted. |
| R2-3 | `gracefulShutdown` hard-coded `process.exit(0)` on success → a crash (uncaughtException) that drained cleanly would exit **0**, masking the failure; `.finally(exit(1))` never ran (exit halts first) | MINOR→real | index.ts: thread an explicit `exitCode` (0 for SIGTERM/SIGINT, 1 for uncaught/unhandled); removed the `.finally(exit(1))` race; clearTimeout on both paths. |
| R2-4 | Dead `beforeExit` $disconnect hook in prisma.ts (never fires while listening; shutdown owns disconnect) | MINOR | Removed; replaced with an explanatory note. |
| R2-5 | CRUD factory silently assumes delegate has `id`+`createdAt` (footgun for future resources) | MINOR | Added an explicit REQUIREMENT note to the factory doc. |

#### CORRECTED A PRIOR DECISION (double-verify caught my own error)

- **R1-D2 was a FALSE POSITIVE.** The R1 data agent claimed baseline reps/RIR/HR are bare
  `z.number()`; I propagated that into //DEFERRED markers. Reading the actual contract dist
  (`progression/baseline.js`) shows **every** Int-mapped field uses `.int()` (topSetReps,
  topSetRIR, trend*, missStreak, phaseExitDate, lowestHRAtPace, lastAvgHeartRate). Floats are
  already rejected with 400, not 500. **Removed both incorrect markers** from the baseline
  routes. (This is exactly why the mandate to double-verify before patching matters.)

#### Verified OK / accepted (logged so re-audits don't re-flag)
- Lifecycle agent's "Checked OK": middleware order, headers on all paths incl. errors, 404
  reachability, access-log finish hook, double-shutdown guard, trust proxy, test fidelity.
- Parity agent confirmed round-trip-correct: gyms, sessions, baselines, gymExerciseInstances,
  userExercises, exerciseAliases, weeks, aiAuditLog, injuries, conversationRollingSummary,
  metricBasketSnapshots, exercises (catalog). Only `programs` had defects (R2-1).
- R2 also re-raised R1-D1 (TLS) — still DEFERRED (deploy-gated, same rationale).
- Week forward-spec fields (hasConversation, etc.) stripped by client parse — no impact (deferred).
- readyz vs ALB timeout — DEFERRED (depends on ALB config, not yet provisioned).

**Result:** typecheck clean; 333 → **336 tests pass** (+3 program regression tests). All batches green.

### Round 2b — second blind wave (security + HTTP/REST + full-surface) on the post-fix state

Both agents converged: the auth/IDOR architecture is solid — **no new security holes**. Strongest
recurring NEW finding (both agents): Prisma known errors fall through to opaque 500.

#### FIX NOW (verified real)

| # | Finding | Sev | Decision/Result |
|---|---------|-----|-----------------|
| R2b-1 | Prisma `P2002` (unique-constraint race on concurrent create) and `P2025` (stale cursor / row deleted mid-op) fall through to a generic **500** | BLOCKER(HTTP)/MINOR(sec) | `errorHandler.ts`: added a `Prisma.PrismaClientKnownRequestError` branch → P2002=**409 CONFLICT**, P2025=**404**, else 500. Updated test mock to expose a real `PrismaClientKnownRequestError` class (`instanceof` against `{}` would have thrown). +2 tests. Covers both agents' stale-cursor 500 finding too. |
| R2b-2 | CRUD factory list merged `{ userId, ...extraFilters }` — a future `listFilters` returning `userId` would override ownership scope | MINOR (latent IDOR) | Flipped to `{ ...extraFilters, userId }` so userId always wins — structural guard, not docs. |
| R2b-3 | `auth.ts` echoed the JWT failure reason to the client ("jwt expired"/"invalid signature"/"invalid audience"/"Identity Service unreachable: <net error>") | MINOR | Return generic "Invalid or expired token"; log specifics server-side. Stops forgery-probing + network-topology leak. (auth is mocked in tests → no test impact.) |
| R2b-4 | `X-Amzn-Trace-Id` accepted unvalidated (ALB preserves a client-supplied value) and echoed/logged | MINOR | Apply the same `SAFE_REQUEST_ID` sanitizer to it as to X-Request-Id. |
| R2b-5 | `aiAuditLog` GET had no cursor pagination → silent truncation at limit | MINOR | Added cursor (id) + `orderBy:[{timestamp:desc},{id:desc}]` + `nextCursor`. |
| R2b-6 | `Retry-After` always = full window (60s) regardless of position in window | MINOR | Compute from `req.rateLimit.resetTime` (typed cast — v8 doesn't globally augment Request), fallback to windowMs. |
| R2b-7 | weeks PUT always-200 vs baselines' 201 was an undocumented inconsistency | MINOR | Documented the deliberate idempotent-200 choice (test + header already assert 200; no behavior change). |

#### DEFERRED / ACCEPTED (logged)
- **XFF spoofing bypasses the IP rate limiter** (`trust proxy: 1`): DEFERRED — the real protection is
  the per-userId `writeRateLimiter` (unaffected); a tighter fix needs the ALB's VPC CIDR (deploy-specific).
- **In-memory rate-limit store won't survive multi-task scale-out**: DEFERRED — documented single-instance;
  swap to Redis when horizontal scaling is enabled.
- baseline concurrent-create dup-201 (TOCTOU): accepted — no corruption, vanishingly rare.
- sessions `?since` filters `updatedAt` (incremental-sync semantics): accepted — correct for sync.

**Result:** typecheck clean; 336 → **338 tests pass**. (One typecheck iteration: `req.rateLimit` needed a
typed cast since express-rate-limit v8 dropped global Request augmentation.)

### Round 3 — third blind wave (convergence check) on the post-Round-2b state

Wave: (A) deep security + correctness re-verify; (B) the previously-unaudited surfaces
(seed script, Prisma config, Dockerfile, ECS task def, package scripts, .env.example, README).

**Agent A (security/correctness): CLEAN.** Verbatim: "no new BLOCKER or MAJOR security findings.
No IDOR paths were found. No injection surfaces exist. Auth coverage is complete and non-leaking."
Its only 4 notes were all already-known deferrals (sessions `?since` accepted; injuries muscleGroup
R1-D3; LOG_DB_QUERIES R1-D6; TLS R1-D1). **→ Security/correctness surface has converged.**

**Agent B (overlooked surfaces): found real infra/seed/build hygiene items earlier rounds never
inspected.** Triage:

#### FIX NOW (cheap, safe — code/config/schema/docs; no live DB needed)

| # | Finding | Sev | Result |
|---|---------|-----|--------|
| R3-1 | `tsconfig` used `moduleResolution: "bundler"` with plain `tsc` — extensionless imports would compile but crash at runtime under Node ESM (a time-bomb; this is exactly the class of the R1-21 `.d.ts` crash) | MAJOR | Switched to `module/moduleResolution: "NodeNext"` (enforces `.js` extensions). Typecheck + 338 tests still green. |
| R3-2 | `seed-exercises.ts` outer `.catch()` `process.exit(1)` without `$disconnect()` → can hang a seed pipeline on the pg idle timeout | MAJOR | Moved `prisma` to module scope; catch now `await prisma.$disconnect()` before exit. |
| R3-3 | `seed-exercises.ts` unused `createRequire` import | MINOR | Removed. |
| R3-4 | No prod migration deploy path / no `engines` | MAJOR/MINOR | Added `prisma:migrate:deploy` + `prisma:seed` scripts and `engines.node >=20`. (Generating the actual initial migration needs a live DB → DEFERRED to the flip.) |
| R3-5 | Schema missing indexes for real query patterns: Session `?since`(updatedAt), MetricBasketSnapshot `?since`(capturedAt), baselines orderBy lastUpdated | MINOR | Added `@@index([userId, updatedAt])` (Session), `([userId, capturedAt])` (snapshots), `([userId, lastUpdated])` (both baselines). Take effect when migrations are generated. |
| R3-6 | ECS task def: no `executionRoleArn` (secrets injection fails → crash) + all 3 secrets shared one `PLACEHOLDER_SSM_ARN` (find-replace footgun) | MAJOR (deploy) | Stub hardened: added `executionRoleArn` placeholder + distinct per-secret placeholder ARNs + an explicit comment on the IAM requirement. (Real ARNs are deploy-time → DEFERRED.) |
| R3-7 | `.env.example` missing `DATABASE_SSL_CA` / `DATABASE_SSL_REJECT_UNAUTHORIZED` / `LOG_DB_QUERIES` (read in prisma.ts) | MINOR | Added documented commented entries. |
| R3-8 | README stale: "CRUD handlers stubbed", W5c/W5d TODO | MINOR | Updated status to reflect implemented routes + new scripts + the open migration item. |

#### DEFERRED (flip-over / needs live DB / data assets / upstream)
- **Generate the initial Prisma migration + wire a migrate step into deploy** (R3 BLOCKER #2 core): needs a
  real Postgres (shadow DB); this IS the flip. `prisma:migrate:deploy` script now in place.
- **Real ECS `executionRoleArn` + distinct SSM ARNs** (R3 BLOCKER #1 core): deploy-time secrets/IAM.
- **`exercises.json` has mock Firebase Storage `illustrationUrl` for 895/1007 entries**: client-repo data
  asset; needs real CDN URLs before seeding to prod. Not server code.
- **`prisma.config.ts earlyAccess: true`**: Prisma 7 upstream API; track changelog.
- **Test files not type-checked by `tsc`** (`include` is `src/**` only): a separate test tsconfig is a
  tooling nicety; tests are run (not type-checked) via vitest/esbuild. DEFERRED.
- TLS (R1-D1), in-memory rate limiter, XFF trust-proxy CIDR — unchanged, still deferred.

**Result:** typecheck clean; **338 tests pass** (no new tests needed — these are infra/config/docs). NodeNext
migration verified safe (all imports already use `.js`).

### Round 4 — convergence confirmation on the post-Round-3 state

**Agent A (security/correctness): FULLY CLEAN.** Verbatim: "No new BLOCKER, MAJOR, MINOR, or
DEFERRED-candidate findings… The codebase has converged. No actionable findings remain." Confirmed the
programs `ProgramSchema.omit().extend()` is correct/complete, all IDOR scoping, error mapping, pagination,
lifecycle. One non-finding note (aiAuditLog `?since` offset) → fixed below.

**Agent B (build/correctness): only MINOR polish + already-known deferrals.** Fixed the cheap ones:

| # | Finding | Result |
|---|---------|--------|
| R4-1 | `ERROR_CODES` enum missing `PAYLOAD_TOO_LARGE` / `INVALID_JSON` (emitted by errorHandler) | Added both to the enum. |
| R4-2 | Two different 429 codes (`RATE_LIMIT_EXCEEDED` vs `RATE_LIMITED`); former not in enum | Normalized the global limiter to `RATE_LIMITED` (the enum value). |
| R4-3 | `@types/pg` + `pino-pretty` in `dependencies` (type-only / dev-only) ship into the prod image | Moved both to `devDependencies` (prod only loads pino-pretty when NODE_ENV≠production, which never happens in the pruned image). |
| R4-4 | MetricBasketSnapshot (+ other growing factory tables) list orderBy `createdAt` with no `[userId, createdAt]` index | Added `@@index([userId, createdAt])` to metricBasketSnapshots, userExercises, exerciseAliases, gymExerciseInstances (the per-user-growing factory models; gyms/programs/injuries left — bounded small). |
| R4-5 | aiAuditLog `?since` used `z.string().datetime()` (UTC-only) vs sessions' `{offset:true}` | Aligned to `{offset:true}`. |

#### DEFERRED (confirmed, unchanged)
- **Seed cross-repo data path** (reads sibling `hollis-workouts/.../exercises.json`): works for the local
  one-time seed; copying the JSON into the server repo is a data-management call for the flip. DEFERRED.
- **Prisma generator `prisma-client-js` (CJS) vs `prisma-client` (ESM-native)**: verified to interop
  correctly at runtime under Node 20; switching needs a client regen + re-verify. Tech debt, not a bug. DEFERRED.

**Result:** typecheck clean; **338 tests pass**.

### Round 5 — final clean-sweep confirmation

**RESULT: CLEAN.** A fresh blind staff-level adversarial sweep returned **no new BLOCKER/MAJOR/MINOR
findings** — verbatim: "No new material defects found. The codebase has converged." It independently
re-confirmed: auth coverage + non-leak, IDOR scoping across all 14 resources, mass-assignment/injection
safety, error-handler completeness (incl. Prisma P2002→409 / P2025→404), pagination stability, lifecycle,
schema/route correctness, and the programs contract-derived schema. It correctly did not re-report the
known accepted deferrals.

**→ Stopping condition met:** a blind audit wave returned no findings of interest.

---

## FINAL SUMMARY — overnight orchestration complete

**Rounds:** 5 waves, ~13 blind audit agents (3–4 staged at a time). Each round's findings were
independently verified by re-reading the cited code before any patch; every patch batch kept
typecheck + tests green.

**Final state:** `npm run build` (tsc/NodeNext) compiles to `dist/`; `npm run typecheck` clean;
**338 tests pass** (started at 323; +15 covering the new behavior).

**Headline fixes (by severity):**
- BLOCKER: graceful shutdown + process-level error handlers (ECS lifecycle); `programs` body schema
  diverged from the canonical contract (deloadPercent/dayOfWeek/goalMode/min(1)/target bounds) — now
  derives from `@hollis-studio/contracts`; Prisma P2002/P2025 fell through to opaque 500 — now 409/404.
- MAJOR: `createApp()` factory ends test-vs-prod drift; security headers; 404 JSON catch-all; requestId +
  access log; fail-fast env validation; cursor-pagination instability (tiebreakers) on every list endpoint;
  baseline list silent truncation (real cursor pagination added); `idSchema` 128→512 for composite ids;
  JWT secret floor 8→32; Dockerfile rebuilt for GitHub Packages + non-root + healthcheck; tsconfig
  bundler→NodeNext (prod-crash class); latent `.d.ts` runtime-crash import removed from auth.ts.
- MINOR: listFilters userId-override guard; auth message-leak; X-Request-Id/X-Amzn-Trace-Id sanitization;
  aiAuditLog pagination + `?since` offset parity; Retry-After accuracy; baseline 200/201 correctness;
  schema indexes aligned to query patterns; seed `$disconnect` on fatal; error-code enum completeness;
  type-only deps moved to devDependencies; README/.env.example accuracy.
- Self-correction: R1-D2 (baseline Int/float) was a false positive from a R1 agent that I propagated into
  comments — verified against the contract source and removed.

**Deferred to the Firebase→Postgres flip (NOT code-blocking; the user's separate "discuss" step):**
generate the initial Prisma migration against a real DB + wire a migrate step into deploy; fill the real
ECS execution-role + per-secret SSM ARNs; provision the RDS CA bundle (`DATABASE_SSL_CA`) to enable strict
TLS; copy/relocate `exercises.json` (or accept the sibling-repo seed path) and replace its mock Firebase
illustration URLs; (optional) Redis-backed rate-limit store for multi-instance; ESM-native Prisma
generator; a test-only tsconfig for type-checking `__tests__`.

**Nothing was committed** — all changes are uncommitted in the working tree for review. No git operations
were run. No worktrees used.
