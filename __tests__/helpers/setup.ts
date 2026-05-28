/**
 * Shared test setup for hollis-workouts-server.
 *
 * This file is referenced in vitest.config.ts as setupFiles, so it runs in
 * each Vitest worker before any test file is loaded.  vi.mock() calls here
 * take effect for the entire worker's module registry.
 *
 * Exports:
 *   prismaMock        — the controllable Prisma singleton mock (vi.fn() per model method)
 *   TEST_USER_ID      — the userId the authed test client presents
 *   ALT_USER_ID       — a second userId for IDOR / isolation checks
 *   buildApp()        — assemble the Express app without listening (async)
 *   authedAgent(app)  — supertest client pre-set with Authorization: TEST_USER_ID
 *   anonAgent(app)    — supertest client with NO Authorization header
 *   resetMocks()      — reset all mock call counts/return values (call in beforeEach)
 *
 * Mock strategy:
 *   - Prisma singleton: vi.mock() replaces ../../src/lib/prisma.js with prismaMock.
 *     No real PrismaClient or Postgres connection is made.
 *   - Auth middleware: vi.mock() replaces ../../src/middleware/auth.js.
 *     The stub reads the raw Authorization header value as req.userId.
 *     No JWT verification or Identity Service call is made.
 *   - express-rate-limit: vi.mock() replaces the package with a no-op passthrough
 *     so ERR_ERL_KEY_GEN_IPV6 validation does not throw at module load.
 *     (The source already skips rate limiting at request time when NODE_ENV=test;
 *     this mock prevents the constructor-time validation error.)
 *   - Env validation: fake values in vitest.config.ts env satisfy lib/env.ts.
 */

import { vi, beforeEach } from "vitest";
import type { Express, Request, Response, NextFunction } from "express";

// ─────────────────────────────────────────────────────────────────────────────
// 0. Mock express-rate-limit
//
// The writeRateLimiter's `keyGenerator` falls back to req.ip which triggers
// express-rate-limit v8's ERR_ERL_KEY_GEN_IPV6 validation error at module load.
// Since we're in a test environment and all rate limiting is bypassed at request
// time anyway, we replace the entire package with a no-op factory.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("express-rate-limit", () => {
  // Returns a passthrough Express middleware regardless of config
  const noop = (_req: Request, _res: Response, next: NextFunction) => next();
  const rateLimit = () => noop;
  return { default: rateLimit, rateLimit };
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Prisma mock
// ─────────────────────────────────────────────────────────────────────────────

function makeModelMock() {
  return {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  };
}

export const prismaMock = {
  gym: makeModelMock(),
  program: makeModelMock(),
  session: makeModelMock(),
  progressionBaseline: makeModelMock(),
  cardioBaseline: makeModelMock(),
  gymExerciseInstance: makeModelMock(),
  userExercise: makeModelMock(),
  exerciseAlias: makeModelMock(),
  week: makeModelMock(),
  aiAuditLogEntry: makeModelMock(),
  injuryRecord: makeModelMock(),
  conversationRollingSummary: makeModelMock(),
  metricBasketSnapshotRecord: makeModelMock(),
  canonicalExercise: makeModelMock(),
  // New models (Wave 2b routes)
  userProfile: makeModelMock(),
  smartBuilderDraft: makeModelMock(),
  plateauCoachingArtifact: makeModelMock(),
  cancellationFeedback: makeModelMock(),
  aiTokenUsage: makeModelMock(),
  smartReaderUsage: makeModelMock(),
  $transaction: vi.fn(),
  $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
  $disconnect: vi.fn(),
};

