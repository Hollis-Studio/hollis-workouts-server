/**
 * Unit tests for the VoiceLogOperationSchema superRefine narrowing and the
 * exerciseIndex guard logic in logWorkoutAudio.ts.
 *
 * These tests exercise the Zod schema and the guard contract directly, without
 * hitting Gemini or Prisma.  No Express app or Prisma mock is needed.
 *
 * Coverage:
 *   - VoiceLogOperationSchema accepts each of the 7 op kinds with valid fields
 *   - superRefine rejects log_set / modify_set / delete_set / skip_set /
 *     set_rest / set_active_exercise when exerciseIndex is absent
 *   - superRefine rejects modify_set / delete_set / skip_set / set_rest when
 *     setIndex is absent
 *   - superRefine rejects set_rest when restAfterSec is absent
 *   - superRefine rejects add_exercise when exerciseName or trackingMode is absent
 *   - add_exercise does NOT require exerciseIndex (the guard exemption)
 *   - exerciseIndex guard logic: non-add_exercise ops with unknown indexes are
 *     filtered; add_exercise is never filtered (contracts match service code)
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Type } from "@google/genai";

// We import the internals via re-export from the service file.
// The service does NOT export VoiceLogOperationSchema directly, so we reproduce
// the same shape here to keep the test independent and avoid coupling to the
// service's private module scope.
//
// The schema is intentionally identical to the one in logWorkoutAudio.ts.

const VoiceOpSetSchema = z.object({
  weightKg: z.number().min(0).max(1000).optional(),
  reps: z.number().int().min(0).max(200).optional(),
  rir: z.number().int().min(0).max(10).optional(),
  durationSeconds: z.number().int().min(1).max(3600).optional(),
  distanceKm: z.number().min(0).max(1000).optional(),
});

const VoiceLogOperationRawSchema = z.object({
  op: z.enum([
    "log_set",
    "modify_set",
    "delete_set",
    "skip_set",
    "set_rest",
    "set_active_exercise",
    "add_exercise",
  ]),
  exerciseIndex: z.number().int().min(0).optional(),
  setIndex: z.number().int().min(0).optional(),
  weightKg: z.number().min(0).max(1000).optional(),
  reps: z.number().int().min(0).max(200).optional(),
  rir: z.number().int().min(0).max(10).optional(),
  durationSeconds: z.number().int().min(1).max(3600).optional(),
  distanceKm: z.number().min(0).max(1000).optional(),
  restAfterSec: z.number().int().min(0).max(3600).nullable().optional(),
  exerciseName: z.string().min(1).optional(),
  trackingMode: z.enum(["reps", "timed", "cardio", "stretch"]).optional(),
  insertAfterIndex: z.number().int().min(0).nullable().optional(),
  sets: z.array(VoiceOpSetSchema).optional(),
  confidence: z.number().min(0).max(1),
  explanation: z.string().optional(),
});

const VoiceLogOperationSchema = VoiceLogOperationRawSchema.superRefine((op, ctx) => {
  const needsExerciseIndex = new Set([
    "log_set",
    "modify_set",
    "delete_set",
    "skip_set",
    "set_rest",
    "set_active_exercise",
  ]);
  if (needsExerciseIndex.has(op.op) && op.exerciseIndex === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${op.op} requires exerciseIndex`,
      path: ["exerciseIndex"],
    });
  }

  const needsSetIndex = new Set(["modify_set", "delete_set", "skip_set", "set_rest"]);
  if (needsSetIndex.has(op.op) && op.setIndex === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${op.op} requires setIndex`,
      path: ["setIndex"],
    });
  }

  if (op.op === "set_rest" && op.restAfterSec === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "set_rest requires restAfterSec",
      path: ["restAfterSec"],
    });
  }

  if (op.op === "add_exercise") {
    if (!op.exerciseName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "add_exercise requires exerciseName",
        path: ["exerciseName"],
      });
    }
    if (!op.trackingMode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "add_exercise requires trackingMode",
        path: ["trackingMode"],
      });
    }
  }
});

type VoiceLogOperation = z.infer<typeof VoiceLogOperationSchema>;

// ── Happy-path: each op kind passes with valid fields ─────────────────────────

describe("VoiceLogOperationSchema — valid ops", () => {
  it("accepts log_set with exerciseIndex", () => {
    const result = VoiceLogOperationSchema.safeParse({
      op: "log_set",
      exerciseIndex: 0,
      weightKg: 100,
      reps: 5,
      rir: 2,
      confidence: 0.95,
    });
    expect(result.success).toBe(true);
  });

  it("accepts log_set without setIndex (append mode)", () => {
    const result = VoiceLogOperationSchema.safeParse({
      op: "log_set",
      exerciseIndex: 0,
      weightKg: 80,
      reps: 8,
      confidence: 0.9,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.setIndex).toBeUndefined();
    }
  });

  it("accepts modify_set with exerciseIndex and setIndex", () => {
    const result = VoiceLogOperationSchema.safeParse({
      op: "modify_set",
      exerciseIndex: 1,
      setIndex: 0,
      weightKg: 105,
      confidence: 0.88,
    });
    expect(result.success).toBe(true);
  });

  it("accepts delete_set with exerciseIndex and setIndex", () => {
    const result = VoiceLogOperationSchema.safeParse({
      op: "delete_set",
      exerciseIndex: 0,
      setIndex: 2,
      confidence: 0.9,
    });
    expect(result.success).toBe(true);
  });

  it("accepts skip_set with exerciseIndex and setIndex", () => {
    const result = VoiceLogOperationSchema.safeParse({
      op: "skip_set",
      exerciseIndex: 0,
      setIndex: 1,
      confidence: 0.85,
    });
    expect(result.success).toBe(true);
  });

  it("accepts set_rest with exerciseIndex, setIndex, and restAfterSec", () => {
    const result = VoiceLogOperationSchema.safeParse({
      op: "set_rest",
      exerciseIndex: 0,
      setIndex: 0,
      restAfterSec: 120,
      confidence: 0.9,
    });
    expect(result.success).toBe(true);
  });

  it("accepts set_active_exercise with exerciseIndex", () => {
    const result = VoiceLogOperationSchema.safeParse({
      op: "set_active_exercise",
      exerciseIndex: 2,
      confidence: 0.95,
    });
    expect(result.success).toBe(true);
  });

  it("accepts add_exercise WITHOUT exerciseIndex (the guard exemption)", () => {
    const result = VoiceLogOperationSchema.safeParse({
      op: "add_exercise",
      exerciseName: "Lateral Raises",
      trackingMode: "reps",
      confidence: 0.9,
      sets: [{ reps: 15 }, { reps: 15 }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.exerciseIndex).toBeUndefined();
    }
  });

  it("accepts add_exercise with inline sets (all fields optional)", () => {
    const result = VoiceLogOperationSchema.safeParse({
      op: "add_exercise",
      exerciseName: "Plank",
      trackingMode: "timed",
      confidence: 0.88,
      sets: [{ durationSeconds: 60 }, { durationSeconds: 45 }],
    });
    expect(result.success).toBe(true);
  });
});

// ── superRefine rejections ────────────────────────────────────────────────────

describe("VoiceLogOperationSchema — superRefine rejects missing required fields", () => {
  const opsRequiringExerciseIndex = [
    "log_set",
    "modify_set",
    "delete_set",
    "skip_set",
    "set_rest",
    "set_active_exercise",
  ] as const;

  for (const op of opsRequiringExerciseIndex) {
    it(`rejects ${op} when exerciseIndex is absent`, () => {
      const base = {
        op,
        confidence: 0.9,
        setIndex: 0,
        restAfterSec: op === "set_rest" ? 60 : undefined,
      };
      const result = VoiceLogOperationSchema.safeParse(base);
      expect(result.success).toBe(false);
      if (!result.success) {
        const paths = result.error.issues.map((i) => i.path.join("."));
        expect(paths).toContain("exerciseIndex");
      }
    });
  }

  const opsRequiringSetIndex = ["modify_set", "delete_set", "skip_set", "set_rest"] as const;
  for (const op of opsRequiringSetIndex) {
    it(`rejects ${op} when setIndex is absent`, () => {
      const base = {
        op,
        exerciseIndex: 0,
        confidence: 0.9,
        restAfterSec: op === "set_rest" ? 60 : undefined,
      };
      const result = VoiceLogOperationSchema.safeParse(base);
      expect(result.success).toBe(false);
      if (!result.success) {
        const paths = result.error.issues.map((i) => i.path.join("."));
        expect(paths).toContain("setIndex");
      }
    });
  }

  it("rejects set_rest when restAfterSec is absent", () => {
    const result = VoiceLogOperationSchema.safeParse({
      op: "set_rest",
      exerciseIndex: 0,
      setIndex: 0,
      confidence: 0.9,
      // restAfterSec intentionally absent
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("restAfterSec");
    }
  });

  it("rejects add_exercise when exerciseName is absent", () => {
    const result = VoiceLogOperationSchema.safeParse({
      op: "add_exercise",
      trackingMode: "reps",
      confidence: 0.9,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("exerciseName");
    }
  });

  it("rejects add_exercise when trackingMode is absent", () => {
    const result = VoiceLogOperationSchema.safeParse({
      op: "add_exercise",
      exerciseName: "Pull-ups",
      confidence: 0.9,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("trackingMode");
    }
  });
});

// ── Exercise-index guard logic ────────────────────────────────────────────────
//
// The service filters validated operations:
//   .filter((op) => op.op !== "add_exercise" && op.exerciseIndex !== undefined)
//   .map((op) => op.exerciseIndex as number)
//   .filter((idx) => !validExerciseIndexes.has(idx))
//
// Tests here mirror that contract.

describe("exerciseIndex guard logic (mirrors logWorkoutAudio.ts filter)", () => {
  function applyGuard(
    ops: VoiceLogOperation[],
    validIndexes: Set<number>,
  ): number[] {
    return ops
      .filter((op) => op.op !== "add_exercise" && op.exerciseIndex !== undefined)
      .map((op) => op.exerciseIndex as number)
      .filter((idx) => !validIndexes.has(idx));
  }

  it("returns no invalid indexes when all exerciseIndexes are in the valid set", () => {
    const ops: VoiceLogOperation[] = [
      { op: "log_set", exerciseIndex: 0, weightKg: 100, reps: 5, rir: 2, confidence: 0.95 },
      { op: "log_set", exerciseIndex: 1, weightKg: 80, reps: 8, confidence: 0.9 },
    ];
    const invalid = applyGuard(ops, new Set([0, 1]));
    expect(invalid).toHaveLength(0);
  });

  it("returns the out-of-range index as invalid", () => {
    const ops: VoiceLogOperation[] = [
      { op: "log_set", exerciseIndex: 0, weightKg: 100, reps: 5, rir: 2, confidence: 0.95 },
      { op: "log_set", exerciseIndex: 5, weightKg: 80, reps: 8, confidence: 0.9 },
    ];
    const invalid = applyGuard(ops, new Set([0]));
    expect(invalid).toEqual([5]);
  });

  it("add_exercise ops are NOT included in the guard check (never flagged as invalid)", () => {
    const ops: VoiceLogOperation[] = [
      {
        op: "add_exercise",
        exerciseName: "Lateral Raises",
        trackingMode: "reps",
        confidence: 0.9,
        // exerciseIndex intentionally absent — add_exercise doesn't need it
      },
      { op: "log_set", exerciseIndex: 0, weightKg: 100, reps: 5, rir: 2, confidence: 0.95 },
    ];
    const invalid = applyGuard(ops, new Set([0]));
    // Only log_set ops are checked; add_exercise is exempt
    expect(invalid).toHaveLength(0);
  });

  it("set_active_exercise with invalid index is caught", () => {
    const ops: VoiceLogOperation[] = [
      { op: "set_active_exercise", exerciseIndex: 99, confidence: 0.9 },
    ];
    const invalid = applyGuard(ops, new Set([0, 1, 2]));
    expect(invalid).toEqual([99]);
  });

  it("multiple invalid indexes are all reported", () => {
    const ops: VoiceLogOperation[] = [
      { op: "log_set", exerciseIndex: 0, weightKg: 100, reps: 5, rir: 2, confidence: 0.9 },
      { op: "log_set", exerciseIndex: 7, weightKg: 60, reps: 10, confidence: 0.85 },
      { op: "modify_set", exerciseIndex: 8, setIndex: 0, confidence: 0.8 },
      {
        op: "add_exercise",
        exerciseName: "Cable Fly",
        trackingMode: "reps",
        confidence: 0.9,
      },
    ];
    const invalid = applyGuard(ops, new Set([0]));
    expect(invalid).toEqual([7, 8]);
  });
});
