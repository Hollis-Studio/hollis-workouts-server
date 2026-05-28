/**
 * Tests for GET/PUT/DELETE /v1/metric-basket-snapshots
 *
 * Resource characteristics:
 *   - Produced by createCrudRouter() factory with deleteStyle: "hard"
 *   - Client-generated composite IDs; PUT uses ownership-checked two-step (IDOR guard)
 *   - Hard delete: DELETE /:id removes the row permanently
 *   - Filters: ?exerciseId, ?captureKind, ?since, ?sourceSessionId on GET /
 *   - capturedAt is accepted as an ISO string and coerced to a Date before write
 *   - createdAt is server-managed (set by the factory on create, never from client body)
 *   - Invalid filter params return 400 (no silent drop)
 *
 * Test coverage:
 *   - 401 for all verbs when unauthenticated
 *   - GET /  — user-scoping; each filter individually
 *   - GET /  — 400 when filter params are present but invalid
 *   - GET /:id — 200 when found; 404 when absent
 *   - PUT /:id — 201 on create path; 200 on update path; IDOR safety
 *   - PUT /:id — capturedAt ISO string coerced to Date in mock call args
 *   - PUT /:id — createdAt is server-set on create, not taken from body
 *   - DELETE /:id — 200 on success; 404 when absent; IDOR guard
 *   - PATCH /:id — 404 (no soft-delete route for hard-delete resources)
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

const SNAPSHOT_ID = "exercise-123__manual__session-abc";
const EXERCISE_ID = "exercise-123";
const SESSION_ID = "session-abc";
const CAPTURED_AT_ISO = "2025-06-01T08:00:00.000Z";

/** Minimal valid MetricBasketSnapshot object for the `snapshot` field */
const snapshotPayload = {
  exerciseId: EXERCISE_ID,
};

const snapshotFixture = {
  id: SNAPSHOT_ID,
  userId: TEST_USER_ID,
  exerciseId: EXERCISE_ID,
  capturedAt: new Date(CAPTURED_AT_ISO),
  captureKind: "manual",
  sourceSessionId: SESSION_ID,
  snapshot: snapshotPayload,
  createdAt: new Date("2025-06-01T08:00:00.000Z"),
};

