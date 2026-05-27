/**
 * Tests for GET / + GET /:id + PUT /:id + DELETE /:id on /v1/plateau-coaching
 *
 * Resource characteristics:
 *   - Standard per-row collection produced by createCrudRouter() factory
 *   - DELETE style: hard
 *   - Optional ?exerciseId= filter on GET /
 *   - Client-provided UUID on PUT /:id; IDOR-safe two-step upsert
 *
 * Test coverage:
 *   - 401 when unauthenticated (GET /, PUT /:id, DELETE /:id)
 *   - GET / — user-scoping, optional exerciseId filter
 *   - GET /:id — 200 when found, 404 when absent
 *   - PUT /:id — 201 create, 200 update, IDOR, validation
 *   - DELETE /:id — 200 when found, 404 when absent, IDOR
 *
 * Mount strategy: local mini-app (routes not yet in index.ts).
 */

import { describe, it, expect, beforeAll } from "vitest";
import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import type { SuperTest, Test } from "supertest";
import { prismaMock, authedAgent, anonAgent, TEST_USER_ID } from "../helpers/setup.js";
import { plateauCoachingRouter } from "../../src/routes/plateauCoaching.js";
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

  app.use("/v1/plateau-coaching", plateauCoachingRouter);
  app.use((_req: Request, res: Response) => { sendError(res, "Not found", 404, "NOT_FOUND"); });
  app.use(errorHandler);
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const ARTIFACT_ID = "plateau-artifact-001";

const artifactFixture = {
  id: ARTIFACT_ID,
  userId: TEST_USER_ID,
  exerciseId: "barbell_squat",
  detectedAt: new Date("2025-04-01T00:00:00Z"),
  narrative: "Your squat has been stalled for 3 weeks.",
  rootCauses: ["insufficient_deload", "volume_accumulation"],
  recommendations: ["reduce_volume_10pct", "add_deload_week"],
  dismissedAt: null,
  tokenCount: { input: 400, output: 200 },
  createdAt: new Date("2025-04-01T00:00:00Z"),
  updatedAt: new Date("2025-04-01T00:00:00Z"),
};

