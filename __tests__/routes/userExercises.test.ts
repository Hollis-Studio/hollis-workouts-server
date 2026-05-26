/**
 * Tests for GET/PUT/PATCH /v1/user-exercises
 *
 * Resource characteristics:
 *   - Produced by createCrudRouter() factory with deleteStyle: "soft"
 *   - Client-generated UUIDs; PUT uses ownership-checked two-step:
 *       1. findFirst({ where: { id, userId } }) — IDOR ownership check
 *       2a. update (200) if owned row found
 *       2b. create (201) if no owned row exists
 *   - Soft delete: PATCH /:id sets isActive: false (no real DELETE route)
 *   - Optional ?isActive filter on GET /
 *   - Body schema does NOT accept `id` — sending body.id != URL id must not
 *     change the persisted id (factory uses the URL id exclusively)
 *
 * Test coverage:
 *   - 401 for all verbs when unauthenticated
 *   - GET /  — user-scoping (findMany called with userId), ?isActive filter
 *   - GET /:id — 200 when found; 404 when absent; user-scoping via findFirst
 *   - PUT /:id — 201 on create path; 200 on update path; IDOR safety; body.id ignored
 *   - PATCH /:id (soft delete) — 200 when found; 404 when absent; ownership-checked
 *   - DELETE /:id — 404 (no hard-delete route on soft-delete resources)
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

const UE_ID = "user-exercise-uuid-001";

const userExerciseFixture = {
  id: UE_ID,
  userId: TEST_USER_ID,
  name: "Bulgarian Split Squat",
  description: "Single-leg squat with rear foot elevated",
  category: "weightlifting",
  subcategory: "isolation",
  primaryMuscleGroups: ["quadriceps"],
  secondaryMuscleGroups: ["glutes", "hamstrings"],
  equipmentType: "barbell",
  requiredEquipment: [],
  isBodyweight: false,
  isUnilateral: true,
  defaultRestTimerSec: 90,
  defaultWeightMode: "absolute",
  illustrationUrl: "",
  metadata: {},
  minimumIncrementKg: 2.5,
  source: "user_created",
  trackingMode: "reps",
  isActive: true,
  createdAt: new Date("2025-01-01T00:00:00Z"),
  updatedAt: new Date("2025-01-01T00:00:00Z"),
};

/** Valid PUT body — no id field (the schema does not accept it) */
const validUEBody = {
  name: "Bulgarian Split Squat",
  description: "Single-leg squat with rear foot elevated",
  category: "weightlifting",
  subcategory: "isolation",
  primaryMuscleGroups: ["quadriceps"],
  secondaryMuscleGroups: ["glutes", "hamstrings"],
  equipmentType: "barbell",
  requiredEquipment: [],
  isBodyweight: false,
  isUnilateral: true,
  defaultRestTimerSec: 90,
  defaultWeightMode: "absolute",
  illustrationUrl: "",
  metadata: {},
  minimumIncrementKg: 2.5,
  source: "user_created",
  trackingMode: "reps",
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

describe("user-exercises — authentication", () => {
  it("GET / returns 401 when unauthenticated", async () => {
    const res = await anon.get("/v1/user-exercises");
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it("GET /:id returns 401 when unauthenticated", async () => {
    const res = await anon.get(`/v1/user-exercises/${UE_ID}`);
    expect(res.status).toBe(401);
  });

  it("PUT /:id returns 401 when unauthenticated", async () => {
    const res = await anon.put(`/v1/user-exercises/${UE_ID}`).send(validUEBody);
    expect(res.status).toBe(401);
  });

  it("PATCH /:id returns 401 when unauthenticated", async () => {
    const res = await anon.patch(`/v1/user-exercises/${UE_ID}`);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET / — list
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/user-exercises", () => {
  it("returns 200 and scopes the query to the authenticated user", async () => {
    prismaMock.userExercise.findMany.mockResolvedValue([userExerciseFixture]);

    const res = await auth.get("/v1/user-exercises");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].id).toBe(UE_ID);

    const [findManyArgs] = prismaMock.userExercise.findMany.mock.calls[0];
    expect(findManyArgs.where).toMatchObject({ userId: TEST_USER_ID });
  });

  it("applies the ?isActive=true filter", async () => {
    prismaMock.userExercise.findMany.mockResolvedValue([userExerciseFixture]);

    await auth.get("/v1/user-exercises?isActive=true");

    const [findManyArgs] = prismaMock.userExercise.findMany.mock.calls[0];
    expect(findManyArgs.where).toMatchObject({ userId: TEST_USER_ID, isActive: true });
  });

  it("applies the ?isActive=false filter (returns soft-deleted records)", async () => {
    prismaMock.userExercise.findMany.mockResolvedValue([]);

    await auth.get("/v1/user-exercises?isActive=false");

    const [findManyArgs] = prismaMock.userExercise.findMany.mock.calls[0];
    expect(findManyArgs.where).toMatchObject({ userId: TEST_USER_ID, isActive: false });
  });

  it("omits isActive filter when ?isActive param is absent (returns all records)", async () => {
    prismaMock.userExercise.findMany.mockResolvedValue([]);

    await auth.get("/v1/user-exercises");

    const [findManyArgs] = prismaMock.userExercise.findMany.mock.calls[0];
    // where must NOT contain an isActive key when param is absent
    expect(findManyArgs.where).not.toHaveProperty("isActive");
  });

  it("returns empty items array when user has no exercises", async () => {
    prismaMock.userExercise.findMany.mockResolvedValue([]);

    const res = await auth.get("/v1/user-exercises");
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:id — single resource
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/user-exercises/:id", () => {
  it("returns 200 and the exercise when found", async () => {
    prismaMock.userExercise.findFirst.mockResolvedValue(userExerciseFixture);

    const res = await auth.get(`/v1/user-exercises/${UE_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.id).toBe(UE_ID);
  });

  it("scopes the findFirst query to { id, userId }", async () => {
    prismaMock.userExercise.findFirst.mockResolvedValue(userExerciseFixture);

    await auth.get(`/v1/user-exercises/${UE_ID}`);

    const [findFirstArgs] = prismaMock.userExercise.findFirst.mock.calls[0];
    expect(findFirstArgs.where).toMatchObject({ id: UE_ID, userId: TEST_USER_ID });
  });

  it("returns 404 when the exercise does not exist (or belongs to another user)", async () => {
    prismaMock.userExercise.findFirst.mockResolvedValue(null);

    const res = await auth.get(`/v1/user-exercises/${UE_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.err.code).toBe("NOT_FOUND");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /:id — idempotent upsert
// ─────────────────────────────────────────────────────────────────────────────

describe("PUT /v1/user-exercises/:id", () => {
  it("returns 201 and the created exercise on the CREATE path (no owned row found)", async () => {
    prismaMock.userExercise.findFirst.mockResolvedValue(null);
    prismaMock.userExercise.create.mockResolvedValue(userExerciseFixture);

    const res = await auth.put(`/v1/user-exercises/${UE_ID}`).send(validUEBody);

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.id).toBe(UE_ID);
    expect(prismaMock.userExercise.create).toHaveBeenCalledOnce();
    expect(prismaMock.userExercise.update).not.toHaveBeenCalled();
  });

  it("returns 200 and the updated exercise on the UPDATE path (owned row already exists)", async () => {
    prismaMock.userExercise.findFirst.mockResolvedValue(userExerciseFixture);
    prismaMock.userExercise.update.mockResolvedValue({
      ...userExerciseFixture,
      name: "Renamed Exercise",
    });

    const res = await auth
      .put(`/v1/user-exercises/${UE_ID}`)
      .send({ ...validUEBody, name: "Renamed Exercise" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.name).toBe("Renamed Exercise");
    expect(prismaMock.userExercise.update).toHaveBeenCalledOnce();
    expect(prismaMock.userExercise.create).not.toHaveBeenCalled();
  });

  it("IDOR safety — ownership check uses { id, userId } so another user's row is never overwritten", async () => {
    prismaMock.userExercise.findFirst.mockResolvedValue(null);
    prismaMock.userExercise.create.mockResolvedValue(userExerciseFixture);

    await auth.put(`/v1/user-exercises/${UE_ID}`).send(validUEBody);

    const [findFirstArgs] = prismaMock.userExercise.findFirst.mock.calls[0];
    expect(findFirstArgs.where).toMatchObject({ id: UE_ID, userId: TEST_USER_ID });
    // Must not call update — we never update a row we don't own
    expect(prismaMock.userExercise.update).not.toHaveBeenCalled();
  });

  it("sets userId from the token on the create path, never from the request body", async () => {
    prismaMock.userExercise.findFirst.mockResolvedValue(null);
    prismaMock.userExercise.create.mockResolvedValue(userExerciseFixture);

    await auth
      .put(`/v1/user-exercises/${UE_ID}`)
      .send({ ...validUEBody, userId: "hacker-injected-user" });

    const [createArgs] = prismaMock.userExercise.create.mock.calls[0];
    expect(createArgs.data.userId).toBe(TEST_USER_ID);
  });

  it("uses the URL :id on the create path, not any id field sent in the body", async () => {
    prismaMock.userExercise.findFirst.mockResolvedValue(null);
    prismaMock.userExercise.create.mockResolvedValue(userExerciseFixture);

    // Send a body.id that differs from the URL id
    const bodyWithDifferentId = { ...validUEBody, id: "body-injected-id" };
    await auth.put(`/v1/user-exercises/${UE_ID}`).send(bodyWithDifferentId);

    const [createArgs] = prismaMock.userExercise.create.mock.calls[0];
    // The persisted id must be the URL param, not body.id
    expect(createArgs.data.id).toBe(UE_ID);
    expect(createArgs.data.id).not.toBe("body-injected-id");
  });

  it("body.id different from URL id does NOT appear in the update data", async () => {
    prismaMock.userExercise.findFirst.mockResolvedValue(userExerciseFixture);
    prismaMock.userExercise.update.mockResolvedValue(userExerciseFixture);

    // Send a body.id that differs from the URL id
    await auth
      .put(`/v1/user-exercises/${UE_ID}`)
      .send({ ...validUEBody, id: "body-injected-id" });

    const [updateArgs] = prismaMock.userExercise.update.mock.calls[0];
    // The where clause must use the URL id
    expect(updateArgs.where.id).toBe(UE_ID);
    // The data must NOT contain a different id
    if ("id" in updateArgs.data) {
      expect(updateArgs.data.id).toBe(UE_ID);
    }
  });

  it("returns 400 on an invalid body (missing required fields)", async () => {
    const res = await auth.put(`/v1/user-exercises/${UE_ID}`).send({ name: "" });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /:id — soft delete (sets isActive: false)
// ─────────────────────────────────────────────────────────────────────────────

describe("PATCH /v1/user-exercises/:id (soft delete)", () => {
  it("returns 200 with the updated exercise when found", async () => {
    prismaMock.userExercise.findFirst.mockResolvedValue(userExerciseFixture);
    prismaMock.userExercise.update.mockResolvedValue({
      ...userExerciseFixture,
      isActive: false,
    });

    const res = await auth.patch(`/v1/user-exercises/${UE_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.isActive).toBe(false);
  });

  it("sets isActive: false in the update data", async () => {
    prismaMock.userExercise.findFirst.mockResolvedValue(userExerciseFixture);
    prismaMock.userExercise.update.mockResolvedValue({
      ...userExerciseFixture,
      isActive: false,
    });

    await auth.patch(`/v1/user-exercises/${UE_ID}`);

    const [updateArgs] = prismaMock.userExercise.update.mock.calls[0];
    expect(updateArgs.data).toMatchObject({ isActive: false });
  });

  it("performs an IDOR check — scopes findFirst to { id, userId }", async () => {
    prismaMock.userExercise.findFirst.mockResolvedValue(userExerciseFixture);
    prismaMock.userExercise.update.mockResolvedValue({
      ...userExerciseFixture,
      isActive: false,
    });

    await auth.patch(`/v1/user-exercises/${UE_ID}`);

    const [findFirstArgs] = prismaMock.userExercise.findFirst.mock.calls[0];
    expect(findFirstArgs.where).toMatchObject({ id: UE_ID, userId: TEST_USER_ID });
  });

  it("returns 404 and does NOT call update when the exercise is absent", async () => {
    prismaMock.userExercise.findFirst.mockResolvedValue(null);

    const res = await auth.patch(`/v1/user-exercises/${UE_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.err.code).toBe("NOT_FOUND");
    expect(prismaMock.userExercise.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /:id — must not exist (soft-delete resources use PATCH only)
// ─────────────────────────────────────────────────────────────────────────────

describe("DELETE /v1/user-exercises/:id (no hard-delete route)", () => {
  it("returns 404 — there is no DELETE route for soft-delete resources", async () => {
    const res = await auth.delete(`/v1/user-exercises/${UE_ID}`);
    expect(res.status).toBe(404);
  });
});
