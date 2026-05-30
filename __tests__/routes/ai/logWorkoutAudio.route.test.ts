/**
 * Route contract tests for POST /v1/ai/log-workout-audio.
 *
 * Verifies that protocolVersion survives route validation and is forwarded to
 * the AI service, since that value selects legacy entries[] vs V2 operations[].
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import type { SuperTest, Test } from "supertest";
import { authedAgent, TEST_USER_ID } from "../../helpers/setup.js";
import { ok } from "@hollis-studio/contracts";
import { errorHandler } from "../../../src/middleware/errorHandler.js";

vi.mock("../../../src/middleware/entitlement.js", () => ({
  requireEntitlement: (_req: Request, _res: Response, next: NextFunction) => next(),
  checkHollisIntelligence: vi.fn(),
  clearEntitlementCacheForTests: vi.fn(),
}));

vi.mock("../../../src/services/ai/logWorkoutAudio.js", () => ({
  logWorkoutAudio: vi.fn(),
}));

import { logWorkoutAudioRouter } from "../../../src/routes/ai/logWorkoutAudio.js";
import { logWorkoutAudio } from "../../../src/services/ai/logWorkoutAudio.js";

const mockLogWorkoutAudio = vi.mocked(logWorkoutAudio);

const baseBody = {
  audioBase64: "ZmFrZS1hdWRpbw==",
  mimeType: "audio/m4a" as const,
  defaultWeightUnit: "kg" as const,
  exercises: [
    {
      exerciseIndex: 0,
      exerciseName: "Bench Press",
      canonicalExerciseId: "bench_press",
      trackingMode: "reps" as const,
      targetSetCount: 3,
      isActive: true,
      loggedSets: [],
    },
  ],
};

function buildLocalApp(): Express {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use((req: Request, res: Response, next: NextFunction) => {
    const header = req.headers["authorization"];
    if (!header) {
      res.status(401).json({ ok: false, err: { code: "UNAUTHORIZED", message: "Unauthorized" } });
      return;
    }
    req.userId = header;
    next();
  });
  app.use("/v1/ai/log-workout-audio", logWorkoutAudioRouter);
  app.use(errorHandler);
  return app;
}

let auth: SuperTest<Test>;

beforeAll(async () => {
  auth = await authedAgent(buildLocalApp());
});

beforeEach(() => {
  mockLogWorkoutAudio.mockReset();
});

describe("POST /v1/ai/log-workout-audio", () => {
  it("forwards protocolVersion: 2 to the AI service", async () => {
    mockLogWorkoutAudio.mockResolvedValueOnce(
      ok({
        summary: "Logged one set.",
        transcript: "bench one hundred for five",
        operations: [],
        unmatched: [],
      }),
    );

    const res = await auth.post("/v1/ai/log-workout-audio").send({
      ...baseBody,
      hideRirControls: true,
      protocolVersion: 2,
    });

    expect(res.status).toBe(200);
    expect(mockLogWorkoutAudio).toHaveBeenCalledWith({
      userId: TEST_USER_ID,
      ...baseBody,
      hideRirControls: true,
      protocolVersion: 2,
    });
  });
});