const validSnapshotBody = {
  exerciseId: EXERCISE_ID,
  capturedAt: CAPTURED_AT_ISO,
  captureKind: "manual",
  sourceSessionId: SESSION_ID,
  snapshot: snapshotPayload,
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

describe("metric-basket-snapshots — authentication", () => {
  it("GET / returns 401 when unauthenticated", async () => {
    const res = await anon.get("/v1/metric-basket-snapshots");
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it("GET /:id returns 401 when unauthenticated", async () => {
    const res = await anon.get(`/v1/metric-basket-snapshots/${SNAPSHOT_ID}`);
    expect(res.status).toBe(401);
  });

  it("PUT /:id returns 401 when unauthenticated", async () => {
    const res = await anon.put(`/v1/metric-basket-snapshots/${SNAPSHOT_ID}`).send(validSnapshotBody);
    expect(res.status).toBe(401);
  });

  it("DELETE /:id returns 401 when unauthenticated", async () => {
    const res = await anon.delete(`/v1/metric-basket-snapshots/${SNAPSHOT_ID}`);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET / — list with filters
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/metric-basket-snapshots", () => {
  it("returns 200 and scopes the query to the authenticated user", async () => {
    prismaMock.metricBasketSnapshotRecord.findMany.mockResolvedValue([snapshotFixture]);

    const res = await auth.get("/v1/metric-basket-snapshots");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].id).toBe(SNAPSHOT_ID);

    const [findManyArgs] = prismaMock.metricBasketSnapshotRecord.findMany.mock.calls[0];
    expect(findManyArgs.where).toMatchObject({ userId: TEST_USER_ID });
  });

  it("applies the ?exerciseId filter", async () => {
    prismaMock.metricBasketSnapshotRecord.findMany.mockResolvedValue([snapshotFixture]);

    await auth.get(`/v1/metric-basket-snapshots?exerciseId=${EXERCISE_ID}`);

    const [findManyArgs] = prismaMock.metricBasketSnapshotRecord.findMany.mock.calls[0];
    expect(findManyArgs.where).toMatchObject({ userId: TEST_USER_ID, exerciseId: EXERCISE_ID });
  });

  it("applies the ?captureKind filter", async () => {
    prismaMock.metricBasketSnapshotRecord.findMany.mockResolvedValue([snapshotFixture]);

    await auth.get("/v1/metric-basket-snapshots?captureKind=manual");

    const [findManyArgs] = prismaMock.metricBasketSnapshotRecord.findMany.mock.calls[0];
    expect(findManyArgs.where).toMatchObject({ userId: TEST_USER_ID, captureKind: "manual" });
  });

  it("applies the ?since filter as a gte date range on capturedAt", async () => {
    prismaMock.metricBasketSnapshotRecord.findMany.mockResolvedValue([snapshotFixture]);

    await auth.get(`/v1/metric-basket-snapshots?since=${encodeURIComponent(CAPTURED_AT_ISO)}`);

    const [findManyArgs] = prismaMock.metricBasketSnapshotRecord.findMany.mock.calls[0];
    expect(findManyArgs.where).toMatchObject({
      userId: TEST_USER_ID,
      capturedAt: { gte: expect.any(Date) },
    });
    const sinceDate: Date = findManyArgs.where.capturedAt.gte;
    expect(sinceDate.toISOString()).toBe(CAPTURED_AT_ISO);
  });

  it("applies the ?sourceSessionId filter", async () => {
    prismaMock.metricBasketSnapshotRecord.findMany.mockResolvedValue([snapshotFixture]);

    await auth.get(`/v1/metric-basket-snapshots?sourceSessionId=${SESSION_ID}`);

    const [findManyArgs] = prismaMock.metricBasketSnapshotRecord.findMany.mock.calls[0];
    expect(findManyArgs.where).toMatchObject({ userId: TEST_USER_ID, sourceSessionId: SESSION_ID });
  });

  it("can combine multiple filters", async () => {
    prismaMock.metricBasketSnapshotRecord.findMany.mockResolvedValue([snapshotFixture]);

    await auth.get(
      `/v1/metric-basket-snapshots?exerciseId=${EXERCISE_ID}&captureKind=manual&sourceSessionId=${SESSION_ID}`,
    );

    const [findManyArgs] = prismaMock.metricBasketSnapshotRecord.findMany.mock.calls[0];
    expect(findManyArgs.where).toMatchObject({
      userId: TEST_USER_ID,
      exerciseId: EXERCISE_ID,
      captureKind: "manual",
      sourceSessionId: SESSION_ID,
    });
  });

  // ── 400 on invalid filter values (no silent drop) ──

  it("returns 400 when ?captureKind is present but not a valid enum value", async () => {
    const res = await auth.get("/v1/metric-basket-snapshots?captureKind=invalid_kind");

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(prismaMock.metricBasketSnapshotRecord.findMany).not.toHaveBeenCalled();
  });

  it("returns 400 when ?since is present but not a valid ISO datetime", async () => {
    const res = await auth.get("/v1/metric-basket-snapshots?since=not-a-date");

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(prismaMock.metricBasketSnapshotRecord.findMany).not.toHaveBeenCalled();
  });

  it("returns 400 when ?exerciseId is present but empty (fails min(1) check)", async () => {
    const res = await auth.get("/v1/metric-basket-snapshots?exerciseId=");

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(prismaMock.metricBasketSnapshotRecord.findMany).not.toHaveBeenCalled();
  });

  it("returns 400 when ?sourceSessionId is present but empty (fails min(1) check)", async () => {
    const res = await auth.get("/v1/metric-basket-snapshots?sourceSessionId=");

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(prismaMock.metricBasketSnapshotRecord.findMany).not.toHaveBeenCalled();
  });

  it("returns empty items array when user has no snapshots", async () => {
    prismaMock.metricBasketSnapshotRecord.findMany.mockResolvedValue([]);

    const res = await auth.get("/v1/metric-basket-snapshots");
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:id — single resource
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/metric-basket-snapshots/:id", () => {
  it("returns 200 and the snapshot when found", async () => {
    prismaMock.metricBasketSnapshotRecord.findFirst.mockResolvedValue(snapshotFixture);

    const res = await auth.get(`/v1/metric-basket-snapshots/${SNAPSHOT_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.id).toBe(SNAPSHOT_ID);
  });

  it("scopes the findFirst query to { id, userId }", async () => {
    prismaMock.metricBasketSnapshotRecord.findFirst.mockResolvedValue(snapshotFixture);

    await auth.get(`/v1/metric-basket-snapshots/${SNAPSHOT_ID}`);

    const [findFirstArgs] = prismaMock.metricBasketSnapshotRecord.findFirst.mock.calls[0];
    expect(findFirstArgs.where).toMatchObject({ id: SNAPSHOT_ID, userId: TEST_USER_ID });
  });

  it("returns 404 when the snapshot does not exist (or belongs to another user)", async () => {
    prismaMock.metricBasketSnapshotRecord.findFirst.mockResolvedValue(null);

    const res = await auth.get(`/v1/metric-basket-snapshots/${SNAPSHOT_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.err.code).toBe("NOT_FOUND");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /:id — idempotent upsert
// ─────────────────────────────────────────────────────────────────────────────

describe("PUT /v1/metric-basket-snapshots/:id", () => {
  it("returns 201 on the CREATE path (no owned row found)", async () => {
    prismaMock.metricBasketSnapshotRecord.findFirst.mockResolvedValue(null);
    prismaMock.metricBasketSnapshotRecord.create.mockResolvedValue(snapshotFixture);

    const res = await auth.put(`/v1/metric-basket-snapshots/${SNAPSHOT_ID}`).send(validSnapshotBody);

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(prismaMock.metricBasketSnapshotRecord.create).toHaveBeenCalledOnce();
    expect(prismaMock.metricBasketSnapshotRecord.update).not.toHaveBeenCalled();
  });

  it("returns 200 on the UPDATE path (owned row already exists)", async () => {
    prismaMock.metricBasketSnapshotRecord.findFirst.mockResolvedValue(snapshotFixture);
    prismaMock.metricBasketSnapshotRecord.update.mockResolvedValue({
      ...snapshotFixture,
      captureKind: "post_session",
    });

    const res = await auth
      .put(`/v1/metric-basket-snapshots/${SNAPSHOT_ID}`)
      .send({ ...validSnapshotBody, captureKind: "post_session" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(prismaMock.metricBasketSnapshotRecord.update).toHaveBeenCalledOnce();
    expect(prismaMock.metricBasketSnapshotRecord.create).not.toHaveBeenCalled();
  });

  it("IDOR safety — ownership findFirst uses { id, userId }", async () => {
    prismaMock.metricBasketSnapshotRecord.findFirst.mockResolvedValue(null);
    prismaMock.metricBasketSnapshotRecord.create.mockResolvedValue(snapshotFixture);

    await auth.put(`/v1/metric-basket-snapshots/${SNAPSHOT_ID}`).send(validSnapshotBody);

    const [findFirstArgs] = prismaMock.metricBasketSnapshotRecord.findFirst.mock.calls[0];
    expect(findFirstArgs.where).toMatchObject({ id: SNAPSHOT_ID, userId: TEST_USER_ID });
    expect(prismaMock.metricBasketSnapshotRecord.update).not.toHaveBeenCalled();
  });

  it("coerces ISO string capturedAt to Date before the Prisma write (create path)", async () => {
    prismaMock.metricBasketSnapshotRecord.findFirst.mockResolvedValue(null);
    prismaMock.metricBasketSnapshotRecord.create.mockResolvedValue(snapshotFixture);

    // Send capturedAt as a plain ISO string — the route must coerce to Date
    await auth.put(`/v1/metric-basket-snapshots/${SNAPSHOT_ID}`).send({
      ...validSnapshotBody,
      capturedAt: CAPTURED_AT_ISO, // string, not a Date
    });

    const [createArgs] = prismaMock.metricBasketSnapshotRecord.create.mock.calls[0];
    // The value handed to Prisma must be a Date instance, not a raw string
    expect(createArgs.data.capturedAt).toBeInstanceOf(Date);
    expect(createArgs.data.capturedAt.toISOString()).toBe(CAPTURED_AT_ISO);
  });

  it("coerces ISO string capturedAt to Date on the update path", async () => {
    prismaMock.metricBasketSnapshotRecord.findFirst.mockResolvedValue(snapshotFixture);
    prismaMock.metricBasketSnapshotRecord.update.mockResolvedValue(snapshotFixture);

    await auth.put(`/v1/metric-basket-snapshots/${SNAPSHOT_ID}`).send({
      ...validSnapshotBody,
      capturedAt: CAPTURED_AT_ISO,
    });

    const [updateArgs] = prismaMock.metricBasketSnapshotRecord.update.mock.calls[0];
    expect(updateArgs.data.capturedAt).toBeInstanceOf(Date);
  });

  it("createdAt is server-set on the create path — body createdAt is stripped", async () => {
    prismaMock.metricBasketSnapshotRecord.findFirst.mockResolvedValue(null);
    prismaMock.metricBasketSnapshotRecord.create.mockResolvedValue(snapshotFixture);

    const serverTimeBefore = Date.now();
    await auth.put(`/v1/metric-basket-snapshots/${SNAPSHOT_ID}`).send({
      ...validSnapshotBody,
      // Sending a client-supplied createdAt far in the past — must be ignored
      createdAt: "2000-01-01T00:00:00.000Z",
    });
    const serverTimeAfter = Date.now();

    const [createArgs] = prismaMock.metricBasketSnapshotRecord.create.mock.calls[0];
    // Factory uses new Date() for createdAt — must be a Date and roughly "now"
    expect(createArgs.data.createdAt).toBeInstanceOf(Date);
    const createdAtMs = createArgs.data.createdAt.getTime();
    // Should be within the test execution window (not the year 2000)
    expect(createdAtMs).toBeGreaterThanOrEqual(serverTimeBefore);
    expect(createdAtMs).toBeLessThanOrEqual(serverTimeAfter + 100);
  });

  it("sets userId from the auth token, ignores client-injected userId", async () => {
    prismaMock.metricBasketSnapshotRecord.findFirst.mockResolvedValue(null);
    prismaMock.metricBasketSnapshotRecord.create.mockResolvedValue(snapshotFixture);

    await auth
      .put(`/v1/metric-basket-snapshots/${SNAPSHOT_ID}`)
      .send({ ...validSnapshotBody, userId: "attacker-injected-user" });

    const [createArgs] = prismaMock.metricBasketSnapshotRecord.create.mock.calls[0];
    expect(createArgs.data.userId).toBe(TEST_USER_ID);
  });

  it("returns 400 on an invalid body (missing required fields)", async () => {
    const res = await auth
      .put(`/v1/metric-basket-snapshots/${SNAPSHOT_ID}`)
      .send({ exerciseId: EXERCISE_ID });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when captureKind is not a valid enum value", async () => {
    const res = await auth.put(`/v1/metric-basket-snapshots/${SNAPSHOT_ID}`).send({
      ...validSnapshotBody,
      captureKind: "invalid_kind",
    });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /:id — hard delete
// ─────────────────────────────────────────────────────────────────────────────

describe("DELETE /v1/metric-basket-snapshots/:id (hard delete)", () => {
  it("returns 200 with { deleted: true } when the snapshot is found and deleted", async () => {
    prismaMock.metricBasketSnapshotRecord.findFirst.mockResolvedValue(snapshotFixture);
    prismaMock.metricBasketSnapshotRecord.delete.mockResolvedValue(snapshotFixture);

    const res = await auth.delete(`/v1/metric-basket-snapshots/${SNAPSHOT_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.deleted).toBe(true);
  });

  it("performs an IDOR ownership check before deleting", async () => {
    prismaMock.metricBasketSnapshotRecord.findFirst.mockResolvedValue(snapshotFixture);
    prismaMock.metricBasketSnapshotRecord.delete.mockResolvedValue(snapshotFixture);

    await auth.delete(`/v1/metric-basket-snapshots/${SNAPSHOT_ID}`);

    const [findFirstArgs] = prismaMock.metricBasketSnapshotRecord.findFirst.mock.calls[0];
    expect(findFirstArgs.where).toMatchObject({ id: SNAPSHOT_ID, userId: TEST_USER_ID });
  });

  it("tombstones via update with userId in the where clause (defense-in-depth)", async () => {
    prismaMock.metricBasketSnapshotRecord.findFirst.mockResolvedValue(snapshotFixture);
    prismaMock.metricBasketSnapshotRecord.update.mockResolvedValue(snapshotFixture);

    await auth.delete(`/v1/metric-basket-snapshots/${SNAPSHOT_ID}`);

    const [updateArgs] = prismaMock.metricBasketSnapshotRecord.update.mock.calls[0];
    expect(updateArgs.where).toMatchObject({ id: SNAPSHOT_ID, userId: TEST_USER_ID });
    expect(updateArgs.data.deletedAt).toBeInstanceOf(Date);
  });

  it("returns 404 and does NOT tombstone when the snapshot is absent", async () => {
    prismaMock.metricBasketSnapshotRecord.findFirst.mockResolvedValue(null);

    const res = await auth.delete(`/v1/metric-basket-snapshots/${SNAPSHOT_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.err.code).toBe("NOT_FOUND");
    expect(prismaMock.metricBasketSnapshotRecord.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /:id — must not exist (hard-delete resources use DELETE only)
// ─────────────────────────────────────────────────────────────────────────────

describe("PATCH /v1/metric-basket-snapshots/:id (no soft-delete route)", () => {
  it("returns 404 — there is no PATCH route for hard-delete resources", async () => {
    const res = await auth.patch(`/v1/metric-basket-snapshots/${SNAPSHOT_ID}`);
    expect(res.status).toBe(404);
  });
});
