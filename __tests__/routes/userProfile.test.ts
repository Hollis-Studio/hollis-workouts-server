/**
 * Tests for GET / + PUT / on /v1/profile
 *
 * Resource characteristics:
 *   - Per-user SINGLETON — PK = userId (no `:id` param)
 *   - GET /: findUnique({ where: { userId } }); returns 404 when absent
 *   - PUT /: Prisma upsert({ where: { userId } }); userId always from token; 200
 *   - `settings` Json blob validated inline (requires key fields)
 *   - No POST, PATCH, or DELETE routes
 *
 * Test coverage:
 *   - 401 when unauthenticated (GET /, PUT /)
 *   - GET / — findUnique args, 404 on null, 200 with data
 *   - PUT / — 200, upsert where { userId } from token, settings validation, 400 on malformed
 *   - IDOR: userId always comes from token, never from body
 *
 * Mount strategy: the routes are not wired in src/routes/index.ts yet (the
 * integration agent handles that).  This test file builds a local mini-app
 * that mounts the router directly so it can exercise the handler logic
 * independently of the wiring step.
 */

import { describe, it, expect, beforeAll } from "vitest";
import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import type { SuperTest, Test } from "supertest";
import { prismaMock, authedAgent, anonAgent, TEST_USER_ID } from "../helpers/setup.js";
import { userProfileRouter } from "../../src/routes/userProfile.js";
import { errorHandler } from "../../src/middleware/errorHandler.js";
import { sendError } from "../../src/utils/response.js";

// ─────────────────────────────────────────────────────────────────────────────
// Local mini-app (does NOT depend on index.ts wiring)
// ─────────────────────────────────────────────────────────────────────────────

