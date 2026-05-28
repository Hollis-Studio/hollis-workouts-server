/**
 * Tests for GET/PUT/DELETE /v1/sessions
 *
 * Resource characteristics:
 *   - Custom hand-written router (NOT the factory) — direct handlers
 *   - Client-generated UUIDs; PUT uses ownership-checked two-step:
 *       1. findFirst({ where: { id, userId } }) — IDOR ownership check
 *       2a. update (200) if owned row found
 *       2b. create (201) if no owned row exists
 *   - Session has NO createdAt column — factory's createdAt injection does NOT apply here
 *   - Hard delete with CASCADE:
 *       1. findFirst ownership check
 *       2. prisma.$transaction([metricBasketSnapshotRecord.deleteMany(...), session.delete(...)])
 *   - List filters: ?status, ?since (OR completedAt/startedAt >=), ?updatedSince (updatedAt >=), ?programId
 *   - Body uses ActiveTrainingSessionLogSchema from @hollis-studio/contracts
 *     (exercises array may be empty — covers in-progress sessions)
 *
 * Test coverage:
 *   - 401 for all verbs when unauthenticated
 *   - GET /  — userId-scoped findMany; ?status, ?since, ?programId filters; empty list
 *   - GET /:id — 200 when found; 404 when absent; findFirst uses { id, userId }
 *   - PUT /:id — 201 create path; 200 update path; IDOR two-step; userId from token; no createdAt; 400 on invalid body
 *   - DELETE /:id CASCADE — ownership check; $transaction called; deleteMany with { userId, sourceSessionId }; session deleted; 404 when absent
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Express } from "express";
import type { SuperTest, Test } from "supertest";
import { prismaMock, buildApp, authedAgent, anonAgent, TEST_USER_ID } from "../helpers/setup.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const SESSION_ID = "session-uuid-001";

/** Minimal valid questionnaire required by QuestionnaireResponseSchema. */
const validQuestionnaire = {
  sleepHours: 7,
  sleepQuality: 4,
  energyLevel: 4,
  stressLevel: 2,
  sorenessLevel: 3,
  hitMacrosYesterday: true,
  hydrationLevel: 4,
  goEasier: false,
  autoFilledSleep: false,
};

/**
 * Minimal valid session body.
 * - exercises is an empty array (in-progress session; schema allows this)
 * - id and userId are omitted (come from URL and token respectively)
 */
const validSessionBody = {
  programId: null,
  programDayName: null,
  gymProfileId: null,
  startedAt: "2025-06-01T09:00:00Z",
  completedAt: null,
  isFreestyle: false,
  isSubstitution: false,
  status: "active",
  questionnaire: validQuestionnaire,
  totalVolumeKg: 0,
  durationMinutes: 0,
  exercises: [],
};

