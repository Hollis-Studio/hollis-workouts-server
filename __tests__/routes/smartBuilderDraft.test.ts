/**
 * Tests for GET / + PUT / + DELETE / on /v1/smart-builder-draft
 *
 * Resource characteristics:
 *   - Per-user SINGLETON — PK = userId (no `:id` param)
 *   - GET    /: findUnique({ where: { userId } }); returns 404 when absent
 *   - PUT    /: Prisma upsert({ where: { userId } }); userId always from token; 200
 *   - DELETE /: findUnique ownership check → delete({ where: { userId } })
 *   - `payload` Json blob validated against SmartBuilderDraftPayloadSchema
 *   - No POST or PATCH routes
 *
 * Test coverage:
 *   - 401 when unauthenticated (GET /, PUT /, DELETE /)
 *   - GET / — findUnique args, 404 on null, 200 with data
 *   - PUT / — 200, upsert where { userId } from token, payload validation, 400 on malformed
 *   - DELETE / — 200 when found, 404 when absent
 *   - IDOR: userId always comes from token, never from body
 *
 * Mount strategy: the routes are not wired in src/routes/index.ts yet (the
 * integration agent handles that).  This test file builds a local mini-app
 * that mounts the router directly so it can exercise the handler logic
 * independently of the wiring step.
 */

import { describe, it, expect, beforeAll } from "vitest";
import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import type { SuperTest, Test } from "supertest";
import { prismaMock, authedAgent, anonAgent, TEST_USER_ID } from "../helpers/setup.js";
import { smartBuilderDraftRouter } from "../../src/routes/smartBuilderDraft.js";
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

  app.use("/v1/smart-builder-draft", smartBuilderDraftRouter);
  app.use((_req: Request, res: Response) => { sendError(res, "Not found", 404, "NOT_FOUND"); });
  app.use(errorHandler);
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const validPayload = {
  conversationHistory: [
    { role: "user", content: "I want a 4-day program", timestamp: 1700000000000 },
  ],
  currentProgram: null,
  phase: "conversing",
  userAnswers: { experienceLevel: "intermediate", daysPerWeek: 4 },
  createdAt: 1700000000000,
  updatedAt: 1700000000001,
};

const draftFixture = {
  userId: TEST_USER_ID,
  payload: validPayload,
  createdAt: new Date("2025-01-01T00:00:00Z"),
  updatedAt: new Date("2025-01-01T00:00:00Z"),
};

const validDraftBody = { payload: validPayload };

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

describe("smart-builder-draft — authentication", () => {
  it("GET / returns 401 when unauthenticated", async () => {
    const res = await anon.get("/v1/smart-builder-draft");
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it("PUT / returns 401 when unauthenticated", async () => {
    const res = await anon.put("/v1/smart-builder-draft").send(validDraftBody);
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it("DELETE / returns 401 when unauthenticated", async () => {
    const res = await anon.delete("/v1/smart-builder-draft");
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET / — fetch singleton
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/smart-builder-draft", () => {
  it("calls findUnique with where: { userId } from the token", async () => {
    prismaMock.smartBuilderDraft.findUnique.mockResolvedValue(draftFixture);

    await auth.get("/v1/smart-builder-draft");

    const [args] = prismaMock.smartBuilderDraft.findUnique.mock.calls[0];
    expect(args.where).toEqual({ userId: TEST_USER_ID });
  });

  it("returns 200 and the draft document when the row exists", async () => {
    prismaMock.smartBuilderDraft.findUnique.mockResolvedValue(draftFixture);

    const res = await auth.get("/v1/smart-builder-draft");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.userId).toBe(TEST_USER_ID);
  });

  it("returns 404 when no draft exists for the user", async () => {
    prismaMock.smartBuilderDraft.findUnique.mockResolvedValue(null);

    const res = await auth.get("/v1/smart-builder-draft");

    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.err.code).toBe("NOT_FOUND");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT / — upsert singleton
// ─────────────────────────────────────────────────────────────────────────────

describe("PUT /v1/smart-builder-draft", () => {
  it("returns 200 (idempotent singleton upsert, not 201)", async () => {
    prismaMock.smartBuilderDraft.upsert.mockResolvedValue(draftFixture);

    const res = await auth.put("/v1/smart-builder-draft").send(validDraftBody);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("calls upsert with where: { userId } scoped to the token", async () => {
    prismaMock.smartBuilderDraft.upsert.mockResolvedValue(draftFixture);

    await auth.put("/v1/smart-builder-draft").send(validDraftBody);

    const [args] = prismaMock.smartBuilderDraft.upsert.mock.calls[0];
    expect(args.where).toEqual({ userId: TEST_USER_ID });
  });

  it("sets userId from the token on create, never from the body", async () => {
    prismaMock.smartBuilderDraft.upsert.mockResolvedValue(draftFixture);

    await auth
      .put("/v1/smart-builder-draft")
      .send({ ...validDraftBody, userId: "injected-attacker" });

    const [args] = prismaMock.smartBuilderDraft.upsert.mock.calls[0];
    expect(args.create.userId).toBe(TEST_USER_ID);
  });

  it("returns 400 when payload is missing", async () => {
    const res = await auth.put("/v1/smart-builder-draft").send({});

    expect(res.status).toBe(400);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when payload.phase is invalid", async () => {
    const res = await auth.put("/v1/smart-builder-draft").send({
      payload: { ...validPayload, phase: "invalid_phase" },
    });

    expect(res.status).toBe(400);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when conversationHistory has an invalid role", async () => {
    const res = await auth.put("/v1/smart-builder-draft").send({
      payload: {
        ...validPayload,
        conversationHistory: [{ role: "system", content: "hi", timestamp: 1 }],
      },
    });

    expect(res.status).toBe(400);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE / — clear the draft
// ─────────────────────────────────────────────────────────────────────────────

describe("DELETE /v1/smart-builder-draft", () => {
  it("returns 200 and { deleted: true } when the draft exists", async () => {
    prismaMock.smartBuilderDraft.findUnique.mockResolvedValue(draftFixture);
    prismaMock.smartBuilderDraft.delete.mockResolvedValue(draftFixture);

    const res = await auth.delete("/v1/smart-builder-draft");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.deleted).toBe(true);
  });

  it("IDOR: delete is scoped to userId from the token", async () => {
    prismaMock.smartBuilderDraft.findUnique.mockResolvedValue(draftFixture);
    prismaMock.smartBuilderDraft.delete.mockResolvedValue(draftFixture);

    await auth.delete("/v1/smart-builder-draft");

    const [findArgs] = prismaMock.smartBuilderDraft.findUnique.mock.calls[0];
    expect(findArgs.where).toEqual({ userId: TEST_USER_ID });

    const [deleteArgs] = prismaMock.smartBuilderDraft.delete.mock.calls[0];
    expect(deleteArgs.where).toEqual({ userId: TEST_USER_ID });
  });

  it("returns 404 and does NOT call delete when no draft exists", async () => {
    prismaMock.smartBuilderDraft.findUnique.mockResolvedValue(null);

    const res = await auth.delete("/v1/smart-builder-draft");

    expect(res.status).toBe(404);
    expect(res.body.err.code).toBe("NOT_FOUND");
    expect(prismaMock.smartBuilderDraft.delete).not.toHaveBeenCalled();
  });
});
