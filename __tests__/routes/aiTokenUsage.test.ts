/**
 * Tests for GET / + PUT /:month on /v1/ai-token-usage
 *
 * Resource characteristics:
 *   - Keyed by (userId, month) — unique constraint; surrogate `id` PK
 *   - GET /: list user's monthly entries; optional ?month= filter
 *   - PUT /:month: upsert with MERGE semantics (token counts are ADDED, not replaced)
 *   - userId always from token; month from URL param (validated as yyyy-mm)
 *
 * Test coverage:
 *   - 401 when unauthenticated
 *   - GET / — user-scoping, ?month= filter
 *   - PUT /:month — 200 on update (merge), 200 on create path; token merge logic;
 *     400 on invalid month; 400 on invalid body; IDOR userId from token
 *
 * Mount strategy: local mini-app (routes not yet in index.ts; integration agent wires).
 */

import { describe, it, expect, beforeAll } from "vitest";
import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import type { SuperTest, Test } from "supertest";
import { prismaMock, authedAgent, anonAgent, TEST_USER_ID } from "../helpers/setup.js";
import { aiTokenUsageRouter } from "../../src/routes/aiTokenUsage.js";
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

  app.use("/v1/ai-token-usage", aiTokenUsageRouter);
  app.use((_req: Request, res: Response) => { sendError(res, "Not found", 404, "NOT_FOUND"); });
  app.use(errorHandler);
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const usageFixture = {
  id: "usage-uuid-001",
  userId: TEST_USER_ID,
  month: "2025-05",
  tokens: { smart_builder: 1200, plateau_coach: 400 },
  createdAt: new Date("2025-05-01T00:00:00Z"),
  updatedAt: new Date("2025-05-15T00:00:00Z"),
};

const validTokenBody = {
  tokens: { smart_builder: 200, plateau_coach: 50 },
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

describe("ai-token-usage — authentication", () => {
  it("GET / returns 401 when unauthenticated", async () => {
    const res = await anon.get("/v1/ai-token-usage");
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it("PUT /:month returns 401 when unauthenticated", async () => {
    const res = await anon.put("/v1/ai-token-usage/2025-05").send(validTokenBody);
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET / — list entries
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/ai-token-usage", () => {
  it("returns 200 and scopes to the authenticated user", async () => {
    prismaMock.aiTokenUsage.findMany.mockResolvedValue([usageFixture]);

    const res = await auth.get("/v1/ai-token-usage");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.items).toHaveLength(1);

    const [findArgs] = prismaMock.aiTokenUsage.findMany.mock.calls[0];
    expect(findArgs.where).toMatchObject({ userId: TEST_USER_ID });
  });

  it("applies ?month= filter to the where clause", async () => {
    prismaMock.aiTokenUsage.findMany.mockResolvedValue([usageFixture]);

    await auth.get("/v1/ai-token-usage?month=2025-05");

    const [findArgs] = prismaMock.aiTokenUsage.findMany.mock.calls[0];
    expect(findArgs.where).toMatchObject({ userId: TEST_USER_ID, month: "2025-05" });
  });

  it("returns 400 when ?month= is an invalid format", async () => {
    const res = await auth.get("/v1/ai-token-usage?month=May-2025");

    expect(res.status).toBe(400);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /:month — upsert with merge semantics
// ─────────────────────────────────────────────────────────────────────────────

describe("PUT /v1/ai-token-usage/:month", () => {
  it("returns 200 on the CREATE path (no existing row)", async () => {
    prismaMock.aiTokenUsage.findUnique.mockResolvedValue(null);
    prismaMock.aiTokenUsage.create.mockResolvedValue(usageFixture);

    const res = await auth.put("/v1/ai-token-usage/2025-05").send(validTokenBody);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(prismaMock.aiTokenUsage.create).toHaveBeenCalledOnce();
    expect(prismaMock.aiTokenUsage.update).not.toHaveBeenCalled();
  });

  it("returns 200 on the UPDATE path (existing row — merge)", async () => {
    prismaMock.aiTokenUsage.findUnique.mockResolvedValue(usageFixture);
    prismaMock.aiTokenUsage.update.mockResolvedValue(usageFixture);

    const res = await auth.put("/v1/ai-token-usage/2025-05").send(validTokenBody);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(prismaMock.aiTokenUsage.update).toHaveBeenCalledOnce();
    expect(prismaMock.aiTokenUsage.create).not.toHaveBeenCalled();
  });

  it("merges token counts (existing + incoming) on the update path", async () => {
    const existingRow = {
      ...usageFixture,
      tokens: { smart_builder: 1000, plateau_coach: 300 },
    };
    prismaMock.aiTokenUsage.findUnique.mockResolvedValue(existingRow);
    prismaMock.aiTokenUsage.update.mockResolvedValue(usageFixture);

    await auth.put("/v1/ai-token-usage/2025-05").send({
      tokens: { smart_builder: 200, plateau_coach: 50 },
    });

    const [updateArgs] = prismaMock.aiTokenUsage.update.mock.calls[0];
    const mergedTokens = updateArgs.data.tokens as Record<string, number>;
    // 1000 + 200 = 1200; 300 + 50 = 350
    expect(mergedTokens.smart_builder).toBe(1200);
    expect(mergedTokens.plateau_coach).toBe(350);
  });

  it("sets userId from the token on create, never from body", async () => {
    prismaMock.aiTokenUsage.findUnique.mockResolvedValue(null);
    prismaMock.aiTokenUsage.create.mockResolvedValue(usageFixture);

    await auth
      .put("/v1/ai-token-usage/2025-05")
      .send({ ...validTokenBody, userId: "injected-attacker" });

    const [createArgs] = prismaMock.aiTokenUsage.create.mock.calls[0];
    expect(createArgs.data.userId).toBe(TEST_USER_ID);
  });

  it("scopes findUnique to (userId, month) so another user's row is not merged", async () => {
    prismaMock.aiTokenUsage.findUnique.mockResolvedValue(null);
    prismaMock.aiTokenUsage.create.mockResolvedValue(usageFixture);

    await auth.put("/v1/ai-token-usage/2025-05").send(validTokenBody);

    const [findArgs] = prismaMock.aiTokenUsage.findUnique.mock.calls[0];
    expect(findArgs.where).toMatchObject({ userId_month: { userId: TEST_USER_ID, month: "2025-05" } });
  });

  it("returns 400 when month param is invalid (not yyyy-mm)", async () => {
    const res = await auth.put("/v1/ai-token-usage/May-2025").send(validTokenBody);

    expect(res.status).toBe(400);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when tokens is missing from body", async () => {
    const res = await auth.put("/v1/ai-token-usage/2025-05").send({});

    expect(res.status).toBe(400);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when tokens contains a negative value", async () => {
    const res = await auth.put("/v1/ai-token-usage/2025-05").send({
      tokens: { smart_builder: -1 },
    });

    expect(res.status).toBe(400);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when tokens contains a non-integer value", async () => {
    const res = await auth.put("/v1/ai-token-usage/2025-05").send({
      tokens: { smart_builder: 1.5 },
    });

    expect(res.status).toBe(400);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });
});
