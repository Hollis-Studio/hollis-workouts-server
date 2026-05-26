/**
 * @ai-context GymExerciseInstances resource router — CRUD for GymExerciseInstance records.
 *
 * DELETE style: hard
 * Wired by: src/routes/index.ts at /gym-exercise-instances
 *
 * Body schema mirrors GymExerciseInstance (src/types/models/exercise.ts):
 *   gymProfileId, canonicalExerciseId, baseWeightKg?, weightUnit, weightMode,
 *   weightIncrementKg?, isActive, notes?, lastUsedWeightKg?
 *   userId is always injected from req.userId — never trusted from body.
 *
 * List filters: ?gymProfileId=<id> and ?canonicalExerciseId=<id>
 *   Safe because the factory's where clause already scopes to userId.
 *
 * deps: lib/crud, lib/prisma, zod | consumers: routes/index.ts
 */

import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { createCrudRouter } from "../lib/crud.js";
import { AppError } from "../lib/AppError.js";
import { idSchema } from "../validation/common.js";

const gymExerciseInstanceBodySchema = z.object({
  gymProfileId: z.string().min(1),
  canonicalExerciseId: z.string().min(1),
  baseWeightKg: z.number().min(0).nullable().optional(),
  weightUnit: z.enum(["kg", "lbs"]),
  weightMode: z.enum(["absolute", "relative"]),
  weightIncrementKg: z.number().min(0).optional(),
  isActive: z.boolean(),
  notes: z.string().optional(),
  lastUsedWeightKg: z.number().min(0).optional(),
});

export const gymExerciseInstancesRouter = createCrudRouter({
  delegate: prisma.gymExerciseInstance,
  resourceName: "GymExerciseInstance",
  bodySchema: gymExerciseInstanceBodySchema,
  idParam: "id",
  deleteStyle: "hard",
  listFilters: (req) => {
    const filters: Record<string, unknown> = {};

    // When a filter param is present but invalid, throw 400 rather than
    // silently dropping it — dropping would return all rows instead of the
    // expected narrowed set, which is incorrect and a potential data-volume issue.
    if (req.query.gymProfileId !== undefined) {
      const parsed = idSchema.safeParse(req.query.gymProfileId);
      if (!parsed.success) throw AppError.badRequest("Invalid gymProfileId filter", parsed.error.issues);
      filters.gymProfileId = parsed.data;
    }

    if (req.query.canonicalExerciseId !== undefined) {
      const parsed = idSchema.safeParse(req.query.canonicalExerciseId);
      if (!parsed.success) throw AppError.badRequest("Invalid canonicalExerciseId filter", parsed.error.issues);
      filters.canonicalExerciseId = parsed.data;
    }

    return filters;
  },
});
