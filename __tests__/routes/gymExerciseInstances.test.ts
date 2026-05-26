/**
 * Tests for GET/PUT/DELETE /v1/gym-exercise-instances
 *
 * Resource characteristics:
 *   - Produced by createCrudRouter() factory with deleteStyle: "hard"
 *   - Client-generated UUIDs; PUT uses ownership-checked two-step:
 *       1. findFirst({ where: { id, userId } }) — IDOR ownership check
 *       2a. update → 200 if owned row found
 *       2b. create → 201 if no owned row exists
 *   - Hard delete: DELETE /:id (not PATCH)
 *   - Optional ?gymProfileId and ?canonicalExerciseId filters on GET /
 *   - Invalid filter params return 400 (not silently dropped)
 *
 * Test coverage:
 *   - 401 for all verbs when unauthenticated
 *   - GET /  — userId-scoped; both filters applied to where; 400 on invalid filter
 *   - GET /:id — 200 when found; 404 when absent; userId-scoped via findFirst
 *   - PUT /:id — 201 create path; 200 update path; IDOR two-step; userId from token; 400 on invalid body
 *   - DELETE /:id — ownership-checked hard delete; 200/404
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

const INSTANCE_ID = "gei-uuid-001";
const GYM_PROFILE_ID = "gym-profile-uuid-001";
const CANONICAL_EXERCISE_ID = "canonical-exercise-squat";

const instanceFixture = {
  id: INSTANCE_ID,
  userId: TEST_USER_ID,
  gymProfileId: GYM_PROFILE_ID,
  canonicalExerciseId: CANONICAL_EXERCISE_ID,
  baseWeightKg: 100,
  weightUnit: "kg" as const,
  weightMode: "absolute" as const,
  weightIncrementKg: 2.5,
  isActive: true,
  notes: null,
  lastUsedWeightKg: 100,
  createdAt: new Date("2025-01-01T00:00:00Z"),
  updatedAt: new Date("2025-01-01T00:00:00Z"),
};

const validInstanceBody = {
  gymProfileId: GYM_PROFILE_ID,
  canonicalExerciseId: CANONICAL_EXERCISE_ID,
  baseWeightKg: 100,
  weightUnit: "kg",
  weightMode: "absolute",
  weightIncrementKg: 2.5,
  isActive: true,
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

describe("gym-exercise-instances — authentication", () => {
  it("GET / returns 401 when unauthenticated", async () => {
    const res = await anon.get("/v1/gym-exercise-instances");
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it("GET /:id returns 401 when unauthenticated", async () => {
    const res = await anon.get(`/v1/gym-exercise-instances/${INSTANCE_ID}`);
    expect(res.status).toBe(401);
  });

  it("PUT /:id returns 401 when unauthenticated", async () => {
    const res = await anon
      .put(`/v1/gym-exercise-instances/${INSTANCE_ID}`)
      .send(validInstanceBody);
    expect(res.status).toBe(401);
  });

  it("DELETE /:id returns 401 when unauthenticated", async () => {
    const res = await anon.delete(`/v1/gym-exercise-instances/${INSTANCE_ID}`);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET / — list
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/gym-exercise-instances", () => {
  it("returns 200 and scopes the query to the authenticated user", async () => {
    prismaMock.gymExerciseInstance.findMany.mockResolvedValue([instanceFixture]);

    const res = await auth.get("/v1/gym-exercise-instances");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].id).toBe(INSTANCE_ID);

    const [args] = prismaMock.gymExerciseInstance.findMany.mock.calls[0];
    expect(args.where).toMatchObject({ userId: TEST_USER_ID });
  });

  it("applies the ?gymProfileId filter to the where clause", async () => {
    prismaMock.gymExerciseInstance.findMany.mockResolvedValue([]);

    await auth.get(`/v1/gym-exercise-instances?gymProfileId=${GYM_PROFILE_ID}`);

    const [args] = prismaMock.gymExerciseInstance.findMany.mock.calls[0];
    expect(args.where).toMatchObject({
      userId: TEST_USER_ID,
      gymProfileId: GYM_PROFILE_ID,
    });
  });

  it("applies the ?canonicalExerciseId filter to the where clause", async () => {
    prismaMock.gymExerciseInstance.findMany.mockResolvedValue([]);

    await auth.get(
      `/v1/gym-exercise-instances?canonicalExerciseId=${CANONICAL_EXERCISE_ID}`
    );

    const [args] = prismaMock.gymExerciseInstance.findMany.mock.calls[0];
    expect(args.where).toMatchObject({
      userId: TEST_USER_ID,
      canonicalExerciseId: CANONICAL_EXERCISE_ID,
    });
  });

  it("applies both ?gymProfileId and ?canonicalExerciseId filters together", async () => {
    prismaMock.gymExerciseInstance.findMany.mockResolvedValue([]);

    await auth.get(
      `/v1/gym-exercise-instances?gymProfileId=${GYM_PROFILE_ID}&canonicalExerciseId=${CANONICAL_EXERCISE_ID}`
    );

    const [args] = prismaMock.gymExerciseInstance.findMany.mock.calls[0];
    expect(args.where).toMatchObject({
      userId: TEST_USER_ID,
      gymProfileId: GYM_PROFILE_ID,
      canonicalExerciseId: CANONICAL_EXERCISE_ID,
    });
  });

  it("returns 400 when ?gymProfileId is present but invalid (empty string)", async () => {
    // An empty string fails idSchema.min(1) — the route must 400 rather than
    // silently drop the filter (which would return all rows for the user).
    const res = await auth.get("/v1/gym-exercise-instances?gymProfileId=");

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when ?canonicalExerciseId is present but invalid (empty string)", async () => {
    const res = await auth.get(
      "/v1/gym-exercise-instances?canonicalExerciseId="
    );

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });

  it("returns an empty items array when there are no matching instances", async () => {
    prismaMock.gymExerciseInstance.findMany.mockResolvedValue([]);

    const res = await auth.get("/v1/gym-exercise-instances");

    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:id — single resource
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/gym-exercise-instances/:id", () => {
  it("returns 200 and the instance when found", async () => {
    prismaMock.gymExerciseInstance.findFirst.mockResolvedValue(instanceFixture);

    const res = await auth.get(`/v1/gym-exercise-instances/${INSTANCE_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.id).toBe(INSTANCE_ID);
  });

  it("scopes the findFirst query to the authenticated user", async () => {
    prismaMock.gymExerciseInstance.findFirst.mockResolvedValue(instanceFixture);

    await auth.get(`/v1/gym-exercise-instances/${INSTANCE_ID}`);

    const [args] = prismaMock.gymExerciseInstance.findFirst.mock.calls[0];
    expect(args.where).toMatchObject({ id: INSTANCE_ID, userId: TEST_USER_ID });
  });

  it("returns 404 when the instance does not exist", async () => {
    prismaMock.gymExerciseInstance.findFirst.mockResolvedValue(null);

    const res = await auth.get(`/v1/gym-exercise-instances/${INSTANCE_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.err.code).toBe("NOT_FOUND");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /:id — idempotent upsert with IDOR two-step
// ─────────────────────────────────────────────────────────────────────────────

describe("PUT /v1/gym-exercise-instances/:id", () => {
  it("returns 201 and the created instance on the CREATE path (no owned row found)", async () => {
    prismaMock.gymExerciseInstance.findFirst.mockResolvedValue(null);
    prismaMock.gymExerciseInstance.create.mockResolvedValue(instanceFixture);

    const res = await auth
      .put(`/v1/gym-exercise-instances/${INSTANCE_ID}`)
      .send(validInstanceBody);

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(prismaMock.gymExerciseInstance.create).toHaveBeenCalledOnce();
    expect(prismaMock.gymExerciseInstance.update).not.toHaveBeenCalled();
  });

  it("returns 200 and the updated instance on the UPDATE path (owned row exists)", async () => {
    prismaMock.gymExerciseInstance.findFirst.mockResolvedValue(instanceFixture);
    prismaMock.gymExerciseInstance.update.mockResolvedValue({
      ...instanceFixture,
      weightIncrementKg: 5,
    });

    const res = await auth
      .put(`/v1/gym-exercise-instances/${INSTANCE_ID}`)
      .send({ ...validInstanceBody, weightIncrementKg: 5 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(prismaMock.gymExerciseInstance.update).toHaveBeenCalledOnce();
    expect(prismaMock.gymExerciseInstance.create).not.toHaveBeenCalled();
  });

  it("IDOR two-step — findFirst scopes ownership check to { id, userId }", async () => {
    // A foreign-owned row returns null from findFirst (it's not owned by this user),
    // so the factory falls through to create — never calling update on the foreign row.
    prismaMock.gymExerciseInstance.findFirst.mockResolvedValue(null);
    prismaMock.gymExerciseInstance.create.mockResolvedValue(instanceFixture);

    await auth
      .put(`/v1/gym-exercise-instances/${INSTANCE_ID}`)
      .send(validInstanceBody);

    const [findFirstArgs] = prismaMock.gymExerciseInstance.findFirst.mock.calls[0];
    expect(findFirstArgs.where).toMatchObject({
      id: INSTANCE_ID,
      userId: TEST_USER_ID,
    });
    expect(prismaMock.gymExerciseInstance.update).not.toHaveBeenCalled();
  });

  it("sets userId from the token on the create path — never from the request body", async () => {
    prismaMock.gymExerciseInstance.findFirst.mockResolvedValue(null);
    prismaMock.gymExerciseInstance.create.mockResolvedValue(instanceFixture);

    await auth
      .put(`/v1/gym-exercise-instances/${INSTANCE_ID}`)
      .send({ ...validInstanceBody, userId: "hacker-injected-user" });

    const [createArgs] = prismaMock.gymExerciseInstance.create.mock.calls[0];
    expect(createArgs.data.userId).toBe(TEST_USER_ID);
  });

  it("sets userId from the token on the update path — never from the request body", async () => {
    prismaMock.gymExerciseInstance.findFirst.mockResolvedValue(instanceFixture);
    prismaMock.gymExerciseInstance.update.mockResolvedValue(instanceFixture);

    await auth
      .put(`/v1/gym-exercise-instances/${INSTANCE_ID}`)
      .send({ ...validInstanceBody, userId: "hacker-injected-user" });

    const [updateArgs] = prismaMock.gymExerciseInstance.update.mock.calls[0];
    expect(updateArgs.data.userId).toBe(TEST_USER_ID);
  });

  it("returns 400 on an invalid body (missing required fields)", async () => {
    const res = await auth
      .put(`/v1/gym-exercise-instances/${INSTANCE_ID}`)
      .send({ isActive: true }); // missing gymProfileId, canonicalExerciseId, weightUnit, weightMode

    expect(res.status).toBe(400);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when weightUnit is an invalid enum value", async () => {
    const res = await auth
      .put(`/v1/gym-exercise-instances/${INSTANCE_ID}`)
      .send({ ...validInstanceBody, weightUnit: "stones" });

    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /:id — hard delete with IDOR guard
// ─────────────────────────────────────────────────────────────────────────────

describe("DELETE /v1/gym-exercise-instances/:id", () => {
  it("returns 200 and { deleted: true } when the record exists and is owned", async () => {
    prismaMock.gymExerciseInstance.findFirst.mockResolvedValue(instanceFixture);
    prismaMock.gymExerciseInstance.delete.mockResolvedValue(instanceFixture);

    const res = await auth.delete(`/v1/gym-exercise-instances/${INSTANCE_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.deleted).toBe(true);
  });

  it("IDOR guard — findFirst scopes the ownership check to the authenticated user", async () => {
    prismaMock.gymExerciseInstance.findFirst.mockResolvedValue(instanceFixture);
    prismaMock.gymExerciseInstance.delete.mockResolvedValue(instanceFixture);

    await auth.delete(`/v1/gym-exercise-instances/${INSTANCE_ID}`);

    const [findFirstArgs] = prismaMock.gymExerciseInstance.findFirst.mock.calls[0];
    expect(findFirstArgs.where).toMatchObject({
      id: INSTANCE_ID,
      userId: TEST_USER_ID,
    });
  });

  it("returns 404 and does NOT call delete when the record is absent", async () => {
    prismaMock.gymExerciseInstance.findFirst.mockResolvedValue(null);

    const res = await auth.delete(`/v1/gym-exercise-instances/${INSTANCE_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.err.code).toBe("NOT_FOUND");
    expect(prismaMock.gymExerciseInstance.delete).not.toHaveBeenCalled();
  });

  it("does NOT expose a PATCH route (hard-delete resources use DELETE only)", async () => {
    const res = await auth.patch(`/v1/gym-exercise-instances/${INSTANCE_ID}`);
    // Express returns 404 for unmatched routes
    expect(res.status).toBe(404);
  });
});
