/**
 * Tests for GET / + POST / on /v1/cancellation-feedback
 *
 * Resource characteristics:
 *   - Append-only immutable log; no PUT/PATCH/DELETE
 *   - POST /: server assigns id (crypto.randomUUID()); createdAt = server time
 *   - GET  /: list user's entries (most recent first), paginated
 *   - Mirrors immutable pattern of aiAuditLog
 *
 * Test coverage:
 *   - 401 when unauthenticated (GET /, POST /)
 *   - GET / — user-scoping (findMany called with userId), pagination
 *   - POST / — 201 on create; userId from token; server assigns id/createdAt; validation
 *   - No PUT/PATCH/DELETE routes exposed
 *
 * Mount strategy: local mini-app (routes not yet in index.ts; integration agent wires).
 */

import { describe, it, expect, beforeAll } from "vitest";
import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import type { SuperTest, Test } from "supertest";
import { prismaMock, authedAgent, anonAgent, TEST_USER_ID } from "../helpers/setup.js";
import { cancellationFeedbackRouter } from "../../src/routes/cancellationFeedback.js";
import { errorHandler } from "../../src/middleware/errorHandler.js";
import { sendError } from "../../src/utils/response.js";

// ─────────────────────────────────────────────────────────────────────────────
// Local mini-app
// ─────────────────────────────────────────────────────────────────────────────

function buildLocalApp(): Express {
  const app = express();
  app.use(express.json());

  app.use((req: Request, res: Response, next: NextFunction) => {
    const header = req.headers["authorization"];
    if (!header) {
      res.status(401).json({ ok: false, err: { code: "UNAUTHORIZED", message: "Unauthorized" } });
      return;
    }
    req.userId = header;
    next();
  });

  app.use("/v1/cancellation-feedback", cancellationFeedbackRouter);
  app.use((_req: Request, res: Response) => { sendError(res, "Not found", 404, "NOT_FOUND"); });
  app.use(errorHandler);
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const feedbackFixture = {
  id: "server-assigned-uuid-001",
  userId: TEST_USER_ID,
  option: "too_expensive",
  detail: "Price is too high for my budget",
  createdAt: new Date("2025-05-01T10:00:00Z"),
};

const validFeedbackBody = {
  option: "too_expensive",
  detail: "Price is too high for my budget",
};

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

let app: Express;
let auth: SuperTest<Test>;
let anon: SuperTest<Test>;

beforeAll(async () => {
  app = buildLocalApp();
  auth = await authedAgent(app);
  anon = await anonAgent(app);
});

// ─────────────────────────────────────────────────────────────────────────────
// Authentication guard
// ─────────────────────────────────────────────────────────────────────────────

describe("cancellation-feedback — authentication", () => {
  it("GET / returns 401 when unauthenticated", async () => {
    const res = await anon.get("/v1/cancellation-feedback");
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it("POST / returns 401 when unauthenticated", async () => {
    const res = await anon.post("/v1/cancellation-feedback").send(validFeedbackBody);
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET / — list entries
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/cancellation-feedback", () => {
  it("returns 200 and scopes the query to the authenticated user", async () => {
    prismaMock.cancellationFeedback.findMany.mockResolvedValue([feedbackFixture]);

    const res = await auth.get("/v1/cancellation-feedback");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].option).toBe("too_expensive");

    const [findArgs] = prismaMock.cancellationFeedback.findMany.mock.calls[0];
    expect(findArgs.where).toMatchObject({ userId: TEST_USER_ID });
  });

  it("returns empty items array when user has no entries", async () => {
    prismaMock.cancellationFeedback.findMany.mockResolvedValue([]);

    const res = await auth.get("/v1/cancellation-feedback");
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST / — append-only create
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /v1/cancellation-feedback", () => {
  it("returns 201 on successful creation", async () => {
    prismaMock.cancellationFeedback.create.mockResolvedValue(feedbackFixture);

    const res = await auth.post("/v1/cancellation-feedback").send(validFeedbackBody);

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.option).toBe("too_expensive");
  });

  it("userId in create data comes from the token, never from body", async () => {
    prismaMock.cancellationFeedback.create.mockResolvedValue(feedbackFixture);

    await auth
      .post("/v1/cancellation-feedback")
      .send({ ...validFeedbackBody, userId: "injected-attacker" });

    const [createArgs] = prismaMock.cancellationFeedback.create.mock.calls[0];
    expect(createArgs.data.userId).toBe(TEST_USER_ID);
  });

  it("server assigns id (create.data.id is a non-empty string, not from body)", async () => {
    prismaMock.cancellationFeedback.create.mockResolvedValue(feedbackFixture);

    await auth.post("/v1/cancellation-feedback").send(validFeedbackBody);

    const [createArgs] = prismaMock.cancellationFeedback.create.mock.calls[0];
    expect(typeof createArgs.data.id).toBe("string");
    expect(createArgs.data.id.length).toBeGreaterThan(0);
  });

  it("server assigns createdAt (not accepted from body)", async () => {
    prismaMock.cancellationFeedback.create.mockResolvedValue(feedbackFixture);

    await auth.post("/v1/cancellation-feedback").send({
      ...validFeedbackBody,
      createdAt: "2000-01-01T00:00:00Z",
    });

    const [createArgs] = prismaMock.cancellationFeedback.create.mock.calls[0];
    // createdAt must be a Date close to now, not 2000
    expect(createArgs.data.createdAt).toBeInstanceOf(Date);
    const ageMs = Date.now() - (createArgs.data.createdAt as Date).getTime();
    expect(ageMs).toBeLessThan(5000); // within 5 seconds of now
  });

  it("returns 400 when option is missing", async () => {
    const res = await auth.post("/v1/cancellation-feedback").send({ detail: "some detail" });

    expect(res.status).toBe(400);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when option is empty string", async () => {
    const res = await auth.post("/v1/cancellation-feedback").send({ option: "" });

    expect(res.status).toBe(400);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });

  it("accepts null detail (detail is optional)", async () => {
    prismaMock.cancellationFeedback.create.mockResolvedValue({
      ...feedbackFixture,
      detail: null,
    });

    const res = await auth.post("/v1/cancellation-feedback").send({
      option: "too_expensive",
      detail: null,
    });

    expect(res.status).toBe(201);
  });

  it("does NOT expose a PUT route", async () => {
    const res = await auth.put("/v1/cancellation-feedback/some-id").send(validFeedbackBody);
    expect(res.status).toBe(404);
  });

  it("does NOT expose a DELETE route", async () => {
    const res = await auth.delete("/v1/cancellation-feedback/some-id");
    expect(res.status).toBe(404);
  });
});
