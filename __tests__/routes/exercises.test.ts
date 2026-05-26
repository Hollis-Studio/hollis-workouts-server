/**
 * Tests for GET / + GET /:id on /v1/exercises
 *
 * Resource characteristics:
 *   - READ-ONLY global catalog — no POST, PUT, DELETE, PATCH routes
 *   - NOT user-scoped: findMany does NOT filter by userId
 *   - Auth is still required (endpoint lives behind requireAuth in apiRouter)
 *   - Supports query filters: ?isActive (default true), ?category, ?equipmentType, ?search
 *     - ?search is case-insensitive name contains
 *     - ?isActive=false overrides the default
 *   - Cursor/limit pagination (default limit=100 per exercises' own schema)
 *   - Cache-Control: private, max-age=3600 set on ALL responses (GET / and GET /:id)
 *   - GET /:id uses findUnique({ where: { id } }) — no userId filter; 404 on null
 *
 * Test coverage:
 *   - 401 when unauthenticated (GET /, GET /:id)
 *   - GET / — NOT user-scoped (no userId in where), isActive default, ?search filter,
 *             ?category, ?equipmentType, pagination take, Cache-Control header
 *   - GET /:id — 200 with exercise, 404 on null, findUnique args, Cache-Control header
 *   - POST /, PUT /:id, DELETE /:id → 404 (read-only catalog)
 */

import { describe, it, expect, beforeAll } from "vitest";
import type { Express } from "express";
import type { SuperTest, Test } from "supertest";
import { prismaMock, buildApp, authedAgent, anonAgent } from "../helpers/setup.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const EXERCISE_ID = "barbell-back-squat";

const exerciseFixture = {
  id: EXERCISE_ID,
  name: "Barbell Back Squat",
  category: "strength",
  equipmentType: "barbell",
  isActive: true,
  primaryMuscles: ["quadriceps", "glutes"],
  secondaryMuscles: ["hamstrings", "core"],
  instructions: null,
  createdAt: new Date("2024-01-01T00:00:00Z"),
  updatedAt: new Date("2024-01-01T00:00:00Z"),
};