const sessionFixture = {
  id: SESSION_ID,
  userId: TEST_USER_ID,
  programId: null,
  programDayName: null,
  gymProfileId: null,
  startedAt: new Date("2025-06-01T09:00:00Z"),
  completedAt: null,
  updatedAt: new Date("2025-06-01T09:00:00Z"),
  isFreestyle: false,
  isSubstitution: false,
  status: "active",
  questionnaire: validQuestionnaire,
  totalVolumeKg: 0,
  durationMinutes: 0,
  exercises: [],
  skippedExerciseIds: [],
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

// The shared resetMocks() in setup.ts iterates prismaMock values that are
// objects (model delegates), but prismaMock.$transaction is a vi.fn() at the
// root level — typeof === "function", so it is skipped by the harness loop.
// We reset it explicitly here to keep call counts clean between tests.
beforeEach(() => {
  prismaMock.$transaction.mockReset();
});

// ─────────────────────────────────────────────────────────────────────────────
// Authentication guard — every verb must 401 with no Authorization header
// ─────────────────────────────────────────────────────────────────────────────

describe("sessions — authentication", () => {
  it("GET / returns 401 when unauthenticated", async () => {
    const res = await anon.get("/v1/sessions");
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it("GET /:id returns 401 when unauthenticated", async () => {
    const res = await anon.get(`/v1/sessions/${SESSION_ID}`);
    expect(res.status).toBe(401);
  });

  it("PUT /:id returns 401 when unauthenticated", async () => {
    const res = await anon.put(`/v1/sessions/${SESSION_ID}`).send(validSessionBody);
    expect(res.status).toBe(401);
  });

  it("DELETE /:id returns 401 when unauthenticated", async () => {
    const res = await anon.delete(`/v1/sessions/${SESSION_ID}`);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET / — list
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/sessions", () => {
  it("returns 200 and scopes the query to the authenticated user", async () => {
    prismaMock.session.findMany.mockResolvedValue([sessionFixture]);

    const res = await auth.get("/v1/sessions");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].id).toBe(SESSION_ID);

    const [findManyArgs] = prismaMock.session.findMany.mock.calls[0];
    expect(findManyArgs.where).toMatchObject({ userId: TEST_USER_ID });
  });

  it("returns empty items array when user has no sessions", async () => {
    prismaMock.session.findMany.mockResolvedValue([]);

    const res = await auth.get("/v1/sessions");
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });

  it("applies ?status filter in the where clause", async () => {
    prismaMock.session.findMany.mockResolvedValue([]);

    await auth.get("/v1/sessions?status=completed");

    const [findManyArgs] = prismaMock.session.findMany.mock.calls[0];
    expect(findManyArgs.where).toMatchObject({ userId: TEST_USER_ID, status: "completed" });
  });

  it("applies ?since filter as OR [completedAt/startedAt >= Date] in the where clause", async () => {
    prismaMock.session.findMany.mockResolvedValue([]);
    const since = "2025-06-01T00:00:00Z";
    const sinceDate = new Date(since);

    await auth.get(`/v1/sessions?since=${encodeURIComponent(since)}`);

    const [findManyArgs] = prismaMock.session.findMany.mock.calls[0];
    expect(findManyArgs.where).toMatchObject({ userId: TEST_USER_ID });
    // ?since uses an OR clause on occurrence time (completedAt OR startedAt)
    expect(Array.isArray(findManyArgs.where.OR)).toBe(true);
    expect(findManyArgs.where.OR).toHaveLength(2);
    expect(findManyArgs.where.OR[0].completedAt.gte).toBeInstanceOf(Date);
    expect(findManyArgs.where.OR[0].completedAt.gte.toISOString()).toBe(sinceDate.toISOString());
    expect(findManyArgs.where.OR[1].startedAt.gte).toBeInstanceOf(Date);
    expect(findManyArgs.where.OR[1].startedAt.gte.toISOString()).toBe(sinceDate.toISOString());
    // ?since must NOT set updatedAt — that is ?updatedSince
    expect(findManyArgs.where.updatedAt).toBeUndefined();
  });

  it("applies ?updatedSince filter as updatedAt: { gte: Date } in the where clause", async () => {
    prismaMock.session.findMany.mockResolvedValue([]);
    const updatedSince = "2025-06-01T00:00:00Z";

    await auth.get(`/v1/sessions?updatedSince=${encodeURIComponent(updatedSince)}`);

    const [findManyArgs] = prismaMock.session.findMany.mock.calls[0];
    expect(findManyArgs.where).toMatchObject({ userId: TEST_USER_ID });
    expect(findManyArgs.where.updatedAt).toBeDefined();
    expect(findManyArgs.where.updatedAt.gte).toBeInstanceOf(Date);
    expect(findManyArgs.where.updatedAt.gte.toISOString()).toBe(new Date(updatedSince).toISOString());
    // ?updatedSince must NOT set the OR occurrence-time clause
    expect(findManyArgs.where.OR).toBeUndefined();
  });

  it("applies ?programId filter in the where clause", async () => {
    prismaMock.session.findMany.mockResolvedValue([]);

    await auth.get("/v1/sessions?programId=prog-abc-123");

    const [findManyArgs] = prismaMock.session.findMany.mock.calls[0];
    expect(findManyArgs.where).toMatchObject({ userId: TEST_USER_ID, programId: "prog-abc-123" });
  });

  it("applies multiple filters simultaneously", async () => {
    prismaMock.session.findMany.mockResolvedValue([]);
    const since = "2025-01-01T00:00:00Z";

    await auth.get(
      `/v1/sessions?status=active&since=${encodeURIComponent(since)}&programId=prog-xyz`,
    );

    const [findManyArgs] = prismaMock.session.findMany.mock.calls[0];
    expect(findManyArgs.where).toMatchObject({
      userId: TEST_USER_ID,
      status: "active",
      programId: "prog-xyz",
    });
    // ?since sets the OR occurrence-time clause
    expect(Array.isArray(findManyArgs.where.OR)).toBe(true);
    expect(findManyArgs.where.OR).toHaveLength(2);
  });

  it("omits absent optional filters from the where clause", async () => {
    prismaMock.session.findMany.mockResolvedValue([]);

    await auth.get("/v1/sessions");

    const [findManyArgs] = prismaMock.session.findMany.mock.calls[0];
    expect(findManyArgs.where).not.toHaveProperty("status");
    expect(findManyArgs.where).not.toHaveProperty("OR");
    expect(findManyArgs.where).not.toHaveProperty("updatedAt");
    expect(findManyArgs.where).not.toHaveProperty("programId");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:id — single session
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/sessions/:id", () => {
  it("returns 200 and the session when found", async () => {
    prismaMock.session.findFirst.mockResolvedValue(sessionFixture);

    const res = await auth.get(`/v1/sessions/${SESSION_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.id).toBe(SESSION_ID);
  });

  it("scopes findFirst to { id, userId } (IDOR-safe)", async () => {
    prismaMock.session.findFirst.mockResolvedValue(sessionFixture);

    await auth.get(`/v1/sessions/${SESSION_ID}`);

    const [findFirstArgs] = prismaMock.session.findFirst.mock.calls[0];
    expect(findFirstArgs.where).toMatchObject({ id: SESSION_ID, userId: TEST_USER_ID });
  });

  it("returns 404 when the session does not exist (or belongs to another user)", async () => {
    prismaMock.session.findFirst.mockResolvedValue(null);

    const res = await auth.get(`/v1/sessions/${SESSION_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.err.code).toBe("NOT_FOUND");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /:id — idempotent upsert (two-step IDOR-safe ownership check)
// ─────────────────────────────────────────────────────────────────────────────

describe("PUT /v1/sessions/:id", () => {
  it("returns 201 and creates the session when no owned row exists (CREATE path)", async () => {
    prismaMock.session.findFirst.mockResolvedValue(null);
    prismaMock.session.create.mockResolvedValue({ ...sessionFixture });

    const res = await auth.put(`/v1/sessions/${SESSION_ID}`).send(validSessionBody);

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(prismaMock.session.create).toHaveBeenCalledOnce();
    expect(prismaMock.session.update).not.toHaveBeenCalled();
  });

  it("includes the id from the URL in the create data", async () => {
    prismaMock.session.findFirst.mockResolvedValue(null);
    prismaMock.session.create.mockResolvedValue(sessionFixture);

    await auth.put(`/v1/sessions/${SESSION_ID}`).send(validSessionBody);

    const [createArgs] = prismaMock.session.create.mock.calls[0];
    expect(createArgs.data.id).toBe(SESSION_ID);
  });

  it("does NOT set createdAt on the create data (Session has no createdAt column)", async () => {
    prismaMock.session.findFirst.mockResolvedValue(null);
    prismaMock.session.create.mockResolvedValue(sessionFixture);

    await auth.put(`/v1/sessions/${SESSION_ID}`).send(validSessionBody);

    const [createArgs] = prismaMock.session.create.mock.calls[0];
    // The sessions route builds writeData without a createdAt field
    expect(createArgs.data).not.toHaveProperty("createdAt");
  });

  it("returns 200 and updates the session when the owned row already exists (UPDATE path)", async () => {
    prismaMock.session.findFirst.mockResolvedValue(sessionFixture);
    prismaMock.session.update.mockResolvedValue({ ...sessionFixture, status: "completed" });

    const res = await auth
      .put(`/v1/sessions/${SESSION_ID}`)
      .send({ ...validSessionBody, status: "completed" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(prismaMock.session.update).toHaveBeenCalledOnce();
    expect(prismaMock.session.create).not.toHaveBeenCalled();
  });

  it("IDOR — step 1 uses { id, userId } so another user's session is never overwritten", async () => {
    prismaMock.session.findFirst.mockResolvedValue(null);
    prismaMock.session.create.mockResolvedValue(sessionFixture);

    await auth.put(`/v1/sessions/${SESSION_ID}`).send(validSessionBody);

    const [findFirstArgs] = prismaMock.session.findFirst.mock.calls[0];
    expect(findFirstArgs.where).toMatchObject({ id: SESSION_ID, userId: TEST_USER_ID });
    expect(prismaMock.session.update).not.toHaveBeenCalled();
  });

  it("userId on the CREATE path always comes from the token, not from the request body", async () => {
    prismaMock.session.findFirst.mockResolvedValue(null);
    prismaMock.session.create.mockResolvedValue(sessionFixture);

    // The session body schema strips userId (omit({ userId: true })), so even
    // if an attacker includes userId in the body it is stripped by Zod before
    // the handler uses it. The handler then sets userId = req.userId.
    await auth
      .put(`/v1/sessions/${SESSION_ID}`)
      .send({ ...validSessionBody, userId: "hacker-injected-user" });

    const [createArgs] = prismaMock.session.create.mock.calls[0];
    expect(createArgs.data.userId).toBe(TEST_USER_ID);
  });

  it("userId on the UPDATE path always comes from the token, not from the request body", async () => {
    prismaMock.session.findFirst.mockResolvedValue(sessionFixture);
    prismaMock.session.update.mockResolvedValue(sessionFixture);

    await auth
      .put(`/v1/sessions/${SESSION_ID}`)
      .send({ ...validSessionBody, userId: "hacker-injected-user" });

    const [updateArgs] = prismaMock.session.update.mock.calls[0];
    expect(updateArgs.data.userId).toBe(TEST_USER_ID);
  });

  it("returns 400 on a completely empty body (missing required fields)", async () => {
    const res = await auth.put(`/v1/sessions/${SESSION_ID}`).send({});

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when status is not a valid enum value", async () => {
    const res = await auth
      .put(`/v1/sessions/${SESSION_ID}`)
      .send({ ...validSessionBody, status: "invalid-status" });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /:id — hard delete with cascade (prisma.$transaction)
// ─────────────────────────────────────────────────────────────────────────────

describe("DELETE /v1/sessions/:id (cascade)", () => {
  it("returns 200 and { deleted: true } when the session is owned", async () => {
    prismaMock.session.findFirst.mockResolvedValue(sessionFixture);
    // updateMany and session.update are called as eager args to $transaction([...])
    prismaMock.metricBasketSnapshotRecord.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.session.update.mockResolvedValue(sessionFixture);
    prismaMock.$transaction.mockResolvedValue([{ count: 0 }, sessionFixture]);

    const res = await auth.delete(`/v1/sessions/${SESSION_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.deleted).toBe(true);
  });

  it("checks ownership first — findFirst scoped to { id, userId } before the transaction", async () => {
    prismaMock.session.findFirst.mockResolvedValue(sessionFixture);
    prismaMock.metricBasketSnapshotRecord.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.session.update.mockResolvedValue(sessionFixture);
    prismaMock.$transaction.mockResolvedValue([{ count: 0 }, sessionFixture]);

    await auth.delete(`/v1/sessions/${SESSION_ID}`);

    const [findFirstArgs] = prismaMock.session.findFirst.mock.calls[0];
    expect(findFirstArgs.where).toMatchObject({ id: SESSION_ID, userId: TEST_USER_ID });
  });

  it("calls prisma.$transaction for atomic cascade tombstone", async () => {
    prismaMock.session.findFirst.mockResolvedValue(sessionFixture);
    prismaMock.metricBasketSnapshotRecord.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.session.update.mockResolvedValue(sessionFixture);
    prismaMock.$transaction.mockResolvedValue([{ count: 0 }, sessionFixture]);

    await auth.delete(`/v1/sessions/${SESSION_ID}`);

    expect(prismaMock.$transaction).toHaveBeenCalledOnce();
  });

  it("CASCADE — tombstones metric-basket snapshots with { userId, sourceSessionId: id }", async () => {
    prismaMock.session.findFirst.mockResolvedValue(sessionFixture);
    prismaMock.metricBasketSnapshotRecord.updateMany.mockResolvedValue({ count: 2 });
    prismaMock.session.update.mockResolvedValue(sessionFixture);
    prismaMock.$transaction.mockResolvedValue([{ count: 2 }, sessionFixture]);

    await auth.delete(`/v1/sessions/${SESSION_ID}`);

    // updateMany is called eagerly when building the $transaction array
    expect(prismaMock.metricBasketSnapshotRecord.updateMany).toHaveBeenCalledOnce();
    const [updateManyArgs] = prismaMock.metricBasketSnapshotRecord.updateMany.mock.calls[0];
    expect(updateManyArgs.where).toMatchObject({
      userId: TEST_USER_ID,
      sourceSessionId: SESSION_ID,
    });
    expect(updateManyArgs.data.deletedAt).toBeInstanceOf(Date);
  });

  it("CASCADE — session.update tombstones the session as part of the transaction", async () => {
    prismaMock.session.findFirst.mockResolvedValue(sessionFixture);
    prismaMock.metricBasketSnapshotRecord.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.session.update.mockResolvedValue(sessionFixture);
    prismaMock.$transaction.mockResolvedValue([{ count: 0 }, sessionFixture]);

    await auth.delete(`/v1/sessions/${SESSION_ID}`);

    expect(prismaMock.session.update).toHaveBeenCalledOnce();
    const [updateArgs] = prismaMock.session.update.mock.calls[0];
    expect(updateArgs.where).toMatchObject({ id: SESSION_ID });
    expect(updateArgs.data.deletedAt).toBeInstanceOf(Date);
  });

  it("returns 404 and does NOT call $transaction when session is absent (or foreign-owned)", async () => {
    prismaMock.session.findFirst.mockResolvedValue(null);

    const res = await auth.delete(`/v1/sessions/${SESSION_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.err.code).toBe("NOT_FOUND");
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.metricBasketSnapshotRecord.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.session.update).not.toHaveBeenCalled();
  });
});
