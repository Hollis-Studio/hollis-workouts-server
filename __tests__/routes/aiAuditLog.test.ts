/**
 * Exemplar tests for GET/POST /v1/ai-audit-log
 *
 * Resource characteristics:
 *   - Immutable append-only log — POST creates, GET reads; no PUT/PATCH/DELETE
 *   - Server assigns the id via crypto.randomUUID() — client must NOT supply one
 *   - userId always comes from req.userId (token), never from the body
 *   - timestamp is ALWAYS server-assigned (new Date()); client-supplied values are
 *     ignored to prevent backdating that would evade the ?since filter
 *   - Flattened JSON columns: sourceRef, snapshotInline, aiOutput, diff
 *   - GET supports filters: ?since=<ISO> ?surface=<string> ?limit=<n>
 *
 * Test coverage:
 *   - 401 for GET and POST when unauthenticated
 *   - GET / — user-scoping; ?since and ?surface filters; limit default
 *   - POST / — 201 happy-path; server assigns id; user-scoping in create call
 *   - POST / — 400 on invalid body (missing required fields, invalid enum)
 *   - Absent routes — PUT/PATCH/DELETE return 404 (immutability contract)
 */

import { describe, it, expect, beforeAll } from "vitest";
import type { Express } from "express";
import type { SuperTest, Test } from "supertest";
import { prismaMock, buildApp, authedAgent, anonAgent, TEST_USER_ID } from "../helpers/setup.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const LOG_ID = "server-assigned-uuid";

const logEntryFixture = {
  id: LOG_ID,
  userId: TEST_USER_ID,
  timestamp: new Date("2025-06-01T12:00:00Z"),
  surface: "weight_recommendation",
  modelTier: "flash",
  snapshotRef: null,
  action: "auto_applied",
  persisted: true,
  sourceRef: { type: "session", id: "session-1" },
  snapshotInline: null,
  aiOutput: { suggestions: [] },
  diff: null,
};