const exerciseFixture2 = {
  id: "dumbbell-curl",
  name: "Dumbbell Curl",
  category: "strength",
  equipmentType: "dumbbell",
  isActive: true,
  primaryMuscles: ["biceps"],
  secondaryMuscles: [],
  instructions: null,
  createdAt: new Date("2024-01-01T00:00:00Z"),
  updatedAt: new Date("2024-01-01T00:00:00Z"),
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
// Authentication guard — catalog requires auth even though data is not personal
// ─────────────────────────────────────────────────────────────────────────────

describe("exercises — authentication", () => {
  it("GET / returns 401 when unauthenticated", async () => {
    const res = await anon.get("/v1/exercises");
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it("GET /:id returns 401 when unauthenticated", async () => {
    const res = await anon.get(`/v1/exercises/${EXERCISE_ID}`);
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET / — list catalog
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/exercises", () => {
  it("returns 200 and the catalog items", async () => {
    prismaMock.canonicalExercise.findMany.mockResolvedValue([exerciseFixture]);

    const res = await auth.get("/v1/exercises");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].id).toBe(EXERCISE_ID);
  });

  it("does NOT filter by userId — catalog is global, not user-scoped", async () => {
    prismaMock.canonicalExercise.findMany.mockResolvedValue([exerciseFixture]);

    await auth.get("/v1/exercises");

    const [args] = prismaMock.canonicalExercise.findMany.mock.calls[0];
    expect(args.where).not.toHaveProperty("userId");
  });

  it("defaults ?isActive to true when not provided", async () => {
    prismaMock.canonicalExercise.findMany.mockResolvedValue([]);

    await auth.get("/v1/exercises");

    const [args] = prismaMock.canonicalExercise.findMany.mock.calls[0];
    expect(args.where).toMatchObject({ isActive: true });
  });

  it("applies ?isActive=false filter", async () => {
    prismaMock.canonicalExercise.findMany.mockResolvedValue([]);

    await auth.get("/v1/exercises?isActive=false");

    const [args] = prismaMock.canonicalExercise.findMany.mock.calls[0];
    expect(args.where).toMatchObject({ isActive: false });
  });

  it("applies ?category filter", async () => {
    prismaMock.canonicalExercise.findMany.mockResolvedValue([]);

    await auth.get("/v1/exercises?category=strength");

    const [args] = prismaMock.canonicalExercise.findMany.mock.calls[0];
    expect(args.where).toMatchObject({ category: "strength" });
  });

  it("applies ?equipmentType filter", async () => {
    prismaMock.canonicalExercise.findMany.mockResolvedValue([]);

    await auth.get("/v1/exercises?equipmentType=barbell");

    const [args] = prismaMock.canonicalExercise.findMany.mock.calls[0];
    expect(args.where).toMatchObject({ equipmentType: "barbell" });
  });

  it("applies ?search as case-insensitive name contains", async () => {
    prismaMock.canonicalExercise.findMany.mockResolvedValue([]);

    await auth.get("/v1/exercises?search=squat");

    const [args] = prismaMock.canonicalExercise.findMany.mock.calls[0];
    expect(args.where).toMatchObject({
      name: { contains: "squat", mode: "insensitive" },
    });
  });

  it("uses a bounded take (default limit=100 from exercises query schema)", async () => {
    prismaMock.canonicalExercise.findMany.mockResolvedValue([]);

    await auth.get("/v1/exercises");

    const [args] = prismaMock.canonicalExercise.findMany.mock.calls[0];
    expect(args.take).toBe(100);
  });

  it("sets Cache-Control: private, max-age=3600 on the list response", async () => {
    prismaMock.canonicalExercise.findMany.mockResolvedValue([exerciseFixture]);

    const res = await auth.get("/v1/exercises");

    expect(res.headers["cache-control"]).toBe("private, max-age=3600");
  });

  it("returns empty items array and null nextCursor when catalog has no matches", async () => {
    prismaMock.canonicalExercise.findMany.mockResolvedValue([]);

    const res = await auth.get("/v1/exercises?category=nonexistent");

    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
    expect(res.body.data.nextCursor).toBeNull();
  });

  it("sets nextCursor when items length equals the limit", async () => {
    const manyExercises = Array.from({ length: 100 }, (_, i) => ({
      ...exerciseFixture,
      id: `exercise-${i}`,
      name: `Exercise ${i}`,
    }));
    prismaMock.canonicalExercise.findMany.mockResolvedValue(manyExercises);

    const res = await auth.get("/v1/exercises");

    expect(res.status).toBe(200);
    expect(res.body.data.nextCursor).toBe("exercise-99");
  });

  it("applies multiple filters together (category + isActive + search)", async () => {
    prismaMock.canonicalExercise.findMany.mockResolvedValue([exerciseFixture]);

    await auth.get("/v1/exercises?category=strength&isActive=true&search=squat");

    const [args] = prismaMock.canonicalExercise.findMany.mock.calls[0];
    expect(args.where).toMatchObject({
      isActive: true,
      category: "strength",
      name: { contains: "squat", mode: "insensitive" },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:id — single exercise by catalog slug
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/exercises/:id", () => {
  it("returns 200 and the exercise when found", async () => {
    prismaMock.canonicalExercise.findUnique.mockResolvedValue(exerciseFixture);

    const res = await auth.get(`/v1/exercises/${EXERCISE_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.id).toBe(EXERCISE_ID);
  });

  it("calls findUnique with where: { id } — no userId filter (catalog is global)", async () => {
    prismaMock.canonicalExercise.findUnique.mockResolvedValue(exerciseFixture);

    await auth.get(`/v1/exercises/${EXERCISE_ID}`);

    const [args] = prismaMock.canonicalExercise.findUnique.mock.calls[0];
    expect(args.where).toEqual({ id: EXERCISE_ID });
    expect(args.where).not.toHaveProperty("userId");
  });

  it("returns 404 when the exercise does not exist", async () => {
    prismaMock.canonicalExercise.findUnique.mockResolvedValue(null);

    const res = await auth.get(`/v1/exercises/unknown-exercise`);

    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.err.code).toBe("NOT_FOUND");
  });

  it("sets Cache-Control: private, max-age=3600 on the single-exercise response", async () => {
    prismaMock.canonicalExercise.findUnique.mockResolvedValue(exerciseFixture);

    const res = await auth.get(`/v1/exercises/${EXERCISE_ID}`);

    expect(res.headers["cache-control"]).toBe("private, max-age=3600");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Read-only contract — no mutating routes exist
// ─────────────────────────────────────────────────────────────────────────────

describe("exercises — read-only catalog (no mutating verbs)", () => {
  it("POST /v1/exercises returns 404 (route does not exist)", async () => {
    const res = await auth.post("/v1/exercises").send({ name: "New Exercise" });
    expect(res.status).toBe(404);
  });

  it("PUT /v1/exercises/:id returns 404 (route does not exist)", async () => {
    const res = await auth.put(`/v1/exercises/${EXERCISE_ID}`).send({ name: "Renamed" });
    expect(res.status).toBe(404);
  });

  it("DELETE /v1/exercises/:id returns 404 (route does not exist)", async () => {
    const res = await auth.delete(`/v1/exercises/${EXERCISE_ID}`);
    expect(res.status).toBe(404);
  });
});
