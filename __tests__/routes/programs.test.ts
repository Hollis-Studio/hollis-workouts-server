/**
 * Tests for GET/PUT/DELETE /v1/programs
 *
 * Resource characteristics:
 *   - Produced by createCrudRouter() factory with deleteStyle: "hard"
 *   - Client-generated UUIDs; PUT uses ownership-checked two-step:
 *       1. findFirst({ where: { id, userId } }) — IDOR ownership check
 *       2a. update (200) if owned row found
 *       2b. create (201) if no owned row exists; createdAt set from body or now()
 *   - Hard delete: DELETE /:id with prior ownership check (findFirst)
 *   - Optional ?isActive filter on GET /
 *
 * Test coverage:
 *   - 401 for all verbs when unauthenticated
 *   - GET /  — user-scoping (findMany called with userId), ?isActive filter
 *   - GET /:id — 200 when found; 404 when absent; user-scoping via findFirst
 *   - PUT /:id — 201 on create path; 200 on update path; IDOR safety; userId from token; 400 on invalid body
 *   - DELETE /:id — ownership check then hard delete; 404 when absent; no delete without ownership
 */

import { describe, it, expect, beforeAll } from "vitest";
import type { Express } from "express";
import type { SuperTest, Test } from "supertest";
import { prismaMock, buildApp, authedAgent, anonAgent, TEST_USER_ID } from "../helpers/setup.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const PROGRAM_ID = "program-uuid-001";

/** Minimal schedule entry that satisfies the nested Zod sub-schemas. */
const validSchedule = [
  {
    dayOfWeek: 1,
    name: "Push Day",
    exercises: [
      {
        canonicalExerciseId: "bench-press",
        order: 0,
        sets: [
          {
            setNumber: 1,
            targetWeightKg: 100,
            targetReps: 8,
            targetRIR: 2,
            isWarmup: false,
          },
        ],
        goalMode: "progress",
        progressionMode: "weight_first",
        repThresholdForWeightJump: 10,
        cardioTargets: null,
        maintenanceTarget: null,
        cardioMaintenanceTarget: null,
      },
    ],
  },
];

const programFixture = {
  id: PROGRAM_ID,
  userId: TEST_USER_ID,
  name: "Strength Block 1",
  description: "12-week strength program",
  type: "mesocycle",
  startDate: new Date("2025-01-01T00:00:00Z"),
  endDate: null,
  durationWeeks: 12,
  isActive: true,
  deloadWeekNumbers: [4, 8, 12],
  deloadPercent: 0.4,
  schedule: validSchedule,
  schemaVersion: 1,
  createdAt: new Date("2025-01-01T00:00:00Z"),
  updatedAt: new Date("2025-01-01T00:00:00Z"),
};

