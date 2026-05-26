/**
 * Exemplar tests for GET/PUT/DELETE /v1/progression-baselines
 *
 * Resource characteristics:
 *   - Custom hand-written router (NOT the factory)
 *   - Composite primary key: @@id([userId, canonicalExerciseId])
 *   - URL param is :canonicalExerciseId; no surrogate id column
 *   - All where clauses use `userId_canonicalExerciseId: { userId, canonicalExerciseId }`
 *   - DELETE is hard (real delete after IDOR guard)
 *   - PUT is a true upsert (create if absent, update if present)
 *
 * Test coverage:
 *   - 401 for all verbs when unauthenticated
 *   - GET /  — findMany scoped to userId
 *   - GET /:canonicalExerciseId — 200 / 404; composite key in where clause
 *   - PUT /:canonicalExerciseId — 201 happy-path; 400 on invalid body; user-scoping
 *   - DELETE /:canonicalExerciseId — 200 when found; 404 when absent
 */

import { describe, it, expect, beforeAll } from "vitest";
import type { Express } from "express";
import type { SuperTest, Test } from "supertest";
import { prismaMock, buildApp, authedAgent, anonAgent, TEST_USER_ID } from "../helpers/setup.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const EXERCISE_ID = "canonical-exercise-bench-press";

const baselineFixture = {
  userId: TEST_USER_ID,
  canonicalExerciseId: EXERCISE_ID,
  currentE1RM_Kg: 100,
  topSetWeightKg: 90,
  topSetReps: 5,
  topSetRIR: 2,
  lastUpdated: new Date("2025-06-01T00:00:00Z"),
  history: [],
};

