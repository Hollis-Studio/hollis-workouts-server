/**
 * Tests for the Smart Reader free-use counter:
 *   GET  /v1/ai/smart-reader-usage          — read current month usage
 *   POST /v1/ai/recognize-equipment         — enforce monthly limit for non-entitled users
 *
 * Mocking strategy:
 *   - Prisma:      prismaMock (from helpers/setup) — no real DB.
 *   - Auth:        requireAuth stub (from helpers/setup) — reads Authorization header.
 *   - Entitlement: vi.mock() on middleware/entitlement.js — controls checkHollisIntelligence.
 *   - Gemini AI:   vi.mock() on services/ai/recognizeEquipment.js — returns a canned result.
 *
 * Test coverage:
 *   GET /v1/ai/smart-reader-usage:
 *     - 401 when unauthenticated
 *     - 200 with { used, limit, remaining } for non-entitled user (reads DB)
 *     - 200 with { used: 0, limit, remaining: limit } for entitled user (no DB read)
 *     - DB error → 500
 *
 *   POST /v1/ai/recognize-equipment:
 *     - 401 when unauthenticated
 *     - 200 for entitled user (counter never touched, AI called)
 *     - 200 for non-entitled user under limit (counter incremented, AI called)
 *     - 429 RATE_LIMITED for non-entitled user at limit (counter NOT incremented)
 *     - 429 details shape: { used, limit, remaining: 0 }
 *     - 400 on invalid body
 *     - IDOR: userId from token, never from body
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import type { SuperTest, Test } from "supertest";
import { prismaMock, authedAgent, anonAgent, TEST_USER_ID } from "../helpers/setup.js";
import { errorHandler } from "../../src/middleware/errorHandler.js";
import { sendError } from "../../src/utils/response.js";

// ── Mocks (must be declared before any dynamic imports that pull the real modules) ──

vi.mock("../../src/middleware/entitlement.js", () => ({
  requireEntitlement: (_req: Request, _res: Response, next: NextFunction) => next(),
  checkHollisIntelligence: vi.fn(),
  clearEntitlementCacheForTests: vi.fn(),
}));

vi.mock("../../src/services/ai/recognizeEquipment.js", () => ({
  recognizeEquipment: vi.fn(),
}));

// ── Typed imports (after mock declarations) ───────────────────────────────────

import { checkHollisIntelligence } from "../../src/middleware/entitlement.js";
import { recognizeEquipment } from "../../src/services/ai/recognizeEquipment.js";
import { smartReaderUsageRouter } from "../../src/routes/ai/smartReaderUsage.js";
import { recognizeEquipmentRouter } from "../../src/routes/ai/recognizeEquipment.js";

const mockCheckEntitlement = vi.mocked(checkHollisIntelligence);
const mockRecognizeEquipment = vi.mocked(recognizeEquipment);

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VALID_BODY = {
  imageBase64: "aGVsbG8=", // base64("hello") — valid non-empty string
};

const RECOGNIZE_SUCCESS = {
  equipmentType: "barbell",
  suggestedExerciseName: "Barbell Back Squat",
  confidence: 0.95,
  clarifyingQuestions: [],
};

const USAGE_ROW_AT_3 = { userId: TEST_USER_ID, month: "2026-05", count: 3, updatedAt: new Date() };
const USAGE_ROW_AT_5 = { userId: TEST_USER_ID, month: "2026-05", count: 5, updatedAt: new Date() };

// ── Mini-app builder ──────────────────────────────────────────────────────────

function buildLocalApp(): Express {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    const header = req.headers["authorization"];
    if (!header) {
      res.status(401).json({ ok: false, err: { code: "UNAUTHORIZED", message: "Unauthorized" } });
      return;
    }
    req.userId = header;
    next();
  });

  app.use("/v1/ai/smart-reader-usage", smartReaderUsageRouter);
  app.use("/v1/ai/recognize-equipment", recognizeEquipmentRouter);
  app.use((_req: Request, res: Response) => { sendError(res, "Not found", 404, "NOT_FOUND"); });
  app.use(errorHandler);
  return app;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

let app: Express;
let auth: SuperTest<Test>;
let anon: SuperTest<Test>;

beforeAll(async () => {
  app = buildLocalApp();
  auth = await authedAgent(app);
  anon = await anonAgent(app);
});

// Reset vi mocks that are not covered by the setup.ts resetMocks() (which only
// covers prismaMock). The entitlement and recognizeEquipment mocks are module-
// level vi.fn()s — reset them before each test so call counts don't bleed.
beforeEach(() => {
  mockCheckEntitlement.mockReset();
  mockRecognizeEquipment.mockReset();
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/ai/smart-reader-usage
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/ai/smart-reader-usage — authentication", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await anon.get("/v1/ai/smart-reader-usage");
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });
});

describe("GET /v1/ai/smart-reader-usage — entitled user", () => {
  it("returns { used: 0, limit, remaining: limit } without touching the DB", async () => {
    mockCheckEntitlement.mockResolvedValue(true);

    const res = await auth.get("/v1/ai/smart-reader-usage");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.used).toBe(0);
    expect(res.body.data.limit).toBeGreaterThan(0);
    expect(res.body.data.remaining).toBe(res.body.data.limit);

    // DB must NOT be called for entitled users
    expect(prismaMock.smartReaderUsage.findUnique).not.toHaveBeenCalled();
  });
});

describe("GET /v1/ai/smart-reader-usage — non-entitled user", () => {
  it("returns { used, limit, remaining } from the DB row", async () => {
    mockCheckEntitlement.mockResolvedValue(false);
    prismaMock.smartReaderUsage.findUnique.mockResolvedValue(USAGE_ROW_AT_3);

    const res = await auth.get("/v1/ai/smart-reader-usage");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.used).toBe(3);
    expect(res.body.data.remaining).toBe(res.body.data.limit - 3);

    const [args] = prismaMock.smartReaderUsage.findUnique.mock.calls[0];
    expect(args.where).toMatchObject({ userId_month: { userId: TEST_USER_ID } });
  });

  it("returns used: 0 when no row exists yet (first month)", async () => {
    mockCheckEntitlement.mockResolvedValue(false);
    prismaMock.smartReaderUsage.findUnique.mockResolvedValue(null);

    const res = await auth.get("/v1/ai/smart-reader-usage");

    expect(res.status).toBe(200);
    expect(res.body.data.used).toBe(0);
    expect(res.body.data.remaining).toBe(res.body.data.limit);
  });

  it("returns 500 when DB read fails", async () => {
    mockCheckEntitlement.mockResolvedValue(false);
    prismaMock.smartReaderUsage.findUnique.mockRejectedValue(new Error("DB error"));

    const res = await auth.get("/v1/ai/smart-reader-usage");

    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/ai/recognize-equipment
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /v1/ai/recognize-equipment — authentication", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await anon.post("/v1/ai/recognize-equipment").send(VALID_BODY);
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });
});

describe("POST /v1/ai/recognize-equipment — entitled user", () => {
  it("returns 200 and never touches the usage counter", async () => {
    mockCheckEntitlement.mockResolvedValue(true);
    mockRecognizeEquipment.mockResolvedValue({ ok: true, data: RECOGNIZE_SUCCESS });

    const res = await auth.post("/v1/ai/recognize-equipment").send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.equipmentType).toBe("barbell");

    // Counter DB methods must NOT be called for entitled users
    expect(prismaMock.smartReaderUsage.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.smartReaderUsage.upsert).not.toHaveBeenCalled();
  });

  it("passes userId from token to recognizeEquipment service", async () => {
    mockCheckEntitlement.mockResolvedValue(true);
    mockRecognizeEquipment.mockResolvedValue({ ok: true, data: RECOGNIZE_SUCCESS });

    await auth.post("/v1/ai/recognize-equipment").send(VALID_BODY);

    const [calledUserId] = mockRecognizeEquipment.mock.calls[0];
    expect(calledUserId).toBe(TEST_USER_ID);
  });
});

describe("POST /v1/ai/recognize-equipment — non-entitled user under limit", () => {
  it("returns 200 and increments the counter", async () => {
    mockCheckEntitlement.mockResolvedValue(false);
    // Under limit: findUnique returns count=3
    prismaMock.smartReaderUsage.findUnique.mockResolvedValue(USAGE_ROW_AT_3);
    prismaMock.smartReaderUsage.upsert.mockResolvedValue({ ...USAGE_ROW_AT_3, count: 4 });
    mockRecognizeEquipment.mockResolvedValue({ ok: true, data: RECOGNIZE_SUCCESS });

    const res = await auth.post("/v1/ai/recognize-equipment").send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Counter must have been incremented
    expect(prismaMock.smartReaderUsage.upsert).toHaveBeenCalledOnce();
    const [upsertArgs] = prismaMock.smartReaderUsage.upsert.mock.calls[0];
    expect(upsertArgs.where).toMatchObject({ userId_month: { userId: TEST_USER_ID } });
    expect(upsertArgs.update).toMatchObject({ count: { increment: 1 } });
    expect(upsertArgs.create).toMatchObject({ userId: TEST_USER_ID, count: 1 });
  });

  it("scopes findUnique to the authenticated user (IDOR guard)", async () => {
    mockCheckEntitlement.mockResolvedValue(false);
    prismaMock.smartReaderUsage.findUnique.mockResolvedValue(null);
    prismaMock.smartReaderUsage.upsert.mockResolvedValue({ ...USAGE_ROW_AT_3, count: 1 });
    mockRecognizeEquipment.mockResolvedValue({ ok: true, data: RECOGNIZE_SUCCESS });

    await auth.post("/v1/ai/recognize-equipment").send(VALID_BODY);

    const [findArgs] = prismaMock.smartReaderUsage.findUnique.mock.calls[0];
    expect(findArgs.where.userId_month.userId).toBe(TEST_USER_ID);
  });
});

describe("POST /v1/ai/recognize-equipment — non-entitled user at limit", () => {
  it("returns 429 RATE_LIMITED and does NOT call the AI service", async () => {
    mockCheckEntitlement.mockResolvedValue(false);
    // At limit: findUnique returns count equal to the configured limit
    prismaMock.smartReaderUsage.findUnique.mockResolvedValue(USAGE_ROW_AT_5);

    const res = await auth.post("/v1/ai/recognize-equipment").send(VALID_BODY);

    expect(res.status).toBe(429);
    expect(res.body.ok).toBe(false);
    expect(res.body.err.code).toBe("RATE_LIMITED");

    // AI service must NOT be called when rate-limited
    expect(mockRecognizeEquipment).not.toHaveBeenCalled();
    // Counter must NOT be incremented after the limit is reached
    expect(prismaMock.smartReaderUsage.upsert).not.toHaveBeenCalled();
  });

  it("includes { used, limit, remaining: 0 } in the error details", async () => {
    mockCheckEntitlement.mockResolvedValue(false);
    prismaMock.smartReaderUsage.findUnique.mockResolvedValue(USAGE_ROW_AT_5);

    const res = await auth.post("/v1/ai/recognize-equipment").send(VALID_BODY);

    expect(res.status).toBe(429);
    const details = res.body.err.details as { used: number; limit: number; remaining: number };
    expect(details.remaining).toBe(0);
    expect(details.used).toBe(5);
    expect(details.limit).toBeGreaterThan(0);
  });
});

describe("POST /v1/ai/recognize-equipment — validation", () => {
  it("returns 400 when imageBase64 is missing", async () => {
    mockCheckEntitlement.mockResolvedValue(true);

    const res = await auth.post("/v1/ai/recognize-equipment").send({});

    expect(res.status).toBe(400);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });
});