// Minimal stand-in for Prisma.PrismaClientKnownRequestError so the error
// handler's `err instanceof Prisma.PrismaClientKnownRequestError` works under
// the mock (a bare `{}` would make `instanceof` throw). Tests can throw this to
// simulate P2002/P2025. The vi.mock factory is invoked lazily (on first import
// of the mocked module), so referencing this class defined above is safe.
export class PrismaKnownErrorMock extends Error {
  code: string;
  constructor(message: string, opts?: { code?: string }) {
    super(message);
    this.name = "PrismaClientKnownRequestError";
    this.code = opts?.code ?? "";
  }
}

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: prismaMock,
  Prisma: { PrismaClientKnownRequestError: PrismaKnownErrorMock },
  PrismaClient: class {},
}));

// ─────────────────────────────────────────────────────────────────────────────
// 2. Auth middleware mock
// ─────────────────────────────────────────────────────────────────────────────

export const TEST_USER_ID = "test-user-id";
export const ALT_USER_ID = "other-user-id";

vi.mock("../../src/middleware/auth.js", () => ({
  requireAuth: (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers["authorization"];
    if (!header) {
      res
        .status(401)
        .json({ ok: false, err: { code: "UNAUTHORIZED", message: "Unauthorized" } });
      return;
    }
    // Raw header value becomes req.userId — tests pass TEST_USER_ID directly.
    req.userId = header;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as any).tokenClaims = { type: "access", userId: header };
    next();
  },
}));

// ─────────────────────────────────────────────────────────────────────────────
// 3. App factory
//
// Dynamic imports are resolved AFTER vi.mock() has intercepted the registry,
// so route files get the mocked prisma, auth, and rate-limit.
// ─────────────────────────────────────────────────────────────────────────────

export async function buildApp(): Promise<Express> {
  // Use the SAME factory the production entrypoint uses, so the app under test
  // is identical to the app that ships. Dynamic import resolves AFTER vi.mock()
  // has intercepted prisma/auth/rate-limit in the module registry.
  const { createApp } = await import("../../src/app.js");
  return createApp();
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Supertest agent helpers
//
// supertest is a CJS module. In an ESM context, `supertest(app)` returns a
// method-router object (no persistent `.set()`). To set default headers for all
// requests we use `supertest.agent(app)` — the Agent class inherits `.set()`
// from superagent's Agent base, which queues headers applied to every request.
//
// CJS interop note: when imported via `import()` in Vitest's ESM runner, the
// default export is the supertest function. `.agent` is a property on it.
// ─────────────────────────────────────────────────────────────────────────────

type SupertestStatic = (typeof import("supertest"))["default"];

async function getSupertestStatic(): Promise<SupertestStatic> {
  const mod = await import("supertest");
  // In Vitest's ESM/CJS interop, mod.default is the supertest function.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (mod as any).default as SupertestStatic;
}

/**
 * Returns a supertest Agent with Authorization: TEST_USER_ID applied to
 * every request. Use this for tests that need an authenticated client.
 */
export async function authedAgent(app: Express) {
  const supertest = await getSupertestStatic();
  // `supertest.agent(app)` creates a persistent agent with cookie/header
  // tracking. `.set()` registers the header for all subsequent requests.
  return supertest.agent(app).set("Authorization", TEST_USER_ID);
}

/**
 * Returns a plain supertest Agent with no Authorization header.
 * Use this to assert 401 for unauthenticated requests.
 */
export async function anonAgent(app: Express) {
  const supertest = await getSupertestStatic();
  return supertest.agent(app);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Mock reset helper — called automatically before each test
// ─────────────────────────────────────────────────────────────────────────────

export function resetMocks(): void {
  for (const value of Object.values(prismaMock)) {
    if (value && typeof value === "function" && "mockReset" in value) {
      // Root-level client mocks: $transaction, $queryRaw, $disconnect, etc.
      (value as ReturnType<typeof vi.fn>).mockReset();
    } else if (value && typeof value === "object") {
      for (const fn of Object.values(value)) {
        if (fn && typeof fn === "function" && "mockReset" in fn) {
          (fn as ReturnType<typeof vi.fn>).mockReset();
        }
      }
    }
  }
  prismaMock.$queryRaw.mockResolvedValue([{ "?column?": 1 }]);
}

beforeEach(() => {
  resetMocks();
});
