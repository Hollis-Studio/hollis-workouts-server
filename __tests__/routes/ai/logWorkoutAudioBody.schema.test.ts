/**
 * Contract tests for LogWorkoutAudioBodySchema — specifically the protocolVersion
 * opt-in that keeps already-installed (pre-operations[]) app builds working.
 *
 * Coverage:
 *   - A legacy request (no protocolVersion) parses successfully → server will
 *     serve the legacy entries[] response.
 *   - protocolVersion: 2 parses successfully → server will serve operations[].
 *   - Any other protocolVersion (e.g. 1, 3) is rejected by the literal(2).
 *   - Enriched exercise context (isActive, loggedSets) and hideRirControls are
 *     optional, so old clients that omit them still validate.
 */

import { describe, it, expect } from "vitest";
import { LogWorkoutAudioBodySchema } from "../../../src/routes/ai/schemas.js";

const baseExercise = {
  exerciseIndex: 0,
  exerciseName: "Bench Press",
  canonicalExerciseId: "bench_press",
  trackingMode: "reps" as const,
  targetSetCount: 3,
};

const legacyBody = {
  audioBase64: "ZmFrZS1hdWRpbw==",
  mimeType: "audio/m4a" as const,
  defaultWeightUnit: "kg" as const,
  exercises: [baseExercise],
};

describe("LogWorkoutAudioBodySchema protocolVersion opt-in", () => {
  it("accepts a legacy request with no protocolVersion (old app build)", () => {
    const parsed = LogWorkoutAudioBodySchema.safeParse(legacyBody);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.protocolVersion).toBeUndefined();
    }
  });

  it("accepts protocolVersion: 2 (new operations[]-aware client)", () => {
    const parsed = LogWorkoutAudioBodySchema.safeParse({
      ...legacyBody,
      protocolVersion: 2,
      hideRirControls: true,
      exercises: [{ ...baseExercise, isActive: true, loggedSets: [] }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.protocolVersion).toBe(2);
    }
  });

  it("rejects an unsupported protocolVersion", () => {
    expect(LogWorkoutAudioBodySchema.safeParse({ ...legacyBody, protocolVersion: 1 }).success).toBe(
      false,
    );
    expect(LogWorkoutAudioBodySchema.safeParse({ ...legacyBody, protocolVersion: 3 }).success).toBe(
      false,
    );
  });

  it("treats enriched context and hideRirControls as optional", () => {
    // Old clients send neither isActive/loggedSets nor hideRirControls.
    const parsed = LogWorkoutAudioBodySchema.safeParse(legacyBody);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.hideRirControls).toBeUndefined();
      expect(parsed.data.exercises[0].isActive).toBeUndefined();
      expect(parsed.data.exercises[0].loggedSets).toBeUndefined();
    }
  });
});