const validArtifactBody = {
  exerciseId: "barbell_squat",
  detectedAt: "2025-04-01T00:00:00Z",
  narrative: "Your squat has been stalled for 3 weeks.",
  rootCauses: ["insufficient_deload"],
  recommendations: ["add_deload_week"],
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

describe("plateau-coaching — authentication", () => {
  it("GET / returns 401 when unauthenticated", async () => {
    const res = await anon.get("/v1/plateau-coaching");
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it("PUT /:id returns 401 when unauthenticated", async () => {
    const res = await anon.put(`/v1/plateau-coaching/${ARTIFACT_ID}`).send(validArtifactBody);
    expect(res.status).toBe(401);
  });

  it("DELETE /:id returns 401 when unauthenticated", async () => {
    const res = await anon.delete(`/v1/plateau-coaching/${ARTIFACT_ID}`);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET / — list
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/plateau-coaching", () => {
  it("returns 200 and scopes to the authenticated user", async () => {
    prismaMock.plateauCoachingArtifact.findMany.mockResolvedValue([artifactFixture]);

    const res = await auth.get("/v1/plateau-coaching");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.items).toHaveLength(1);

    const [findArgs] = prismaMock.plateauCoachingArtifact.findMany.mock.calls[0];
    expect(findArgs.where).toMatchObject({ userId: TEST_USER_ID });
  });

  it("applies ?exerciseId= filter", async () => {
    prismaMock.plateauCoachingArtifact.findMany.mockResolvedValue([artifactFixture]);

    await auth.get("/v1/plateau-coaching?exerciseId=barbell_squat");

    const [findArgs] = prismaMock.plateauCoachingArtifact.findMany.mock.calls[0];
    expect(findArgs.where).toMatchObject({ userId: TEST_USER_ID, exerciseId: "barbell_squat" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:id — single resource
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/plateau-coaching/:id", () => {
  it("returns 200 when found and userId-scoped", async () => {
    prismaMock.plateauCoachingArtifact.findFirst.mockResolvedValue(artifactFixture);

    const res = await auth.get(`/v1/plateau-coaching/${ARTIFACT_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(ARTIFACT_ID);

    const [findArgs] = prismaMock.plateauCoachingArtifact.findFirst.mock.calls[0];
    expect(findArgs.where).toMatchObject({ id: ARTIFACT_ID, userId: TEST_USER_ID });
  });

  it("returns 404 when absent", async () => {
    prismaMock.plateauCoachingArtifact.findFirst.mockResolvedValue(null);

    const res = await auth.get(`/v1/plateau-coaching/${ARTIFACT_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.err.code).toBe("NOT_FOUND");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /:id — idempotent upsert
// ─────────────────────────────────────────────────────────────────────────────

describe("PUT /v1/plateau-coaching/:id", () => {
  it("returns 201 on the CREATE path", async () => {
    prismaMock.plateauCoachingArtifact.findFirst.mockResolvedValue(null);
    prismaMock.plateauCoachingArtifact.create.mockResolvedValue(artifactFixture);

    const res = await auth
      .put(`/v1/plateau-coaching/${ARTIFACT_ID}`)
      .send(validArtifactBody);

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(prismaMock.plateauCoachingArtifact.create).toHaveBeenCalledOnce();
  });

  it("returns 200 on the UPDATE path", async () => {
    prismaMock.plateauCoachingArtifact.findFirst.mockResolvedValue(artifactFixture);
    prismaMock.plateauCoachingArtifact.update.mockResolvedValue(artifactFixture);

    const res = await auth
      .put(`/v1/plateau-coaching/${ARTIFACT_ID}`)
      .send(validArtifactBody);

    expect(res.status).toBe(200);
    expect(prismaMock.plateauCoachingArtifact.update).toHaveBeenCalledOnce();
  });

  it("IDOR: findFirst scoped to { id, userId } from the token", async () => {
    prismaMock.plateauCoachingArtifact.findFirst.mockResolvedValue(null);
    prismaMock.plateauCoachingArtifact.create.mockResolvedValue(artifactFixture);

    await auth.put(`/v1/plateau-coaching/${ARTIFACT_ID}`).send(validArtifactBody);

    const [findArgs] = prismaMock.plateauCoachingArtifact.findFirst.mock.calls[0];
    expect(findArgs.where).toMatchObject({ id: ARTIFACT_ID, userId: TEST_USER_ID });
  });

  it("returns 400 when exerciseId is missing", async () => {
    const res = await auth.put(`/v1/plateau-coaching/${ARTIFACT_ID}`).send({
      narrative: "stalled",
      rootCauses: [],
      recommendations: [],
      detectedAt: "2025-04-01T00:00:00Z",
    });

    expect(res.status).toBe(400);
    expect(res.body.err.code).toBe("VALIDATION_ERROR");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /:id — hard delete
// ─────────────────────────────────────────────────────────────────────────────

describe("DELETE /v1/plateau-coaching/:id", () => {
  it("returns 200 and { deleted: true } when found", async () => {
    prismaMock.plateauCoachingArtifact.findFirst.mockResolvedValue(artifactFixture);
    prismaMock.plateauCoachingArtifact.delete.mockResolvedValue(artifactFixture);

    const res = await auth.delete(`/v1/plateau-coaching/${ARTIFACT_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);
  });

  it("IDOR: delete where clause includes userId from token", async () => {
    prismaMock.plateauCoachingArtifact.findFirst.mockResolvedValue(artifactFixture);
    prismaMock.plateauCoachingArtifact.delete.mockResolvedValue(artifactFixture);

    await auth.delete(`/v1/plateau-coaching/${ARTIFACT_ID}`);

    const [deleteArgs] = prismaMock.plateauCoachingArtifact.delete.mock.calls[0];
    expect(deleteArgs.where).toMatchObject({ id: ARTIFACT_ID, userId: TEST_USER_ID });
  });

  it("returns 404 and does NOT call delete when absent", async () => {
    prismaMock.plateauCoachingArtifact.findFirst.mockResolvedValue(null);

    const res = await auth.delete(`/v1/plateau-coaching/${ARTIFACT_ID}`);

    expect(res.status).toBe(404);
    expect(prismaMock.plateauCoachingArtifact.delete).not.toHaveBeenCalled();
  });
});
