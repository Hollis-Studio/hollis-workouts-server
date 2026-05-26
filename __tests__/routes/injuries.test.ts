/**
 * Tests for GET/PUT/PATCH /v1/injuries
 *
 * Resource characteristics:
 *   - Produced by createCrudRouter() factory with deleteStyle: "soft"
 *   - Client-generated UUIDs; PUT uses ownership-checked two-step (IDOR guard)
 *   - Soft delete: PATCH /:id sets isActive: false
 *   - Filters: ?isActive and ?muscleGroup on GET /
 *   - createdAt is accepted as an ISO string from the client and coerced to a
 *     Date (via z.coerce.date()) before the Prisma write
 *   - client-supplied userId is always ignored (taken from auth token)
 *
 * Test coverage:
 *   - 401 for all verbs when unauthenticated
 *   - GET /  — user-scoping; ?isActive filter; ?muscleGroup filter
 *   - GET /:id — 200 when found; 404 when absent; user-scoping via findFirst
 *   - PUT /:id — 201 on create path; 200 on update path; IDOR safety
 *   - PUT /:id — createdAt ISO string coerced to Date in the mock call args
 *   - PUT /:id — client-injected userId ignored
 *   - PATCH /:id (soft delete) — 200 when found; 404 when absent; ownership-checked
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

const INJURY_ID = "injury-uuid-001";
const CREATED_AT_ISO = "2025-03-15T10:30:00.000Z";

const injuryFixture = {
  id: INJURY_ID,
  userId: TEST_USER_ID,
  muscleGroup: "lower_back",
  description: "Strained during deadlifts",
  createdAt: new Date(CREATED_AT_ISO),
  updatedAt: new Date(CREATED_AT_ISO),
  isActive: true,
};

const validInjuryBody = {
  muscleGroup: "lower_back",
  description: "Strained during deadlifts",
  createdAt: CREATED_AT_ISO,
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

describe("injuries — authentication", () => {
  it("GET / returns 401 when unauthenticated", async () => {
    const res = await anon.get("/v1/injuries");
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it("GET /:id returns 401 when unauthenticated", async () => {
    const res = await anon.get(`/v1/injuries/${INJURY_ID}`);
    expect(res.status).toBe(401);
  });

  it("PUT /:id returns 401 when unauthenticated", async () => {
    const res = await anon.put(`/v1/injuries/${INJURY_ID}`).send(validInjuryBody);
    expect(res.status).toBe(401);
  });

  it("PATCH /:id returns 401 when unauthenticated", async () => {
    const res = await anon.patch(`/v1/injuries/${INJURY_ID}`);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET / — list
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/injuries", () => {
  it("returns 200 and scopes the query to the authenticated user", async () => {
    prismaMock.injuryRecord.findMany.mockResolvedValue([injuryFixture]);

    const res = await auth.get("/v1/injuries");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].id).toBe(INJURY_ID);

    const [findManyArgs] = prismaMock.injuryRecord.findMany.mock.calls[0];
    expect(findManyArgs.where).toMatchObject({ userId: TEST_USER_ID });
  });

  it("applies the ?isActive=true filter", async () => {
    prismaMock.injuryRecord.findMany.mockResolvedValue([injuryFixture]);

    await auth.get("/v1/injuries?isActive=true");

    const [findManyArgs] = prismaMock.injuryRecord.findMany.mock.calls[0];
    expect(findManyArgs.where).toMatchObject({ userId: TEST_USER_ID, isActive: true });
  });

  it("applies the ?isActive=false filter", async () => {
    prismaMock.injuryRecord.findMany.mockResolvedValue([]);

    await auth.get("/v1/injuries?isActive=false");

    const [findManyArgs] = prismaMock.injuryRecord.findMany.mock.calls[0];
    expect(findManyArgs.where).toMatchObject({ userId: TEST_USER_ID, isActive: false });
  });

  it("omits isActive from where when ?isActive param is absent (returns all records)", async () => {
    prismaMock.injuryRecord.findMany.mockResolvedValue([]);

    await auth.get("/v1/injuries");

    const [findManyArgs] = prismaMock.injuryRecord.findMany.mock.calls[0];
    expect(findManyArgs.where).not.toHaveProperty("isActive");
  });

  it("applies the ?muscleGroup filter", async () => {
    prismaMock.injuryRecord.findMany.mockResolvedValue([injuryFixture]);

    await auth.get("/v1/injuries?muscleGroup=lower_back");

    const [findManyArgs] = prismaMock.injuryRecord.findMany.mock.calls[0];
    expect(findManyArgs.where).toMatchObject({ userId: TEST_USER_ID, muscleGroup: "lower_back" });
  });

  it("can combine ?isActive and ?muscleGroup filters", async () => {
    prismaMock.injuryRecord.findMany.mockResolvedValue([injuryFixture]);

    await auth.get("/v1/injuries?isActive=true&muscleGroup=lower_back");

    const [findManyArgs] = prismaMock.injuryRecord.findMany.mock.calls[0];
    expect(findManyArgs.where).toMatchObject({
      userId: TEST_USER_ID,
      isActive: true,
      muscleGroup: "lower_back",
    });
  });

  it("returns empty items array when user has no injuries", async () => {
    prismaMock.injuryRecord.findMany.mockResolvedValue([]);

    const res = await auth.get("/v1/injuries");
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:id — single resource
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/injuries/:id", () => {
  it("returns 200 and the injury when found", async () => {
    prismaMock.injuryRecord.findFirst.mockResolvedValue(injuryFixture);

    const res = await auth.get(`/v1/injuries/${INJURY_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.id).toBe(INJURY_ID);
  });

  it("scopes the findFirst query to { id, userId }", async () => {
    prismaMock.injuryRecord.findFirst.mockResolvedValue(injuryFixture);

    await auth.get(`/v1/injuries/${INJURY_ID}`);

    const [findFirstArgs] = prismaMock.injuryRecord.findFirst.mock.calls[0];
    expect(findFirstArgs.where).toMatchObject({ id: INJURY_ID, userId: TEST_USER_ID });
  });

  it("returns 404 when the injury does not exist (or belongs to another user)", async () => {
    prismaMock.injuryRecord.findFirst.mockResolvedValue(null);

    const res = await auth.get(`/v1/injuries/${INJURY_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.err.code).toBe("NOT_FOUND");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /:id — idempotent upsert
// ─────────────────────────────────────────────────────────────────────────────

describe("PUT /v1/injuries/:id", () => {
  it("returns 201 on the CREATE path (no owned row found)", async () => {
    prismaMock.injuryRecord.findFirst.mockResolvedValue(null);
    prismaMock.injuryRecord.create.mockResolvedValue(injuryFixture);

    const res = await auth.put(`/v1/injuries/${INJURY_ID}`).send(validInjuryBody);

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(prismaMock.injuryRecord.create).toHaveBeenCalledOnce();
    expect(prismaMock.injuryRecord.update).not.toHaveBeenCalled();
  });

  it("returns 200 on the UPDATE path (owned row already exists)", async () => {
    prismaMock.injuryRecord.findFirst.mockResolvedValue(injuryFixture);
    prismaMock.injuryRecord.update.mockResolvedValue({
      ...injuryFixture,
      description: "Updated description",
    });

    const res = await auth
      .put(`/v1/injuries/${INJURY_ID}`)
      .send({ ...validInjuryBody, description: "Updated description" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(prismaMock.injuryRecord.update).toHaveBeenCalledOnce();
    expect(prismaMock.injuryRecord.create).not.toHaveBeenCalled();
  });

  it("IDOR safety — ownership findFirst uses { id, userId }", async () => {
    prismaMock.injuryRecord.findFirst.mockResolvedValue(null);
    prismaMock.injuryRecord.create.mockResolvedValue(injuryFixture);

    await auth.put(`/v1/injuries/${INJURY_ID}`).send(validInjuryBody);

    const [findFirstArgs] = prismaMock.injuryRecord.findFirst.mock.calls[0];
    expect(findFirstArgs.where).toMatchObject({ id: INJURY_ID, userId: TEST_USER_ID });
    expect(prismaMock.injuryRecord.update).not.toHaveBeenCalled();
  });

  it("coerces ISO string createdAt to Date before the Prisma write (create path)", async () => {
    prismaMock.injuryRecord.findFirst.mockResolvedValue(null);
    prismaMock.injuryRecord.create.mockResolvedValue(injuryFixture);

    // Send createdAt as a plain ISO string — the route must coerce to Date
    await auth.put(`/v1/injuries/${INJURY_ID}`).send({
      ...validInjuryBody,
      createdAt: CREATED_AT_ISO, // string, not a Date
    });

    const [createArgs] = prismaMock.injuryRecord.create.mock.calls[0];
    // The value handed to Prisma must be a Date instance, not a raw string
    expect(createArgs.data.createdAt).toBeInstanceOf(Date);
    expect(createArgs.data.createdAt.toISOString()).toBe(CREATED_AT_ISO);
  });

  it("sets userId from the auth token, ignores client-injected userId", async () => {
    prismaMock.injuryRecord.findFirst.mockResolvedValue(null);
    prismaMock.injuryRecord.create.mockResolvedValue(injuryFixture);

    await auth
      .put(`/v1/injuries/${INJURY_ID}`)
      .send({ ...validInjuryBody, userId: "attacker-injected-user" });

    const [createArgs] = prismaMock.injuryRecord.create.mock.calls[0];
    expect(createArgs.data.userId).toBe(TEST_USER_ID);
  });

  it("returns 400 on an invalid body (missing required fields)", async () => {
    const res = await auth.put(`/v1/injuries/${INJURY_ID}`).send({ description: "No muscle group" });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /:id — soft delete (sets isActive: false)
// ─────────────────────────────────────────────────────────────────────────────

describe("PATCH /v1/injuries/:id (soft delete)", () => {
  it("returns 200 with the updated injury when found", async () => {
    prismaMock.injuryRecord.findFirst.mockResolvedValue(injuryFixture);
    prismaMock.injuryRecord.update.mockResolvedValue({ ...injuryFixture, isActive: false });

    const res = await auth.patch(`/v1/injuries/${INJURY_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.isActive).toBe(false);
  });

  it("sets isActive: false in the update data", async () => {
    prismaMock.injuryRecord.findFirst.mockResolvedValue(injuryFixture);
    prismaMock.injuryRecord.update.mockResolvedValue({ ...injuryFixture, isActive: false });

    await auth.patch(`/v1/injuries/${INJURY_ID}`);

    const [updateArgs] = prismaMock.injuryRecord.update.mock.calls[0];
    expect(updateArgs.data).toMatchObject({ isActive: false });
  });

  it("performs an IDOR check — scopes findFirst to { id, userId }", async () => {
    prismaMock.injuryRecord.findFirst.mockResolvedValue(injuryFixture);
    prismaMock.injuryRecord.update.mockResolvedValue({ ...injuryFixture, isActive: false });

    await auth.patch(`/v1/injuries/${INJURY_ID}`);

    const [findFirstArgs] = prismaMock.injuryRecord.findFirst.mock.calls[0];
    expect(findFirstArgs.where).toMatchObject({ id: INJURY_ID, userId: TEST_USER_ID });
  });

  it("returns 404 and does NOT call update when the injury is absent", async () => {
    prismaMock.injuryRecord.findFirst.mockResolvedValue(null);

    const res = await auth.patch(`/v1/injuries/${INJURY_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.err.code).toBe("NOT_FOUND");
    expect(prismaMock.injuryRecord.update).not.toHaveBeenCalled();
  });
});