/** Minimal valid body — omits userId and canonicalExerciseId (those come from token/URL). */
const validBaselineBody = {
  currentE1RM_Kg: 100,
  topSetWeightKg: 90,
  topSetReps: 5,
  topSetRIR: 2,
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

describe("progression-baselines — authentication", () => {
  it("GET / returns 401 when unauthenticated", async () => {
    const res = await anon.get("/v1/progression-baselines");
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it("GET /:canonicalExerciseId returns 401 when unauthenticated", async () => {
    const res = await anon.get(`/v1/progression-baselines/${EXERCISE_ID}`);
    expect(res.status).toBe(401);
  });

  it("PUT /:canonicalExerciseId returns 401 when unauthenticated", async () => {
    const res = await anon
      .put(`/v1/progression-baselines/${EXERCISE_ID}`)
      .send(validBaselineBody);
    expect(res.status).toBe(401);
  });

  it("DELETE /:canonicalExerciseId returns 401 when unauthenticated", async () => {
    const res = await anon.delete(`/v1/progression-baselines/${EXERCISE_ID}`);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET / — list all baselines for authenticated user
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/progression-baselines", () => {
  it("returns 200 and the user's baselines", async () => {
    prismaMock.progressionBaseline.findMany.mockResolvedValue([baselineFixture]);

    const res = await auth.get("/v1/progression-baselines");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.items).toHaveLength(1);
  });

  it("scopes findMany to the authenticated user", async () => {
    prismaMock.progressionBaseline.findMany.mockResolvedValue([]);

    await auth.get("/v1/progression-baselines");

    const [args] = prismaMock.progressionBaseline.findMany.mock.calls[0];
    expect(args.where).toMatchObject({ userId: TEST_USER_ID });
  });

  it("includes nextCursor in the response (null when the page is not full)", async () => {
    prismaMock.progressionBaseline.findMany.mockResolvedValue([baselineFixture]);

    const res = await auth.get("/v1/progression-baselines");

    expect(res.body.data).toHaveProperty("nextCursor");
    expect(res.body.data.nextCursor).toBeNull();
  });

  it("forwards the composite-key cursor scoped to the user when ?cursor is given", async () => {
    prismaMock.progressionBaseline.findMany.mockResolvedValue([]);

    await auth.get("/v1/progression-baselines?cursor=some-exercise-id");

    const [args] = prismaMock.progressionBaseline.findMany.mock.calls[0];
    expect(args.cursor).toEqual({
      userId_canonicalExerciseId: {
        userId: TEST_USER_ID,
        canonicalExerciseId: "some-exercise-id",
      },
    });
    expect(args.skip).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:canonicalExerciseId — single baseline by composite key
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/progression-baselines/:canonicalExerciseId", () => {
  it("returns 200 and the baseline when found", async () => {
    prismaMock.progressionBaseline.findUnique.mockResolvedValue(baselineFixture);

    const res = await auth.get(`/v1/progression-baselines/${EXERCISE_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.canonicalExerciseId).toBe(EXERCISE_ID);
  });

  it("uses the composite key in the where clause", async () => {
    prismaMock.progressionBaseline.findUnique.mockResolvedValue(baselineFixture);

    await auth.get(`/v1/progression-baselines/${EXERCISE_ID}`);

    const [args] = prismaMock.progressionBaseline.findUnique.mock.calls[0];
    expect(args.where).toEqual({
      userId_canonicalExerciseId: {
        userId: TEST_USER_ID,
        canonicalExerciseId: EXERCISE_ID,
      },
    });
  });

  it("returns 404 when the baseline does not exist", async () => {
    prismaMock.progressionBaseline.findUnique.mockResolvedValue(null);

    const res = await auth.get(`/v1/progression-baselines/${EXERCISE_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.err.code).toBe("NOT_FOUND");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /:canonicalExerciseId — composite-key upsert
// ─────────────────────────────────────────────────────────────────────────────

describe("PUT /v1/progression-baselines/:canonicalExerciseId", () => {
  it("returns 201 on a valid body when the baseline does not yet exist", async () => {
    prismaMock.progressionBaseline.findUnique.mockResolvedValue(null);
    prismaMock.progressionBaseline.upsert.mockResolvedValue(baselineFixture);

    const res = await auth
      .put(`/v1/progression-baselines/${EXERCISE_ID}`)
      .send(validBaselineBody);

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });

  it("returns 200 when the baseline already exists (update path)", async () => {
    prismaMock.progressionBaseline.findUnique.mockResolvedValue(baselineFixture);
    prismaMock.progressionBaseline.upsert.mockResolvedValue(baselineFixture);

    const res = await auth
      .put(`/v1/progression-baselines/${EXERCISE_ID}`)
      .send(validBaselineBody);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("uses the composite key in the upsert where clause", async () => {
    prismaMock.progressionBaseline.upsert.mockResolvedValue(baselineFixture);

    await auth
      .put(`/v1/progression-baselines/${EXERCISE_ID}`)
      .send(validBaselineBody);

    const [args] = prismaMock.progressionBaseline.upsert.mock.calls[0];
    expect(args.where).toEqual({
      userId_canonicalExerciseId: {
        userId: TEST_USER_ID,
        canonicalExerciseId: EXERCISE_ID,
      },
    });
    // userId must come from the token, never the body
    expect(args.create.userId).toBe(TEST_USER_ID);
    expect(args.create.canonicalExerciseId).toBe(EXERCISE_ID);
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await auth
      .put(`/v1/progression-baselines/${EXERCISE_ID}`)
      .send({}); // completely empty body

    expect(res.status).toBe(400);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when reps is not a number", async () => {
    const res = await auth
      .put(`/v1/progression-baselines/${EXERCISE_ID}`)
      .send({ ...validBaselineBody, topSetReps: "five" });

    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /:canonicalExerciseId — hard delete with IDOR guard
// ─────────────────────────────────────────────────────────────────────────────

describe("DELETE /v1/progression-baselines/:canonicalExerciseId", () => {
  it("returns 200 and { deleted: true } when the record exists", async () => {
    prismaMock.progressionBaseline.findUnique.mockResolvedValue(baselineFixture);
    prismaMock.progressionBaseline.delete.mockResolvedValue(baselineFixture);

    const res = await auth.delete(`/v1/progression-baselines/${EXERCISE_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);
  });

  it("performs an IDOR guard — checks ownership before deleting", async () => {
    prismaMock.progressionBaseline.findUnique.mockResolvedValue(baselineFixture);
    prismaMock.progressionBaseline.delete.mockResolvedValue(baselineFixture);

    await auth.delete(`/v1/progression-baselines/${EXERCISE_ID}`);

    // findUnique must be called with the composite key scoped to this user
    const [findArgs] = prismaMock.progressionBaseline.findUnique.mock.calls[0];
    expect(findArgs.where.userId_canonicalExerciseId.userId).toBe(TEST_USER_ID);
  });

  it("returns 404 and does NOT call delete when the record is absent", async () => {
    prismaMock.progressionBaseline.findUnique.mockResolvedValue(null);

    const res = await auth.delete(`/v1/progression-baselines/${EXERCISE_ID}`);

    expect(res.status).toBe(404);
    expect(prismaMock.progressionBaseline.delete).not.toHaveBeenCalled();
  });
});
