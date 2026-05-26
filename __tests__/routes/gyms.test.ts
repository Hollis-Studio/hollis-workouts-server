/**
 * Exemplar tests for GET/PUT/PATCH /v1/gyms
 *
 * Resource characteristics:
 *   - Produced by createCrudRouter() factory with deleteStyle: "soft"
 *   - Client-generated UUIDs; PUT uses ownership-checked two-step:
 *       1. findFirst({ where: { id, userId } }) — IDOR ownership check
 *       2a. update (200) if owned row found
 *       2b. create (201) if no owned row exists
 *   - Soft delete: PATCH /:id sets isActive: false (no real DELETE route)
 *   - Optional ?isActive filter on GET /
 *
 * Test coverage:
 *   - 401 for all verbs when unauthenticated
 *   - GET /  — user-scoping (findMany called with userId), pagination
 *   - GET /:id — 200 when found; 404 when absent; user-scoping via findFirst
 *   - PUT /:id — 201 on create path; 200 on update path; IDOR safety; 400 on invalid body
 *   - PATCH /:id (soft delete) — 200 when found; 404 when absent
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
  PrismaKnownErrorMock,
} from "../helpers/setup.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const GYM_ID = "gym-uuid-001";

const gymFixture = {
  id: GYM_ID,
  userId: TEST_USER_ID,
  name: "Iron Temple",
  location: null,
  equipmentTypes: ["barbell"],
  equipmentIds: ["eq-1"],
  equipmentItems: [],
  exerciseSelectionMode: "equipment_based",
  isActive: true,
  createdAt: new Date("2025-01-01T00:00:00Z"),
  updatedAt: new Date("2025-01-01T00:00:00Z"),
};

const validGymBody = {
  name: "Iron Temple",
  equipmentTypes: ["barbell"],
  equipmentIds: ["eq-1"],
  equipmentItems: [],
  exerciseSelectionMode: "equipment_based",
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

describe("gyms — authentication", () => {
  it("GET / returns 401 when unauthenticated", async () => {
    const res = await anon.get("/v1/gyms");
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it("GET /:id returns 401 when unauthenticated", async () => {
    const res = await anon.get(`/v1/gyms/${GYM_ID}`);
    expect(res.status).toBe(401);
  });

  it("PUT /:id returns 401 when unauthenticated", async () => {
    const res = await anon.put(`/v1/gyms/${GYM_ID}`).send(validGymBody);
    expect(res.status).toBe(401);
  });

  it("PATCH /:id returns 401 when unauthenticated", async () => {
    const res = await anon.patch(`/v1/gyms/${GYM_ID}`);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET / — list
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/gyms", () => {
  it("returns 200 and scopes the query to the authenticated user", async () => {
    prismaMock.gym.findMany.mockResolvedValue([gymFixture]);

    const res = await auth.get("/v1/gyms");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].id).toBe(GYM_ID);

    // User-scoping assertion: findMany must be called with userId
    const [findManyArgs] = prismaMock.gym.findMany.mock.calls[0];
    expect(findManyArgs.where).toMatchObject({ userId: TEST_USER_ID });
  });

  it("applies the ?isActive filter from query string", async () => {
    prismaMock.gym.findMany.mockResolvedValue([]);

    await auth.get("/v1/gyms?isActive=false");

    const [findManyArgs] = prismaMock.gym.findMany.mock.calls[0];
    expect(findManyArgs.where).toMatchObject({ userId: TEST_USER_ID, isActive: false });
  });

  it("returns empty items array when user has no gyms", async () => {
    prismaMock.gym.findMany.mockResolvedValue([]);

    const res = await auth.get("/v1/gyms");
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:id — single resource
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/gyms/:id", () => {
  it("returns 200 and the gym when found", async () => {
    prismaMock.gym.findFirst.mockResolvedValue(gymFixture);

    const res = await auth.get(`/v1/gyms/${GYM_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.id).toBe(GYM_ID);
  });

  it("scopes the findFirst query to the authenticated user", async () => {
    prismaMock.gym.findFirst.mockResolvedValue(gymFixture);

    await auth.get(`/v1/gyms/${GYM_ID}`);

    const [findFirstArgs] = prismaMock.gym.findFirst.mock.calls[0];
    expect(findFirstArgs.where).toMatchObject({ id: GYM_ID, userId: TEST_USER_ID });
  });

  it("returns 404 when the gym does not exist", async () => {
    prismaMock.gym.findFirst.mockResolvedValue(null);

    const res = await auth.get(`/v1/gyms/${GYM_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.err.code).toBe("NOT_FOUND");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /:id — idempotent upsert
// ─────────────────────────────────────────────────────────────────────────────

describe("PUT /v1/gyms/:id", () => {
  it("returns 201 and the created gym on the CREATE path (no owned row found)", async () => {
    // Two-step: findFirst returns null (no existing owned row) → create → 201
    prismaMock.gym.findFirst.mockResolvedValue(null);
    prismaMock.gym.create.mockResolvedValue({ ...gymFixture, ...validGymBody });

    const res = await auth.put(`/v1/gyms/${GYM_ID}`).send(validGymBody);

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.name).toBe("Iron Temple");
    expect(prismaMock.gym.create).toHaveBeenCalledOnce();
    expect(prismaMock.gym.update).not.toHaveBeenCalled();
  });

  it("returns 200 and the updated gym on the UPDATE path (owned row already exists)", async () => {
    // Two-step: findFirst returns the existing gym (owned) → update → 200
    prismaMock.gym.findFirst.mockResolvedValue(gymFixture);
    prismaMock.gym.update.mockResolvedValue({ ...gymFixture, name: "Renamed Temple" });

    const res = await auth.put(`/v1/gyms/${GYM_ID}`).send({ ...validGymBody, name: "Renamed Temple" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.name).toBe("Renamed Temple");
    expect(prismaMock.gym.update).toHaveBeenCalledOnce();
    expect(prismaMock.gym.create).not.toHaveBeenCalled();
  });

  it("IDOR safety — ownership check uses { id, userId } so another user's row is never overwritten", async () => {
    // findFirst scoped to (id, userId) returns null for a foreign-owned row →
    // the factory falls through to create, which will hit a DB unique-key conflict
    // (the constraint rejects the duplicate PK); the factory does NOT call update.
    prismaMock.gym.findFirst.mockResolvedValue(null);
    prismaMock.gym.create.mockResolvedValue(gymFixture);

    await auth.put(`/v1/gyms/${GYM_ID}`).send(validGymBody);

    // findFirst must carry both id AND userId to scope the ownership check
    const [findFirstArgs] = prismaMock.gym.findFirst.mock.calls[0];
    expect(findFirstArgs.where).toMatchObject({ id: GYM_ID, userId: TEST_USER_ID });
    // update must NOT have been called — we never update a row we don't own
    expect(prismaMock.gym.update).not.toHaveBeenCalled();
  });

  it("sets userId from the token on the create path, never from the request body", async () => {
    prismaMock.gym.findFirst.mockResolvedValue(null);
    prismaMock.gym.create.mockResolvedValue(gymFixture);

    await auth
      .put(`/v1/gyms/${GYM_ID}`)
      .send({ ...validGymBody, userId: "hacker-injected-user" });

    const [createArgs] = prismaMock.gym.create.mock.calls[0];
    // Data written to DB must carry the token userId, not the body userId
    expect(createArgs.data.userId).toBe(TEST_USER_ID);
  });

  it("sets userId from the token on the update path, never from the request body", async () => {
    prismaMock.gym.findFirst.mockResolvedValue(gymFixture);
    prismaMock.gym.update.mockResolvedValue(gymFixture);

    await auth
      .put(`/v1/gyms/${GYM_ID}`)
      .send({ ...validGymBody, userId: "hacker-injected-user" });

    const [updateArgs] = prismaMock.gym.update.mock.calls[0];
    // Both the where clause AND the data must carry the token userId
    expect(updateArgs.where.userId).toBe(TEST_USER_ID);
    expect(updateArgs.data.userId).toBe(TEST_USER_ID);
  });

  it("returns 400 on an invalid body (missing required fields)", async () => {
    const res = await auth.put(`/v1/gyms/${GYM_ID}`).send({ name: "" });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when equipmentItems contains an invalid item", async () => {
    const bodyWithBadItem = {
      ...validGymBody,
      equipmentItems: [{ id: "item-1", count: -1 }], // count must be positive
    };

    const res = await auth.put(`/v1/gyms/${GYM_ID}`).send(bodyWithBadItem);

    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /:id — soft delete (sets isActive: false)
// ─────────────────────────────────────────────────────────────────────────────

describe("PATCH /v1/gyms/:id (soft delete)", () => {
  it("returns 200 with the updated gym when found", async () => {
    prismaMock.gym.findFirst.mockResolvedValue(gymFixture);
    prismaMock.gym.update.mockResolvedValue({ ...gymFixture, isActive: false });

    const res = await auth.patch(`/v1/gyms/${GYM_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.isActive).toBe(false);
  });

  it("performs an IDOR check — scopes findFirst to the authenticated user", async () => {
    prismaMock.gym.findFirst.mockResolvedValue(gymFixture);
    prismaMock.gym.update.mockResolvedValue({ ...gymFixture, isActive: false });

    await auth.patch(`/v1/gyms/${GYM_ID}`);

    const [findFirstArgs] = prismaMock.gym.findFirst.mock.calls[0];
    expect(findFirstArgs.where).toMatchObject({ id: GYM_ID, userId: TEST_USER_ID });
  });

  it("returns 404 and does NOT call update when the gym is absent", async () => {
    prismaMock.gym.findFirst.mockResolvedValue(null);

    const res = await auth.patch(`/v1/gyms/${GYM_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.err.code).toBe("NOT_FOUND");
    expect(prismaMock.gym.update).not.toHaveBeenCalled();
  });

  it("does NOT expose a DELETE route (soft-delete resources use PATCH only)", async () => {
    const res = await auth.delete(`/v1/gyms/${GYM_ID}`);
    // Express 5 returns 404 for unmatched routes
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Prisma known-error mapping (exercised through the shared error handler).
// These are the offline-first sync edge cases that previously fell through to
// an opaque 500.
// ─────────────────────────────────────────────────────────────────────────────

describe("Prisma error mapping", () => {
  it("maps P2002 (unique-constraint race on create) to 409 CONFLICT", async () => {
    prismaMock.gym.findFirst.mockResolvedValue(null); // existence pre-check passes
    prismaMock.gym.create.mockRejectedValue(
      new PrismaKnownErrorMock("Unique constraint failed", { code: "P2002" }),
    );

    const res = await auth.put(`/v1/gyms/${GYM_ID}`).send(validGymBody);

    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
    expect(res.body.err.code).toBe("CONFLICT");
  });

  it("maps P2025 (stale cursor / record not found) to 404 NOT_FOUND", async () => {
    prismaMock.gym.findMany.mockRejectedValue(
      new PrismaKnownErrorMock("Record to fetch not found", { code: "P2025" }),
    );

    const res = await auth.get("/v1/gyms?cursor=does-not-exist");

    expect(res.status).toBe(404);
    expect(res.body.err.code).toBe("NOT_FOUND");
  });
});