function buildLocalApp(): Express {
  const app = express();
  app.use(express.json());

  // Auth stub — mirrors setup.ts requireAuth mock
  app.use((req: Request, res: Response, next: NextFunction) => {
    const header = req.headers["authorization"];
    if (!header) {
      res.status(401).json({ ok: false, err: { code: "UNAUTHORIZED", message: "Unauthorized" } });
      return;
    }
    req.userId = header;
    next();
  });

  app.use("/v1/profile", userProfileRouter);
  app.use((_req: Request, res: Response) => { sendError(res, "Not found", 404, "NOT_FOUND"); });
  app.use(errorHandler);
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const profileFixture = {
  userId: TEST_USER_ID,
  displayName: "Isaac",
  email: "isaac@example.com",
  settings: {
    defaultWeightUnit: "kg",
    defaultWeightMode: "absolute",
    defaultDistanceUnit: "km",
    progressionIncrementKg: 2.5,
    repIncrement: 1,
    goEasierPercent: 0.15,
    defaultRestTimerSec: 90,
    theme: "clay_dark",
    appleHealthConnected: false,
    repThresholdForWeightJump: 12,
    cardioProgressionFocus: "duration",
    notificationsEnabled: true,
    dailySummaryTime: "09:00",
    weeklySummaryDay: 0,
    workoutReminderEnabled: false,
    workoutReminderTime: "09:00",
  },
  entitlements: null,
  smartReaderFreeUsesRemaining: null,
  lastReviewPromptAt: null,
  fcmDeviceToken: null,
  lastFcmTokenUpdate: null,
  createdAt: new Date("2025-01-01T00:00:00Z"),
  updatedAt: new Date("2025-01-01T00:00:00Z"),
};

const validSettings = {
  defaultWeightUnit: "kg",
  defaultWeightMode: "absolute",
  defaultDistanceUnit: "km",
  progressionIncrementKg: 2.5,
  repIncrement: 1,
  goEasierPercent: 0.15,
  defaultRestTimerSec: 90,
  theme: "clay_dark",
  appleHealthConnected: false,
  repThresholdForWeightJump: 12,
  cardioProgressionFocus: "duration",
  notificationsEnabled: true,
  dailySummaryTime: "09:00",
  weeklySummaryDay: 0,
  workoutReminderEnabled: false,
  workoutReminderTime: "09:00",
};

const validProfileBody = {
  displayName: "Isaac",
  email: "isaac@example.com",
  settings: validSettings,
};

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

let app: Express;
let auth: SuperTest<Test>;
let anon: SuperTest<Test>;

beforeAll(async () => {
  app = buildLocalApp();
  auth = await authedAgent(app);
  anon = await anonAgent(app);
});

// ─────────────────────────────────────────────────────────────────────────────
// Authentication guard
// ─────────────────────────────────────────────────────────────────────────────

describe("profile — authentication", () => {
  it("GET / returns 401 when unauthenticated", async () => {
    const res = await anon.get("/v1/profile");
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it("PUT / returns 401 when unauthenticated", async () => {
    const res = await anon.put("/v1/profile").send(validProfileBody);
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET / — fetch singleton
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/profile", () => {
  it("calls findUnique with where: { userId } from the token", async () => {
    prismaMock.userProfile.findUnique.mockResolvedValue(profileFixture);

    await auth.get("/v1/profile");

    const [args] = prismaMock.userProfile.findUnique.mock.calls[0];
    expect(args.where).toEqual({ userId: TEST_USER_ID });
  });

  it("returns 200 and the profile document when the row exists", async () => {
    prismaMock.userProfile.findUnique.mockResolvedValue(profileFixture);

    const res = await auth.get("/v1/profile");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.userId).toBe(TEST_USER_ID);
    expect(res.body.data.displayName).toBe("Isaac");
  });

  it("returns 404 when no row exists for the user yet", async () => {
    prismaMock.userProfile.findUnique.mockResolvedValue(null);

    const res = await auth.get("/v1/profile");

    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.err.code).toBe("NOT_FOUND");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT / — upsert singleton
// ─────────────────────────────────────────────────────────────────────────────

describe("PUT /v1/profile", () => {
  it("returns 200 (idempotent singleton upsert, not 201)", async () => {
    prismaMock.userProfile.upsert.mockResolvedValue(profileFixture);

    const res = await auth.put("/v1/profile").send(validProfileBody);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("calls upsert with where: { userId } scoped to the token", async () => {
    prismaMock.userProfile.upsert.mockResolvedValue(profileFixture);

    await auth.put("/v1/profile").send(validProfileBody);

    const [args] = prismaMock.userProfile.upsert.mock.calls[0];
    expect(args.where).toEqual({ userId: TEST_USER_ID });
  });

  it("sets userId from the token on create path, never from the body", async () => {
    prismaMock.userProfile.upsert.mockResolvedValue(profileFixture);

    await auth.put("/v1/profile").send({ ...validProfileBody, userId: "injected-attacker" });

    const [args] = prismaMock.userProfile.upsert.mock.calls[0];
    expect(args.create.userId).toBe(TEST_USER_ID);
  });

  it("does not propagate body userId onto the update path", async () => {
    prismaMock.userProfile.upsert.mockResolvedValue(profileFixture);

    await auth.put("/v1/profile").send({ ...validProfileBody, userId: "injected-attacker" });

    const [args] = prismaMock.userProfile.upsert.mock.calls[0];
    // update data must not contain a userId field from the body
    expect(args.update.userId).toBeUndefined();
  });

  it("returns 200 and the upserted profile document", async () => {
    prismaMock.userProfile.upsert.mockResolvedValue(profileFixture);

    const res = await auth.put("/v1/profile").send(validProfileBody);

    expect(res.body.data.userId).toBe(TEST_USER_ID);
    expect(res.body.data.displayName).toBe("Isaac");
  });

  it("returns 400 when displayName is missing", async () => {
    const res = await auth.put("/v1/profile").send({
      settings: validSettings,
    });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when settings is missing", async () => {
    const res = await auth.put("/v1/profile").send({ displayName: "Isaac" });

    expect(res.status).toBe(400);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when settings.defaultWeightUnit is invalid", async () => {
    const res = await auth.put("/v1/profile").send({
      ...validProfileBody,
      settings: { ...validSettings, defaultWeightUnit: "stones" },
    });

    expect(res.status).toBe(400);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when displayName is empty string", async () => {
    const res = await auth.put("/v1/profile").send({
      ...validProfileBody,
      displayName: "",
    });

    expect(res.status).toBe(400);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });
});
