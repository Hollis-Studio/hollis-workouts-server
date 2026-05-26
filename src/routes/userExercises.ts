/**
 * @ai-context UserExercises resource router — CRUD for user-created CanonicalExercise records.
 *
 * DELETE style: soft (PATCH isActive:false)
 * Wired by: src/routes/index.ts at /user-exercises
 *
 * Body shape = full CanonicalExercise (src/types/models/exercise.ts).  The app
 * writes the entire CanonicalExercise payload when users create exercises, so
 * we validate the complete shape here.  Inline Zod enums mirror the app-side
 * schemas exactly (src/schemas/exercise.ts CanonicalExerciseSchema).
 *
 * userId is always injected from req.userId — never trusted from body.
 * metadata is validated as z.record(z.string(), z.unknown()) — arbitrary JSON blob.
 *
 * List filters: ?isActive=true|false
 *   Omitting the param returns all records (no default filter).
 *   Passing ?isActive=false returns soft-deleted records too (admin/sync use-case).
 *
 * deps: lib/crud, lib/prisma, zod | consumers: routes/index.ts
 */

import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { createCrudRouter } from "../lib/crud.js";

// ---------------------------------------------------------------------------
// Inline enum schemas — mirror src/schemas/exercise.ts exactly so validation
// on the server matches client-side validation without a cross-project import.
// ---------------------------------------------------------------------------

const TrackingModeSchema = z.enum(["weightlifting", "cardio", "stretching"]);

const ExerciseSubcategorySchema = z.enum([
  "compound",
  "isolation",
  "machine",
  "freeweight",
  "bodyweight",
  "cable",
  "treadmill",
  "bike",
  "rowing",
  "elliptical",
  "stairmaster",
  "outdoor_running",
  "outdoor_walking",
  "outdoor_cycling",
  "jump_rope",
  "isometric",
  "flexibility",
]);

const EquipmentTypeSchema = z.enum([
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
]);

const MuscleGroupSchema = z.enum([
  "chest",
  "back",
  "shoulders",
  "biceps",
  "triceps",
  "forearms",
  "quadriceps",
  "hamstrings",
  "glutes",
  "calves",
  "core",
  "traps",
  "lats",
  "anterior_deltoids",
  "lateral_deltoids",
  "posterior_deltoids",
  "hip_flexors",
  "adductors",
  "abductors",
  "neck",
  "obliques",
  "lower_back",
  "upper_back",
]);

const WeightModeSchema = z.enum(["absolute", "relative"]);
const ExerciseSourceSchema = z.enum(["library", "user_created", "ai_generated_freestyle"]);
const ExerciseTrackingModeSchema = z.enum(["reps", "timed", "cardio", "stretch"]);

// ---------------------------------------------------------------------------
// Body schema — full CanonicalExercise shape (minus id, userId, and server-
// managed timestamps).  The id comes authoritatively from the URL :id param
// (enforced by the factory); accepting it in the body would let a crafted
// request override the URL param via the spread in the factory.
// ---------------------------------------------------------------------------

const userExerciseBodySchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  category: TrackingModeSchema,
  subcategory: ExerciseSubcategorySchema.optional(),
  primaryMuscleGroups: z.array(MuscleGroupSchema).min(1),
  secondaryMuscleGroups: z.array(MuscleGroupSchema),
  equipmentType: EquipmentTypeSchema,
  requiredEquipment: z.array(z.string()).default([]),
  isBodyweight: z.boolean(),
  isUnilateral: z.boolean(),
  defaultRestTimerSec: z.number().int().min(0),
  defaultWeightMode: WeightModeSchema,
  illustrationUrl: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  minimumIncrementKg: z.number().min(0),
  source: ExerciseSourceSchema,
  trackingMode: ExerciseTrackingModeSchema.optional(),
  isActive: z.boolean().default(true),
});

export const userExercisesRouter = createCrudRouter({
  delegate: prisma.userExercise,
  resourceName: "UserExercise",
  bodySchema: userExerciseBodySchema,
  idParam: "id",
  deleteStyle: "soft",
  listFilters: (req) => {
    if (req.query.isActive === undefined) {
      return {};
    }
    return { isActive: req.query.isActive !== "false" };
  },
});
