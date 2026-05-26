/**
 * Tests for GET / + GET /:weekIso + PUT /:weekIso on /v1/weeks
 *
 * Resource characteristics:
 *   - Composite PK: (userId, weekIso) — no standalone `id` column in Prisma
 *   - Every response object synthesises `id: weekIso` via the withId() helper
 *   - GET / — user-scoped, supports ?since=<YYYY-Www> filter and cursor pagination
 *             bounded by take=50 (paginationSchema default)
 *   - GET /:weekIso — findUnique({ where: { userId_weekIso: { userId, weekIso } } }); 404 on null
 *   - PUT /:weekIso — Prisma upsert on composite key; 200 (idempotent, not 201)
 *   - No DELETE route exists
 *   - Invalid weekIso format → 400
 *
 * Test coverage:
 *   - 401 when unauthenticated (GET /, GET /:weekIso, PUT /:weekIso)
 *   - GET / — userId scoping, ?since filter, pagination take, id synthesis
 *   - GET /:weekIso — 200 with id===weekIso, 404 on null, findUnique args, 400 invalid format
 *   - PUT /:weekIso — 200, upsert args with composite key, userId from token, id synthesis
 *   - DELETE /:weekIso — 404 (no route)
 */

import { describe, it, expect, beforeAll } from "vitest";
import type { Express } from "express";
import type { SuperTest, Test } from "supertest";
import { prismaMock, buildApp, authedAgent, anonAgent, TEST_USER_ID } from "../helpers/setup.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const WEEK_ISO = "2025-W20";
const WEEK_ISO_2 = "2025-W19";

const weekFixture = {
  userId: TEST_USER_ID,
  weekIso: WEEK_ISO,
  deterministicSnapshot: null,
  aiRetrospective: null,
  userAnnotations: null,
  conversationUpdatedAt: null,
  hasConversation: false,
  lastConversationThreadId: null,
  createdAt: new Date("2025-05-12T00:00:00Z"),
  updatedAt: new Date("2025-05-12T00:00:00Z"),
};

const weekFixture2 = {
  ...weekFixture,
  weekIso: WEEK_ISO_2,
  createdAt: new Date("2025-05-05T00:00:00Z"),
  updatedAt: new Date("2025-05-05T00:00:00Z"),
};

