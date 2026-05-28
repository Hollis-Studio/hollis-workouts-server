/**
 * Tests for GET/PUT/DELETE /v1/cardio-baselines
 *
 * Resource characteristics:
 *   - Custom hand-written router (NOT the factory)
 *   - Composite primary key: @@id([userId, canonicalExerciseId]) — no surrogate id
 *   - URL param is :canonicalExerciseId
 *   - All upsert/delete operations use
 *       { userId_canonicalExerciseId: { userId, canonicalExerciseId } }
 *   - bestMETs is z.number().nullable().default(null) — always present in
 *     create/update data (null when client omits it)
 *   - DELETE style: hard
 *
 * Test coverage:
 *   - 401 for all verbs when unauthenticated
 *   - GET /  — findMany scoped to userId
 *   - GET /:canonicalExerciseId — 200 / 404; composite key in where clause
 *   - PUT /:canonicalExerciseId — 201 happy-path; composite key in where+create;
 *     userId/canonicalExerciseId from token/URL (not body); bestMETs defaults null;
 *     400 on invalid body
 *   - DELETE /:canonicalExerciseId — ownership-checked hard delete; 200/404
 */

import { describe, it, expect, beforeAll } from "vitest";
import type { Express } from "express";
import type { SuperTest, Test } from "supertest";
import {
  prismaMock,
  buildApp,
  authedAgent,
  anonAgent,
  TEST_USER_ID,
} from "../helpers/setup.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const EXERCISE_ID = "canonical-exercise-run-5k";

const baselineFixture = {
  userId: TEST_USER_ID,
  canonicalExerciseId: EXERCISE_ID,
  bestDurationSeconds: 1800,
  bestDistanceKm: 5.0,
  bestPaceSecondsPerKm: 360,
  bestMETs: null,
  lowestHRAtPace: null,
  lastDurationSeconds: 1800,
  lastDistanceKm: 5.0,
  lastAvgSpeedKmh: 10.0,
  lastPaceSecondsPerKm: 360,
  lastIncline: null,
  lastResistance: null,
  lastAvgHeartRate: null,
  lastUpdated: new Date("2025-06-01T00:00:00Z"),
  history: [],
  createdAt: new Date("2025-06-01T00:00:00Z"),
};

/**
 * Minimal valid body — omits userId and canonicalExerciseId (those come from
 * token/URL). Also omits bestMETs to assert the route defaults it to null.
 */
const validBaselineBody = {
  bestDurationSeconds: 1800,
  bestDistanceKm: 5.0,
  bestPaceSecondsPerKm: 360,
  lowestHRAtPace: null,
  lastDurationSeconds: 1800,
  lastDistanceKm: 5.0,
  lastAvgSpeedKmh: 10.0,
  lastPaceSecondsPerKm: 360,
  lastIncline: null,
  lastResistance: null,
  lastAvgHeartRate: null,
  lastUpdated: "2025-06-01T00:00:00Z",
  history: [],
};

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

let app: Express;
let auth: SuperTest<Test>;
let anon: SuperTest<Test>;

beforeAll(async () => {
  app = await buildApp();
  auth = await authedAgent(app);
  anon = await anonAgent(app);
});

// ─────────────────────────────────────────────────────────────────────────────
// Authentication guard
// ─────────────────────────────────────────────────────────────────────────────

