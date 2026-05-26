/**
 * Tests for GET/PUT/DELETE /v1/exercise-aliases
 *
 * Resource characteristics:
 *   - Produced by createCrudRouter() factory with deleteStyle: "hard"
 *   - Client-generated deterministic UUIDs; PUT uses ownership-checked two-step:
 *       1. findFirst({ where: { id, userId } }) — IDOR ownership check
 *       2a. update → 200 if owned row found
 *       2b. create → 201 if no owned row exists (idempotent: same alias → same id)
 *   - Hard delete: DELETE /:id
 *   - Optional ?canonicalExerciseId and ?normalizedAlias filters on GET /
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

const ALIAS_ID = "alias-deterministic-uuid-001";
const CANONICAL_EXERCISE_ID = "canonical-exercise-bench-press";
const NORMALIZED_ALIAS = "bench press";

const aliasFixture = {
  id: ALIAS_ID,
  userId: TEST_USER_ID,
  alias: "Bench Press",
  normalizedAlias: NORMALIZED_ALIAS,
  canonicalExerciseId: CANONICAL_EXERCISE_ID,
  equipmentType: "barbell" as const,
  gymProfileId: null,
  source: "manual" as const,
  createdAt: new Date("2025-01-01T00:00:00Z"),
  updatedAt: new Date("2025-01-01T00:00:00Z"),
};

const validAliasBody = {
  alias: "Bench Press",
  normalizedAlias: NORMALIZED_ALIAS,
  canonicalExerciseId: CANONICAL_EXERCISE_ID,
  equipmentType: "barbell",
  source: "manual",
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

describe("exercise-aliases — authentication", () => {
  it("GET / returns 401 when unauthenticated", async () => {
    const res = await anon.get("/v1/exercise-aliases");
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it("GET /:id returns 401 when unauthenticated", async () => {
    const res = await anon.get(`/v1/exercise-aliases/${ALIAS_ID}`);
    expect(res.status).toBe(401);
  });

  it("PUT /:id returns 401 when unauthenticated", async () => {
    const res = await anon
      .put(`/v1/exercise-aliases/${ALIAS_ID}`)
      .send(validAliasBody);
    expect(res.status).toBe(401);
  });

  it("DELETE /:id returns 401 when unauthenticated", async () => {
    const res = await anon.delete(`/v1/exercise-aliases/${ALIAS_ID}`);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET / — list
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/exercise-aliases", () => {
  it("returns 200 and scopes the query to the authenticated user", async () => {
    prismaMock.exerciseAlias.findMany.mockResolvedValue([aliasFixture]);

    const res = await auth.get("/v1/exercise-aliases");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].id).toBe(ALIAS_ID);

    const [args] = prismaMock.exerciseAlias.findMany.mock.calls[0];
    expect(args.where).toMatchObject({ userId: TEST_USER_ID });
  });

  it("applies the ?canonicalExerciseId filter to the where clause", async () => {
    prismaMock.exerciseAlias.findMany.mockResolvedValue([]);

    await auth.get(`/v1/exercise-aliases?canonicalExerciseId=${CANONICAL_EXERCISE_ID}`);

    const [args] = prismaMock.exerciseAlias.findMany.mock.calls[0];
    expect(args.where).toMatchObject({
      userId: TEST_USER_ID,
      canonicalExerciseId: CANONICAL_EXERCISE_ID,
    });
  });

  it("applies the ?normalizedAlias filter to the where clause", async () => {
    prismaMock.exerciseAlias.findMany.mockResolvedValue([]);

    await auth.get(
      `/v1/exercise-aliases?normalizedAlias=${encodeURIComponent(NORMALIZED_ALIAS)}`
    );

    const [args] = prismaMock.exerciseAlias.findMany.mock.calls[0];
    expect(args.where).toMatchObject({
      userId: TEST_USER_ID,
      normalizedAlias: NORMALIZED_ALIAS,
    });
  });

  it("applies both ?canonicalExerciseId and ?normalizedAlias filters together", async () => {
    prismaMock.exerciseAlias.findMany.mockResolvedValue([]);

    await auth.get(
      `/v1/exercise-aliases?canonicalExerciseId=${CANONICAL_EXERCISE_ID}&normalizedAlias=${encodeURIComponent(NORMALIZED_ALIAS)}`
    );

    const [args] = prismaMock.exerciseAlias.findMany.mock.calls[0];
    expect(args.where).toMatchObject({
      userId: TEST_USER_ID,
      canonicalExerciseId: CANONICAL_EXERCISE_ID,
      normalizedAlias: NORMALIZED_ALIAS,
    });
  });

  it("returns 400 when ?canonicalExerciseId is present but invalid (empty string)", async () => {
    // Empty string fails idSchema.min(1) — route must 400 not silently drop the filter.
    const res = await auth.get("/v1/exercise-aliases?canonicalExerciseId=");

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when ?normalizedAlias is present but invalid (empty string)", async () => {
    // Empty string fails z.string().min(1) — route must 400 not silently drop.
    const res = await auth.get("/v1/exercise-aliases?normalizedAlias=");

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });

  it("returns an empty items array when there are no matching aliases", async () => {
    prismaMock.exerciseAlias.findMany.mockResolvedValue([]);

    const res = await auth.get("/v1/exercise-aliases");

    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:id — single resource
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/exercise-aliases/:id", () => {
  it("returns 200 and the alias when found", async () => {
    prismaMock.exerciseAlias.findFirst.mockResolvedValue(aliasFixture);

    const res = await auth.get(`/v1/exercise-aliases/${ALIAS_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.id).toBe(ALIAS_ID);
  });

  it("scopes the findFirst query to the authenticated user", async () => {
    prismaMock.exerciseAlias.findFirst.mockResolvedValue(aliasFixture);

    await auth.get(`/v1/exercise-aliases/${ALIAS_ID}`);

    const [args] = prismaMock.exerciseAlias.findFirst.mock.calls[0];
    expect(args.where).toMatchObject({ id: ALIAS_ID, userId: TEST_USER_ID });
  });

  it("returns 404 when the alias does not exist", async () => {
    prismaMock.exerciseAlias.findFirst.mockResolvedValue(null);

    const res = await auth.get(`/v1/exercise-aliases/${ALIAS_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.err.code).toBe("NOT_FOUND");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /:id — idempotent upsert with IDOR two-step
//
// The id is a client-supplied deterministic composite (alias+canonicalExerciseId),
// so the same alias text will always route to the same id — idempotent upsert.
// ─────────────────────────────────────────────────────────────────────────────

describe("PUT /v1/exercise-aliases/:id", () => {
  it("returns 201 and the created alias on the CREATE path (no owned row found)", async () => {
    prismaMock.exerciseAlias.findFirst.mockResolvedValue(null);
    prismaMock.exerciseAlias.create.mockResolvedValue(aliasFixture);

    const res = await auth
      .put(`/v1/exercise-aliases/${ALIAS_ID}`)
      .send(validAliasBody);

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(prismaMock.exerciseAlias.create).toHaveBeenCalledOnce();
    expect(prismaMock.exerciseAlias.update).not.toHaveBeenCalled();
  });

  it("returns 200 and the updated alias on the UPDATE path (owned row exists)", async () => {
    prismaMock.exerciseAlias.findFirst.mockResolvedValue(aliasFixture);
    prismaMock.exerciseAlias.update.mockResolvedValue({
      ...aliasFixture,
      source: "ai_match",
    });

    const res = await auth
      .put(`/v1/exercise-aliases/${ALIAS_ID}`)
      .send({ ...validAliasBody, source: "ai_match" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(prismaMock.exerciseAlias.update).toHaveBeenCalledOnce();
    expect(prismaMock.exerciseAlias.create).not.toHaveBeenCalled();
  });

  it("IDOR two-step — findFirst scopes ownership check to { id, userId }", async () => {
    // A foreign-owned row returns null from findFirst scoped to this user,
    // so the factory falls through to create — never calls update on foreign row.
    prismaMock.exerciseAlias.findFirst.mockResolvedValue(null);
    prismaMock.exerciseAlias.create.mockResolvedValue(aliasFixture);

    await auth
      .put(`/v1/exercise-aliases/${ALIAS_ID}`)
      .send(validAliasBody);

    const [findFirstArgs] = prismaMock.exerciseAlias.findFirst.mock.calls[0];
    expect(findFirstArgs.where).toMatchObject({
      id: ALIAS_ID,
      userId: TEST_USER_ID,
    });
    expect(prismaMock.exerciseAlias.update).not.toHaveBeenCalled();
  });

  it("sets userId from the token on the create path — never from the request body", async () => {
    prismaMock.exerciseAlias.findFirst.mockResolvedValue(null);
    prismaMock.exerciseAlias.create.mockResolvedValue(aliasFixture);

    await auth
      .put(`/v1/exercise-aliases/${ALIAS_ID}`)
      .send({ ...validAliasBody, userId: "hacker-injected-user" });

    const [createArgs] = prismaMock.exerciseAlias.create.mock.calls[0];
    expect(createArgs.data.userId).toBe(TEST_USER_ID);
  });

  it("sets userId from the token on the update path — never from the request body", async () => {
    prismaMock.exerciseAlias.findFirst.mockResolvedValue(aliasFixture);
    prismaMock.exerciseAlias.update.mockResolvedValue(aliasFixture);

    await auth
      .put(`/v1/exercise-aliases/${ALIAS_ID}`)
      .send({ ...validAliasBody, userId: "hacker-injected-user" });

    const [updateArgs] = prismaMock.exerciseAlias.update.mock.calls[0];
    expect(updateArgs.data.userId).toBe(TEST_USER_ID);
  });

  it("returns 400 on an invalid body (missing required fields)", async () => {
    const res = await auth
      .put(`/v1/exercise-aliases/${ALIAS_ID}`)
      .send({ alias: "Bench Press" }); // missing normalizedAlias, canonicalExerciseId, source

    expect(res.status).toBe(400);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when source is an invalid enum value", async () => {
    const res = await auth
      .put(`/v1/exercise-aliases/${ALIAS_ID}`)
      .send({ ...validAliasBody, source: "unknown_source" });

    expect(res.status).toBe(400);
  });

  it("returns 400 when alias is empty string", async () => {
    const res = await auth
      .put(`/v1/exercise-aliases/${ALIAS_ID}`)
      .send({ ...validAliasBody, alias: "" });

    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /:id — hard delete with IDOR guard
// ─────────────────────────────────────────────────────────────────────────────

describe("DELETE /v1/exercise-aliases/:id", () => {
  it("returns 200 and { deleted: true } when the record exists and is owned", async () => {
    prismaMock.exerciseAlias.findFirst.mockResolvedValue(aliasFixture);
    prismaMock.exerciseAlias.delete.mockResolvedValue(aliasFixture);

    const res = await auth.delete(`/v1/exercise-aliases/${ALIAS_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.deleted).toBe(true);
  });

  it("IDOR guard — findFirst scopes the ownership check to the authenticated user", async () => {
    prismaMock.exerciseAlias.findFirst.mockResolvedValue(aliasFixture);
    prismaMock.exerciseAlias.delete.mockResolvedValue(aliasFixture);

    await auth.delete(`/v1/exercise-aliases/${ALIAS_ID}`);

    const [findFirstArgs] = prismaMock.exerciseAlias.findFirst.mock.calls[0];
    expect(findFirstArgs.where).toMatchObject({
      id: ALIAS_ID,
      userId: TEST_USER_ID,
    });
  });

  it("returns 404 and does NOT call delete when the record is absent", async () => {
    prismaMock.exerciseAlias.findFirst.mockResolvedValue(null);

    const res = await auth.delete(`/v1/exercise-aliases/${ALIAS_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.err.code).toBe("NOT_FOUND");
    expect(prismaMock.exerciseAlias.delete).not.toHaveBeenCalled();
  });

  it("does NOT expose a PATCH route (hard-delete resources use DELETE only)", async () => {
    const res = await auth.patch(`/v1/exercise-aliases/${ALIAS_ID}`);
    expect(res.status).toBe(404);
  });
});
