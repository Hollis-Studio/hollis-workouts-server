/**
 * @ai-context ExerciseAliases resource router — CRUD for ExerciseAlias records.
 *
 * DELETE style: hard
 * Wired by: src/routes/index.ts at /exercise-aliases
 *
 * Body schema mirrors ExerciseAlias (src/types/models/exercise.ts):
 *   alias, normalizedAlias, canonicalExerciseId, equipmentType?, gymProfileId?,
 *   source ("scan"|"manual"|"ai_match")
 *   userId is always injected from req.userId — never trusted from body.
 *
 * The id field is a deterministic composite supplied by the client — idempotent
 * PUT-upsert means the same alias text hits the same id every time.
 *
 * List filters: ?canonicalExerciseId=<id> and optionally ?normalizedAlias=<str>
 *   Safe because the factory's where clause already scopes to userId.
 *
 * deps: lib/crud, lib/prisma, zod | consumers: routes/index.ts
 */

import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { createCrudRouter } from "../lib/crud.js";
import { AppError } from "../lib/AppError.js";
import { idSchema } from "../validation/common.js";

const exerciseAliasBodySchema = z.object({
  alias: z.string().min(1),
  normalizedAlias: z.string().min(1),
  canonicalExerciseId: z.string().min(1),
  equipmentType: z
    .enum([
      "barbell",
      "dumbbell",
      "kettlebell",
      "cable",
      "machine",
      "bodyweight",
      "resistance_band",
      "squat_rack",
      "bench",
      "pull_up_bar",
      "plate_loaded_machine",
      "smith_machine",
      "treadmill",
      "stationary_bike",
      "rowing_machine",
      "elliptical",
      "stairmaster",
      "jump_rope",
      "none",
      "other",
    ])
    .optional(),
  gymProfileId: z.string().min(1).optional(),
  source: z.enum(["scan", "manual", "ai_match"]),
});

export const exerciseAliasesRouter = createCrudRouter({
  delegate: prisma.exerciseAlias,
  resourceName: "ExerciseAlias",
  bodySchema: exerciseAliasBodySchema,
  idParam: "id",
  deleteStyle: "hard",
  listFilters: (req) => {
    const filters: Record<string, unknown> = {};

    // When a filter param is present but invalid, throw 400 rather than
    // silently dropping it — dropping would return all rows instead of the
    // expected narrowed set, which is incorrect and a potential data-volume issue.
    if (req.query.canonicalExerciseId !== undefined) {
      const parsed = idSchema.safeParse(req.query.canonicalExerciseId);
      if (!parsed.success) throw AppError.badRequest("Invalid canonicalExerciseId filter", parsed.error.issues);
      filters.canonicalExerciseId = parsed.data;
    }

    if (req.query.normalizedAlias !== undefined) {
      const parsed = z.string().min(1).max(256).safeParse(req.query.normalizedAlias);
      if (!parsed.success) throw AppError.badRequest("Invalid normalizedAlias filter", parsed.error.issues);
      filters.normalizedAlias = parsed.data;
    }

    return filters;
  },
});