/** Valid PUT body — no userId (comes from token), no id (comes from URL). */
const validProgramBody = {
  name: "Strength Block 1",
  description: "12-week strength program",
  type: "mesocycle",
  startDate: "2025-01-01T00:00:00Z",
  durationWeeks: 12,
  isActive: true,
  deloadWeekNumbers: [4, 8, 12],
  deloadPercent: 0.4,
  schedule: validSchedule,
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
// Authentication guard — every verb must 401 with no Authorization header
// ─────────────────────────────────────────────────────────────────────────────

describe("programs — authentication", () => {
  it("GET / returns 401 when unauthenticated", async () => {
    const res = await anon.get("/v1/programs");
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it("GET /:id returns 401 when unauthenticated", async () => {
    const res = await anon.get(`/v1/programs/${PROGRAM_ID}`);
    expect(res.status).toBe(401);
  });

  it("PUT /:id returns 401 when unauthenticated", async () => {
    const res = await anon.put(`/v1/programs/${PROGRAM_ID}`).send(validProgramBody);
    expect(res.status).toBe(401);
  });

  it("DELETE /:id returns 401 when unauthenticated", async () => {
    const res = await anon.delete(`/v1/programs/${PROGRAM_ID}`);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET / — list
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/programs", () => {
  it("returns 200 and scopes the query to the authenticated user", async () => {
    prismaMock.program.findMany.mockResolvedValue([programFixture]);

    const res = await auth.get("/v1/programs");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].id).toBe(PROGRAM_ID);

    // Factory always includes userId in the where clause
    const [findManyArgs] = prismaMock.program.findMany.mock.calls[0];
    expect(findManyArgs.where).toMatchObject({ userId: TEST_USER_ID });
  });

  it("applies ?isActive=true filter", async () => {
    prismaMock.program.findMany.mockResolvedValue([programFixture]);

    await auth.get("/v1/programs?isActive=true");

    const [findManyArgs] = prismaMock.program.findMany.mock.calls[0];
    expect(findManyArgs.where).toMatchObject({ userId: TEST_USER_ID, isActive: true });
  });

  it("applies ?isActive=false filter", async () => {
    prismaMock.program.findMany.mockResolvedValue([]);

    await auth.get("/v1/programs?isActive=false");

    const [findManyArgs] = prismaMock.program.findMany.mock.calls[0];
    expect(findManyArgs.where).toMatchObject({ userId: TEST_USER_ID, isActive: false });
  });

  it("does NOT apply isActive filter when query param is absent", async () => {
    prismaMock.program.findMany.mockResolvedValue([]);

    await auth.get("/v1/programs");

    const [findManyArgs] = prismaMock.program.findMany.mock.calls[0];
    // where should have userId but no isActive key at all
    expect(findManyArgs.where).toMatchObject({ userId: TEST_USER_ID });
    expect(findManyArgs.where).not.toHaveProperty("isActive");
  });

  it("returns empty items array when user has no programs", async () => {
    prismaMock.program.findMany.mockResolvedValue([]);

    const res = await auth.get("/v1/programs");
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:id — single resource
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/programs/:id", () => {
  it("returns 200 and the program when found", async () => {
    prismaMock.program.findFirst.mockResolvedValue(programFixture);

    const res = await auth.get(`/v1/programs/${PROGRAM_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.id).toBe(PROGRAM_ID);
  });

  it("scopes findFirst to the authenticated user (IDOR-safe)", async () => {
    prismaMock.program.findFirst.mockResolvedValue(programFixture);

    await auth.get(`/v1/programs/${PROGRAM_ID}`);

    const [findFirstArgs] = prismaMock.program.findFirst.mock.calls[0];
    expect(findFirstArgs.where).toMatchObject({ id: PROGRAM_ID, userId: TEST_USER_ID });
  });

  it("returns 404 when the program does not exist (or belongs to another user)", async () => {
    prismaMock.program.findFirst.mockResolvedValue(null);

    const res = await auth.get(`/v1/programs/${PROGRAM_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.err.code).toBe("NOT_FOUND");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /:id — idempotent upsert (two-step IDOR-safe ownership check)
// ─────────────────────────────────────────────────────────────────────────────

describe("PUT /v1/programs/:id", () => {
  it("returns 201 and creates the program when no owned row exists (CREATE path)", async () => {
    // Two-step: findFirst null → create → 201
    prismaMock.program.findFirst.mockResolvedValue(null);
    prismaMock.program.create.mockResolvedValue({ ...programFixture, ...validProgramBody });

    const res = await auth.put(`/v1/programs/${PROGRAM_ID}`).send(validProgramBody);

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(prismaMock.program.create).toHaveBeenCalledOnce();
    expect(prismaMock.program.update).not.toHaveBeenCalled();
  });

  it("returns 200 and updates the program when the owned row already exists (UPDATE path)", async () => {
    // Two-step: findFirst returns owned row → update → 200
    prismaMock.program.findFirst.mockResolvedValue(programFixture);
    prismaMock.program.update.mockResolvedValue({ ...programFixture, name: "Renamed Block" });

    const res = await auth
      .put(`/v1/programs/${PROGRAM_ID}`)
      .send({ ...validProgramBody, name: "Renamed Block" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.name).toBe("Renamed Block");
    expect(prismaMock.program.update).toHaveBeenCalledOnce();
    expect(prismaMock.program.create).not.toHaveBeenCalled();
  });

  it("IDOR — step 1 uses { id, userId } so another user's row is never overwritten", async () => {
    // When findFirst returns null (foreign-owned row not visible to this user),
    // the factory falls through to create, NEVER update.
    prismaMock.program.findFirst.mockResolvedValue(null);
    prismaMock.program.create.mockResolvedValue(programFixture);

    await auth.put(`/v1/programs/${PROGRAM_ID}`).send(validProgramBody);

    const [findFirstArgs] = prismaMock.program.findFirst.mock.calls[0];
    expect(findFirstArgs.where).toMatchObject({ id: PROGRAM_ID, userId: TEST_USER_ID });
    // update must never be called when findFirst returns null
    expect(prismaMock.program.update).not.toHaveBeenCalled();
  });

  it("userId on the CREATE path always comes from the token, not from the request body", async () => {
    prismaMock.program.findFirst.mockResolvedValue(null);
    prismaMock.program.create.mockResolvedValue(programFixture);

    await auth
      .put(`/v1/programs/${PROGRAM_ID}`)
      .send({ ...validProgramBody, userId: "hacker-injected-user" });

    const [createArgs] = prismaMock.program.create.mock.calls[0];
    expect(createArgs.data.userId).toBe(TEST_USER_ID);
  });

  it("userId on the UPDATE path always comes from the token, not from the request body", async () => {
    prismaMock.program.findFirst.mockResolvedValue(programFixture);
    prismaMock.program.update.mockResolvedValue(programFixture);

    await auth
      .put(`/v1/programs/${PROGRAM_ID}`)
      .send({ ...validProgramBody, userId: "hacker-injected-user" });

    const [updateArgs] = prismaMock.program.update.mock.calls[0];
    // Both where and data must carry the token userId
    expect(updateArgs.where.userId).toBe(TEST_USER_ID);
    expect(updateArgs.data.userId).toBe(TEST_USER_ID);
  });

  it("returns 400 on an invalid body (missing required fields)", async () => {
    // name is required; sending empty object should fail Zod validation
    const res = await auth.put(`/v1/programs/${PROGRAM_ID}`).send({});

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when body fails schema (non-string name)", async () => {
    const res = await auth
      .put(`/v1/programs/${PROGRAM_ID}`)
      .send({ ...validProgramBody, name: "" }); // min(1) fails

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("enforces the contract: deloadPercent > 1 is rejected (0..1 fraction, not 0..100)", async () => {
    const res = await auth
      .put(`/v1/programs/${PROGRAM_ID}`)
      .send({ ...validProgramBody, deloadPercent: 40 });

    expect(res.status).toBe(400);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });

  it("enforces the contract: dayOfWeek = -1 (rest-day sentinel) is accepted", async () => {
    prismaMock.program.findFirst.mockResolvedValue(null);
    prismaMock.program.create.mockResolvedValue(programFixture);

    const restDaySchedule = [{ ...validSchedule[0], dayOfWeek: -1 }];
    const res = await auth
      .put(`/v1/programs/${PROGRAM_ID}`)
      .send({ ...validProgramBody, schedule: restDaySchedule });

    expect(res.status).toBe(201);
  });

  it("enforces the contract: a day with an empty exercises array is rejected (min 1)", async () => {
    const emptyDay = [{ dayOfWeek: 1, name: "Empty", exercises: [] }];
    const res = await auth
      .put(`/v1/programs/${PROGRAM_ID}`)
      .send({ ...validProgramBody, schedule: emptyDay });

    expect(res.status).toBe(400);
  });

  it("returns 400 when schedule contains an invalid exercise (missing required fields)", async () => {
    const badSchedule = [
      {
        dayOfWeek: 1,
        name: "Push Day",
        exercises: [
          {
            // missing canonicalExerciseId, order, sets, goalMode, etc.
            bad: "data",
          },
        ],
      },
    ];

    const res = await auth
      .put(`/v1/programs/${PROGRAM_ID}`)
      .send({ ...validProgramBody, schedule: badSchedule });

    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /:id — hard delete with IDOR ownership check
// ─────────────────────────────────────────────────────────────────────────────

describe("DELETE /v1/programs/:id", () => {
  it("returns 200 and { deleted: true } when the program exists and is owned", async () => {
    prismaMock.program.findFirst.mockResolvedValue(programFixture);
    prismaMock.program.delete.mockResolvedValue(programFixture);

    const res = await auth.delete(`/v1/programs/${PROGRAM_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.deleted).toBe(true);
  });

  it("performs an ownership check — findFirst is scoped to { id, userId } before delete", async () => {
    prismaMock.program.findFirst.mockResolvedValue(programFixture);
    prismaMock.program.delete.mockResolvedValue(programFixture);

    await auth.delete(`/v1/programs/${PROGRAM_ID}`);

    const [findFirstArgs] = prismaMock.program.findFirst.mock.calls[0];
    expect(findFirstArgs.where).toMatchObject({ id: PROGRAM_ID, userId: TEST_USER_ID });
  });

  it("calls program.delete after successful ownership check", async () => {
    prismaMock.program.findFirst.mockResolvedValue(programFixture);
    prismaMock.program.delete.mockResolvedValue(programFixture);

    await auth.delete(`/v1/programs/${PROGRAM_ID}`);

    expect(prismaMock.program.delete).toHaveBeenCalledOnce();
  });

  it("returns 404 and does NOT call delete when the program is absent (or foreign-owned)", async () => {
    prismaMock.program.findFirst.mockResolvedValue(null);

    const res = await auth.delete(`/v1/programs/${PROGRAM_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.err.code).toBe("NOT_FOUND");
    expect(prismaMock.program.delete).not.toHaveBeenCalled();
  });

  it("does NOT expose a PATCH route (hard-delete resources have no soft-delete endpoint)", async () => {
    const res = await auth.patch(`/v1/programs/${PROGRAM_ID}`);
    // Express returns 404 for unmatched routes
    expect(res.status).toBe(404);
  });
});
