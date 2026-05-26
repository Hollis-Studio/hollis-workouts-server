/**
 * Tests for GET / + PUT / on /v1/conversation-rolling-summary
 *
 * Resource characteristics:
 *   - Per-user SINGLETON — PK = userId (no `:id` param in any URL)
 *   - GET /: findUnique({ where: { userId } }); returns 404 (Option A) when no row
 *   - PUT /: Prisma upsert({ where: { userId } }); userId always from token; 200 (not 201)
 *   - `entries` array body field validated — each entry requires weekIso, summary,
 *     retainedFacts, createdAt; malformed entries → 400
 *   - No POST, PATCH, or DELETE routes exist
 *
 * Test coverage:
 *   - 401 when unauthenticated (GET /, PUT /)
 *   - GET / — findUnique args, 404 on null, 200 with data when row found
 *   - PUT / — 200, upsert where { userId } from token, entries validation, 400 on malformed
 */

import { describe, it, expect, beforeAll } from "vitest";
import type { Express } from "express";
import type { SuperTest, Test } from "supertest";
import { prismaMock, buildApp, authedAgent, anonAgent, TEST_USER_ID } from "../helpers/setup.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const validEntry = {
  weekIso: "2025-W20",
  summary: "Great week — hit all PRs.",
  retainedFacts: ["Bench press improving", "Needs more sleep"],
  createdAt: "2025-05-18T10:00:00Z",
};

const summaryFixture = {
  userId: TEST_USER_ID,
  entries: [validEntry],
  updatedAt: new Date("2025-05-18T10:00:00Z"),
};

const validSummaryBody = {
  entries: [validEntry],
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

describe("conversation-rolling-summary — authentication", () => {
  it("GET / returns 401 when unauthenticated", async () => {
    const res = await anon.get("/v1/conversation-rolling-summary");
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it("PUT / returns 401 when unauthenticated", async () => {
    const res = await anon.put("/v1/conversation-rolling-summary").send(validSummaryBody);
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET / — fetch singleton
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/conversation-rolling-summary", () => {
  it("calls findUnique with where: { userId } from the token", async () => {
    prismaMock.conversationRollingSummary.findUnique.mockResolvedValue(summaryFixture);

    await auth.get("/v1/conversation-rolling-summary");

    const [args] = prismaMock.conversationRollingSummary.findUnique.mock.calls[0];
    expect(args.where).toEqual({ userId: TEST_USER_ID });
  });

  it("returns 200 and the summary document when the row exists", async () => {
    prismaMock.conversationRollingSummary.findUnique.mockResolvedValue(summaryFixture);

    const res = await auth.get("/v1/conversation-rolling-summary");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.userId).toBe(TEST_USER_ID);
  });

  it("returns 404 (Option A) when no row exists for the user yet", async () => {
    prismaMock.conversationRollingSummary.findUnique.mockResolvedValue(null);

    const res = await auth.get("/v1/conversation-rolling-summary");

    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.err.code).toBe("NOT_FOUND");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT / — upsert singleton (idempotent, 200)
// ─────────────────────────────────────────────────────────────────────────────

describe("PUT /v1/conversation-rolling-summary", () => {
  it("returns 200 (idempotent singleton upsert, not 201)", async () => {
    prismaMock.conversationRollingSummary.upsert.mockResolvedValue(summaryFixture);

    const res = await auth.put("/v1/conversation-rolling-summary").send(validSummaryBody);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("calls upsert with where: { userId } scoped to the token", async () => {
    prismaMock.conversationRollingSummary.upsert.mockResolvedValue(summaryFixture);

    await auth.put("/v1/conversation-rolling-summary").send(validSummaryBody);

    const [args] = prismaMock.conversationRollingSummary.upsert.mock.calls[0];
    expect(args.where).toEqual({ userId: TEST_USER_ID });
  });

  it("create path sets userId from the token, never from the body", async () => {
    prismaMock.conversationRollingSummary.upsert.mockResolvedValue(summaryFixture);

    await auth
      .put("/v1/conversation-rolling-summary")
      .send({ ...validSummaryBody, userId: "injected-attacker" });

    const [args] = prismaMock.conversationRollingSummary.upsert.mock.calls[0];
    expect(args.create.userId).toBe(TEST_USER_ID);
  });

  it("returns 200 and the upserted summary document", async () => {
    prismaMock.conversationRollingSummary.upsert.mockResolvedValue(summaryFixture);

    const res = await auth.put("/v1/conversation-rolling-summary").send(validSummaryBody);

    expect(res.body.data.userId).toBe(TEST_USER_ID);
  });

  it("returns 400 when entries is missing from the body", async () => {
    const res = await auth
      .put("/v1/conversation-rolling-summary")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when entries is not an array", async () => {
    const res = await auth
      .put("/v1/conversation-rolling-summary")
      .send({ entries: "not-an-array" });

    expect(res.status).toBe(400);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when an entry is missing the required summary field", async () => {
    const malformedEntry = {
      weekIso: "2025-W20",
      // summary missing
      retainedFacts: [],
      createdAt: "2025-05-18T10:00:00Z",
    };

    const res = await auth
      .put("/v1/conversation-rolling-summary")
      .send({ entries: [malformedEntry] });

    expect(res.status).toBe(400);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when an entry has an invalid weekIso format", async () => {
    const badEntry = {
      ...validEntry,
      weekIso: "not-a-week",
    };

    const res = await auth
      .put("/v1/conversation-rolling-summary")
      .send({ entries: [badEntry] });

    expect(res.status).toBe(400);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when an entry has an invalid createdAt (not ISO datetime)", async () => {
    const badEntry = {
      ...validEntry,
      createdAt: "not-a-date",
    };

    const res = await auth
      .put("/v1/conversation-rolling-summary")
      .send({ entries: [badEntry] });

    expect(res.status).toBe(400);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when retainedFacts is not an array of strings", async () => {
    const badEntry = {
      ...validEntry,
      retainedFacts: "should-be-array",
    };

    const res = await auth
      .put("/v1/conversation-rolling-summary")
      .send({ entries: [badEntry] });

    expect(res.status).toBe(400);
  });

  it("accepts an empty entries array (clearing all entries is valid)", async () => {
    prismaMock.conversationRollingSummary.upsert.mockResolvedValue({
      ...summaryFixture,
      entries: [],
    });

    const res = await auth
      .put("/v1/conversation-rolling-summary")
      .send({ entries: [] });

    expect(res.status).toBe(200);
  });
});