const validLogBody = {
  surface: "weight_recommendation",
  modelTier: "flash",
  action: "auto_applied",
  persisted: true,
  sourceRef: { type: "session", id: "session-1" },
  aiOutput: { suggestions: [] },
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

describe("ai-audit-log — authentication", () => {
  it("GET / returns 401 when unauthenticated", async () => {
    const res = await anon.get("/v1/ai-audit-log");
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it("POST / returns 401 when unauthenticated", async () => {
    const res = await anon.post("/v1/ai-audit-log").send(validLogBody);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET / — list entries
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/ai-audit-log", () => {
  it("returns 200 and scopes findMany to the authenticated user", async () => {
    prismaMock.aiAuditLogEntry.findMany.mockResolvedValue([logEntryFixture]);

    const res = await auth.get("/v1/ai-audit-log");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.items).toHaveLength(1);

    const [args] = prismaMock.aiAuditLogEntry.findMany.mock.calls[0];
    expect(args.where).toMatchObject({ userId: TEST_USER_ID });
  });

  it("applies the ?surface filter", async () => {
    prismaMock.aiAuditLogEntry.findMany.mockResolvedValue([]);

    await auth.get("/v1/ai-audit-log?surface=weight_recommendation");

    const [args] = prismaMock.aiAuditLogEntry.findMany.mock.calls[0];
    expect(args.where).toMatchObject({ surface: "weight_recommendation" });
  });

  it("applies the ?since filter as a Date gte clause", async () => {
    prismaMock.aiAuditLogEntry.findMany.mockResolvedValue([]);

    await auth.get("/v1/ai-audit-log?since=2025-06-01T00:00:00Z");

    const [args] = prismaMock.aiAuditLogEntry.findMany.mock.calls[0];
    expect(args.where.timestamp).toBeDefined();
    expect(args.where.timestamp.gte).toBeInstanceOf(Date);
  });

  it("applies a default limit of 50", async () => {
    prismaMock.aiAuditLogEntry.findMany.mockResolvedValue([]);

    await auth.get("/v1/ai-audit-log");

    const [args] = prismaMock.aiAuditLogEntry.findMany.mock.calls[0];
    expect(args.take).toBe(50);
  });

  it("returns 400 when ?since is not a valid datetime", async () => {
    const res = await auth.get("/v1/ai-audit-log?since=not-a-date");
    expect(res.status).toBe(400);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST / — create entry (server assigns id)
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /v1/ai-audit-log", () => {
  it("returns 201 and the created entry", async () => {
    prismaMock.aiAuditLogEntry.create.mockResolvedValue(logEntryFixture);

    const res = await auth.post("/v1/ai-audit-log").send(validLogBody);

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.id).toBe(LOG_ID);
  });

  it("server assigns the id — create is called with a UUID, not a client-supplied id", async () => {
    prismaMock.aiAuditLogEntry.create.mockResolvedValue(logEntryFixture);

    await auth.post("/v1/ai-audit-log").send(validLogBody);

    const [args] = prismaMock.aiAuditLogEntry.create.mock.calls[0];
    // id must be present and be a UUID (server-generated)
    expect(typeof args.data.id).toBe("string");
    expect(args.data.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("userId always comes from the token, not the body", async () => {
    prismaMock.aiAuditLogEntry.create.mockResolvedValue(logEntryFixture);

    await auth
      .post("/v1/ai-audit-log")
      .send({ ...validLogBody, userId: "injected-by-attacker" });

    const [args] = prismaMock.aiAuditLogEntry.create.mock.calls[0];
    expect(args.data.userId).toBe(TEST_USER_ID);
  });

  it("uses current time as timestamp when the body omits it", async () => {
    prismaMock.aiAuditLogEntry.create.mockResolvedValue(logEntryFixture);

    const before = new Date();
    await auth.post("/v1/ai-audit-log").send(validLogBody);
    const after = new Date();

    const [args] = prismaMock.aiAuditLogEntry.create.mock.calls[0];
    expect(args.data.timestamp).toBeInstanceOf(Date);
    expect(args.data.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime() - 100);
    expect(args.data.timestamp.getTime()).toBeLessThanOrEqual(after.getTime() + 100);
  });

  it("ignores any client-supplied timestamp — server always assigns its own", async () => {
    // The audit log schema intentionally omits `timestamp` (see aiAuditLog.ts NOTE).
    // Clients cannot backdate entries to evade the ?since filter.
    prismaMock.aiAuditLogEntry.create.mockResolvedValue(logEntryFixture);

    const clientTimestamp = "2025-01-15T10:30:00Z"; // deliberately old
    const before = new Date();
    await auth
      .post("/v1/ai-audit-log")
      .send({ ...validLogBody, timestamp: clientTimestamp });
    const after = new Date();

    const [args] = prismaMock.aiAuditLogEntry.create.mock.calls[0];
    // Server-assigned timestamp must be ≈ now, NOT the client-backdated value
    expect(args.data.timestamp).toBeInstanceOf(Date);
    expect(args.data.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime() - 100);
    expect(args.data.timestamp.getTime()).toBeLessThanOrEqual(after.getTime() + 100);
    // Confirm it is definitely NOT the client-supplied value
    expect(args.data.timestamp).not.toEqual(new Date(clientTimestamp));
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await auth
      .post("/v1/ai-audit-log")
      .send({ surface: "weight_recommendation" }); // missing modelTier, action, persisted, sourceRef, aiOutput

    expect(res.status).toBe(400);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when modelTier is not one of flash|pro|image", async () => {
    const res = await auth
      .post("/v1/ai-audit-log")
      .send({ ...validLogBody, modelTier: "turbo" }); // invalid enum value

    expect(res.status).toBe(400);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when action is not a valid enum value", async () => {
    const res = await auth
      .post("/v1/ai-audit-log")
      .send({ ...validLogBody, action: "user_liked" }); // not in enum

    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Immutability contract — no PUT/PATCH/DELETE routes exist
// ─────────────────────────────────────────────────────────────────────────────

describe("ai-audit-log — immutability (no mutating verbs on existing entries)", () => {
  it("PUT /v1/ai-audit-log/:id returns 404 (route does not exist)", async () => {
    const res = await auth.put(`/v1/ai-audit-log/${LOG_ID}`).send(validLogBody);
    expect(res.status).toBe(404);
  });

  it("PATCH /v1/ai-audit-log/:id returns 404 (route does not exist)", async () => {
    const res = await auth.patch(`/v1/ai-audit-log/${LOG_ID}`);
    expect(res.status).toBe(404);
  });

  it("DELETE /v1/ai-audit-log/:id returns 404 (route does not exist)", async () => {
    const res = await auth.delete(`/v1/ai-audit-log/${LOG_ID}`);
    expect(res.status).toBe(404);
  });
});