describe("cardio-baselines — authentication", () => {
  it("GET / returns 401 when unauthenticated", async () => {
    const res = await anon.get("/v1/cardio-baselines");
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it("GET /:canonicalExerciseId returns 401 when unauthenticated", async () => {
    const res = await anon.get(`/v1/cardio-baselines/${EXERCISE_ID}`);
    expect(res.status).toBe(401);
  });

  it("PUT /:canonicalExerciseId returns 401 when unauthenticated", async () => {
    const res = await anon
      .put(`/v1/cardio-baselines/${EXERCISE_ID}`)
      .send(validBaselineBody);
    expect(res.status).toBe(401);
  });

  it("DELETE /:canonicalExerciseId returns 401 when unauthenticated", async () => {
    const res = await anon.delete(`/v1/cardio-baselines/${EXERCISE_ID}`);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET / — list all cardio baselines for authenticated user
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/cardio-baselines", () => {
  it("returns 200 and the user's baselines", async () => {
    prismaMock.cardioBaseline.findMany.mockResolvedValue([baselineFixture]);

    const res = await auth.get("/v1/cardio-baselines");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].canonicalExerciseId).toBe(EXERCISE_ID);
  });

  it("scopes findMany to the authenticated user", async () => {
    prismaMock.cardioBaseline.findMany.mockResolvedValue([]);

    await auth.get("/v1/cardio-baselines");

    const [args] = prismaMock.cardioBaseline.findMany.mock.calls[0];
    expect(args.where).toMatchObject({ userId: TEST_USER_ID });
  });

  it("returns empty items array when user has no baselines", async () => {
    prismaMock.cardioBaseline.findMany.mockResolvedValue([]);

    const res = await auth.get("/v1/cardio-baselines");

    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:canonicalExerciseId — single cardio baseline by composite key
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/cardio-baselines/:canonicalExerciseId", () => {
  it("returns 200 and the baseline when found", async () => {
    prismaMock.cardioBaseline.findUnique.mockResolvedValue(baselineFixture);

    const res = await auth.get(`/v1/cardio-baselines/${EXERCISE_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.canonicalExerciseId).toBe(EXERCISE_ID);
  });

  it("uses the composite key in the where clause", async () => {
    prismaMock.cardioBaseline.findUnique.mockResolvedValue(baselineFixture);

    await auth.get(`/v1/cardio-baselines/${EXERCISE_ID}`);

    const [args] = prismaMock.cardioBaseline.findUnique.mock.calls[0];
    expect(args.where).toEqual({
      userId_canonicalExerciseId: {
        userId: TEST_USER_ID,
        canonicalExerciseId: EXERCISE_ID,
      },
    });
  });

  it("returns 404 when the baseline does not exist", async () => {
    prismaMock.cardioBaseline.findUnique.mockResolvedValue(null);

    const res = await auth.get(`/v1/cardio-baselines/${EXERCISE_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.err.code).toBe("NOT_FOUND");
  });

  it("returns 404 when the baseline is tombstoned (single GET hides deleted rows)", async () => {
    prismaMock.cardioBaseline.findUnique.mockResolvedValue({
      ...baselineFixture,
      deletedAt: new Date(),
    });

    const res = await auth.get(`/v1/cardio-baselines/${EXERCISE_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.err.code).toBe("NOT_FOUND");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /:canonicalExerciseId — composite-key upsert
// ─────────────────────────────────────────────────────────────────────────────

describe("PUT /v1/cardio-baselines/:canonicalExerciseId", () => {
  it("returns 201 on a valid body", async () => {
    prismaMock.cardioBaseline.upsert.mockResolvedValue(baselineFixture);

    const res = await auth
      .put(`/v1/cardio-baselines/${EXERCISE_ID}`)
      .send(validBaselineBody);

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });

  it("uses the composite key in the upsert where clause", async () => {
    prismaMock.cardioBaseline.upsert.mockResolvedValue(baselineFixture);

    await auth
      .put(`/v1/cardio-baselines/${EXERCISE_ID}`)
      .send(validBaselineBody);

    const [args] = prismaMock.cardioBaseline.upsert.mock.calls[0];
    expect(args.where).toEqual({
      userId_canonicalExerciseId: {
        userId: TEST_USER_ID,
        canonicalExerciseId: EXERCISE_ID,
      },
    });
  });

  it("injects userId and canonicalExerciseId from token/URL into create data — never from body", async () => {
    prismaMock.cardioBaseline.upsert.mockResolvedValue(baselineFixture);

    // Attempt to inject a different userId via the body
    await auth
      .put(`/v1/cardio-baselines/${EXERCISE_ID}`)
      .send({ ...validBaselineBody, userId: "hacker-injected", canonicalExerciseId: "hacker-exercise" });

    const [args] = prismaMock.cardioBaseline.upsert.mock.calls[0];
    expect(args.create.userId).toBe(TEST_USER_ID);
    expect(args.create.canonicalExerciseId).toBe(EXERCISE_ID);
  });

  it("bestMETs defaults to null in create data when client omits it", async () => {
    prismaMock.cardioBaseline.upsert.mockResolvedValue(baselineFixture);

    // validBaselineBody deliberately does not include bestMETs
    await auth
      .put(`/v1/cardio-baselines/${EXERCISE_ID}`)
      .send(validBaselineBody);

    const [args] = prismaMock.cardioBaseline.upsert.mock.calls[0];
    // bestMETs must be present as null (never omitted), not undefined
    expect(args.create).toHaveProperty("bestMETs", null);
  });

  it("bestMETs defaults to null in update data when client omits it", async () => {
    prismaMock.cardioBaseline.upsert.mockResolvedValue(baselineFixture);

    await auth
      .put(`/v1/cardio-baselines/${EXERCISE_ID}`)
      .send(validBaselineBody);

    const [args] = prismaMock.cardioBaseline.upsert.mock.calls[0];
    expect(args.update).toHaveProperty("bestMETs", null);
  });

  it("returns 400 when required fields are missing (empty body)", async () => {
    const res = await auth
      .put(`/v1/cardio-baselines/${EXERCISE_ID}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when bestDurationSeconds is not a number", async () => {
    const res = await auth
      .put(`/v1/cardio-baselines/${EXERCISE_ID}`)
      .send({ ...validBaselineBody, bestDurationSeconds: "not-a-number" });

    expect(res.status).toBe(400);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /:canonicalExerciseId — hard delete with IDOR guard
// ─────────────────────────────────────────────────────────────────────────────

describe("DELETE /v1/cardio-baselines/:canonicalExerciseId", () => {
  it("returns 200 and { deleted: true } when the record exists and belongs to this user", async () => {
    prismaMock.cardioBaseline.findUnique.mockResolvedValue(baselineFixture);
    prismaMock.cardioBaseline.delete.mockResolvedValue(baselineFixture);

    const res = await auth.delete(`/v1/cardio-baselines/${EXERCISE_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.deleted).toBe(true);
  });

  it("IDOR guard — findUnique uses composite key scoped to the authenticated user", async () => {
    prismaMock.cardioBaseline.findUnique.mockResolvedValue(baselineFixture);
    prismaMock.cardioBaseline.delete.mockResolvedValue(baselineFixture);

    await auth.delete(`/v1/cardio-baselines/${EXERCISE_ID}`);

    const [findArgs] = prismaMock.cardioBaseline.findUnique.mock.calls[0];
    expect(findArgs.where).toEqual({
      userId_canonicalExerciseId: {
        userId: TEST_USER_ID,
        canonicalExerciseId: EXERCISE_ID,
      },
    });
  });

  it("tombstones via update with the composite key after the ownership check", async () => {
    prismaMock.cardioBaseline.findUnique.mockResolvedValue(baselineFixture);
    prismaMock.cardioBaseline.update.mockResolvedValue(baselineFixture);

    await auth.delete(`/v1/cardio-baselines/${EXERCISE_ID}`);

    expect(prismaMock.cardioBaseline.update).toHaveBeenCalledOnce();
    const [updateArgs] = prismaMock.cardioBaseline.update.mock.calls[0];
    expect(updateArgs.where).toEqual({
      userId_canonicalExerciseId: {
        userId: TEST_USER_ID,
        canonicalExerciseId: EXERCISE_ID,
      },
    });
    expect(updateArgs.data.deletedAt).toBeInstanceOf(Date);
  });

  it("returns 404 and does NOT tombstone when the record is absent", async () => {
    prismaMock.cardioBaseline.findUnique.mockResolvedValue(null);

    const res = await auth.delete(`/v1/cardio-baselines/${EXERCISE_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.err.code).toBe("NOT_FOUND");
    expect(prismaMock.cardioBaseline.update).not.toHaveBeenCalled();
  });
});