const validWeekBody = {
  deterministicSnapshot: { sets: 12 },
  aiRetrospective: null,
  userAnnotations: null,
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

describe("weeks — authentication", () => {
  it("GET / returns 401 when unauthenticated", async () => {
    const res = await anon.get("/v1/weeks");
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it("GET /:weekIso returns 401 when unauthenticated", async () => {
    const res = await anon.get(`/v1/weeks/${WEEK_ISO}`);
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it("PUT /:weekIso returns 401 when unauthenticated", async () => {
    const res = await anon.put(`/v1/weeks/${WEEK_ISO}`).send(validWeekBody);
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET / — list all weeks for the user
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/weeks", () => {
  it("returns 200 and scopes findMany to the authenticated user", async () => {
    prismaMock.week.findMany.mockResolvedValue([weekFixture]);

    const res = await auth.get("/v1/weeks");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.items).toHaveLength(1);

    const [args] = prismaMock.week.findMany.mock.calls[0];
    expect(args.where).toMatchObject({ userId: TEST_USER_ID });
  });

  it("every response item includes id equal to its weekIso (synthesised)", async () => {
    prismaMock.week.findMany.mockResolvedValue([weekFixture, weekFixture2]);

    const res = await auth.get("/v1/weeks");

    expect(res.status).toBe(200);
    const items: Array<{ id: string; weekIso: string }> = res.body.data.items;
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.id).toBe(item.weekIso);
    }
    expect(items[0].id).toBe(WEEK_ISO);
    expect(items[1].id).toBe(WEEK_ISO_2);
  });

  it("applies the ?since filter as a gte on weekIso", async () => {
    prismaMock.week.findMany.mockResolvedValue([]);

    await auth.get("/v1/weeks?since=2025-W10");

    const [args] = prismaMock.week.findMany.mock.calls[0];
    expect(args.where).toMatchObject({ userId: TEST_USER_ID, weekIso: { gte: "2025-W10" } });
  });

  it("pagination take is bounded by the default of 50", async () => {
    prismaMock.week.findMany.mockResolvedValue([]);

    await auth.get("/v1/weeks");

    const [args] = prismaMock.week.findMany.mock.calls[0];
    // paginationSchema default is 50 — the route must not query without a take bound
    expect(args.take).toBe(50);
  });

  it("returns empty items array when user has no weeks", async () => {
    prismaMock.week.findMany.mockResolvedValue([]);

    const res = await auth.get("/v1/weeks");
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });

  it("returns 400 when ?since is an invalid weekIso string", async () => {
    const res = await auth.get("/v1/weeks?since=not-a-week");
    expect(res.status).toBe(400);
  });

  it("sets nextCursor when items length equals the take limit", async () => {
    // Return exactly `limit` (default 50) items — route should set nextCursor to last weekIso
    const manyWeeks = Array.from({ length: 50 }, (_, i) => ({
      ...weekFixture,
      weekIso: `2025-W${String(i + 1).padStart(2, "0")}`,
    }));
    prismaMock.week.findMany.mockResolvedValue(manyWeeks);

    const res = await auth.get("/v1/weeks");

    expect(res.status).toBe(200);
    // nextCursor should be the weekIso of the last item
    expect(res.body.data.nextCursor).toBe("2025-W50");
  });

  it("sets nextCursor to null when fewer items than the limit are returned", async () => {
    prismaMock.week.findMany.mockResolvedValue([weekFixture]);

    const res = await auth.get("/v1/weeks");

    expect(res.body.data.nextCursor).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:weekIso — single week
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/weeks/:weekIso", () => {
  it("returns 200 and the week when found", async () => {
    prismaMock.week.findUnique.mockResolvedValue(weekFixture);

    const res = await auth.get(`/v1/weeks/${WEEK_ISO}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("response includes id === weekIso (synthesised — no real id column)", async () => {
    prismaMock.week.findUnique.mockResolvedValue(weekFixture);

    const res = await auth.get(`/v1/weeks/${WEEK_ISO}`);

    expect(res.body.data.id).toBe(WEEK_ISO);
    expect(res.body.data.weekIso).toBe(WEEK_ISO);
  });

  it("calls findUnique with composite key { userId_weekIso: { userId, weekIso } }", async () => {
    prismaMock.week.findUnique.mockResolvedValue(weekFixture);

    await auth.get(`/v1/weeks/${WEEK_ISO}`);

    const [args] = prismaMock.week.findUnique.mock.calls[0];
    expect(args.where).toEqual({
      userId_weekIso: { userId: TEST_USER_ID, weekIso: WEEK_ISO },
    });
  });

  it("returns 404 when the week does not exist", async () => {
    prismaMock.week.findUnique.mockResolvedValue(null);

    const res = await auth.get(`/v1/weeks/${WEEK_ISO}`);

    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.err.code).toBe("NOT_FOUND");
  });

  it("returns 400 when weekIso format is invalid", async () => {
    const res = await auth.get("/v1/weeks/not-a-week");
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("returns 400 for a completely malformed weekIso param", async () => {
    const res = await auth.get("/v1/weeks/2025-W99");
    // W99 is out of range per weekIsoSchema
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /:weekIso — upsert (idempotent, returns 200)
// ─────────────────────────────────────────────────────────────────────────────

describe("PUT /v1/weeks/:weekIso", () => {
  it("returns 200 (idempotent upsert, not 201)", async () => {
    prismaMock.week.upsert.mockResolvedValue({ ...weekFixture, ...validWeekBody });

    const res = await auth.put(`/v1/weeks/${WEEK_ISO}`).send(validWeekBody);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("response includes id === weekIso (synthesised)", async () => {
    prismaMock.week.upsert.mockResolvedValue({ ...weekFixture, ...validWeekBody });

    const res = await auth.put(`/v1/weeks/${WEEK_ISO}`).send(validWeekBody);

    expect(res.body.data.id).toBe(WEEK_ISO);
    expect(res.body.data.weekIso).toBe(WEEK_ISO);
  });

  it("calls upsert with composite where key { userId_weekIso: { userId, weekIso } }", async () => {
    prismaMock.week.upsert.mockResolvedValue(weekFixture);

    await auth.put(`/v1/weeks/${WEEK_ISO}`).send(validWeekBody);

    const [args] = prismaMock.week.upsert.mock.calls[0];
    expect(args.where).toEqual({
      userId_weekIso: { userId: TEST_USER_ID, weekIso: WEEK_ISO },
    });
  });

  it("userId on the create path always comes from the token, not the body", async () => {
    prismaMock.week.upsert.mockResolvedValue(weekFixture);

    await auth
      .put(`/v1/weeks/${WEEK_ISO}`)
      .send({ ...validWeekBody, userId: "injected-attacker" });

    const [args] = prismaMock.week.upsert.mock.calls[0];
    expect(args.create.userId).toBe(TEST_USER_ID);
  });

  it("weekIso on the create path comes from the route param, not the body", async () => {
    prismaMock.week.upsert.mockResolvedValue(weekFixture);

    await auth
      .put(`/v1/weeks/${WEEK_ISO}`)
      .send({ ...validWeekBody, weekIso: "2099-W01" });

    const [args] = prismaMock.week.upsert.mock.calls[0];
    expect(args.create.weekIso).toBe(WEEK_ISO);
  });

  it("returns 400 when weekIso param format is invalid", async () => {
    const res = await auth.put("/v1/weeks/bad-week").send(validWeekBody);
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("accepts an empty body (all week fields are optional)", async () => {
    prismaMock.week.upsert.mockResolvedValue(weekFixture);

    const res = await auth.put(`/v1/weeks/${WEEK_ISO}`).send({});
    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /:weekIso — no route (weeks are never deleted)
// ─────────────────────────────────────────────────────────────────────────────

describe("weeks — no DELETE route", () => {
  it("DELETE /:weekIso returns 404 (route does not exist)", async () => {
    const res = await auth.delete(`/v1/weeks/${WEEK_ISO}`);
    expect(res.status).toBe(404);
  });
});
