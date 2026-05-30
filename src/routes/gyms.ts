/**
 * @ai-context Gyms resource router — CRUD for GymProfile records.
 *
 * Operations:
 *   GET    /gyms          — list user's gyms; ?isActive=true|false filter
 *   GET    /gyms/:id      — single gym (IDOR-safe, userId scoped)
 *   PUT    /gyms/:id      — idempotent full-document upsert (client-generated UUID)
 *   PATCH  /gyms/:id      — soft delete (sets isActive:false)
 *
 * DELETE style: soft (PATCH isActive:false)
 * Wired by: src/routes/index.ts at /gyms
 *
 * Body schema mirrors GymProfile (minus userId — always taken from token):
 *   id, name, location?, equipmentTypes[], equipmentIds[], equipmentItems[],
 *   exerciseSelectionMode, isActive, createdAt, updatedAt
 *
 * JSON blob validation: equipmentItems is validated as GymEquipmentItem[]
 *   via inline GymEquipmentItemSchema before writing to the DB.
 *
 * deps: lib/crud, lib/prisma, zod, @hollis-studio/contracts/domain/equipment
 * consumers: routes/index.ts
 */

import { z } from "zod";
import { EquipmentTypeSchema } from "@hollis-studio/contracts/domain/equipment";
import { prisma } from "../lib/prisma.js";
import { createCrudRouter } from "../lib/crud.js";
import type { Request } from "express";

// ---------------------------------------------------------------------------
// Sub-schemas for JSON blob fields
// ---------------------------------------------------------------------------

/** Mirrors GymLocation */
const GymLocationSchema = z.object({
  lat: z.number().optional(),
  lng: z.number().optional(),
  address: z.string().optional(),
});

/**
 * EquipmentVariant values — kept inline to avoid importing the app's
 * client-side constants from hollis-workouts into the server.
 */
const EquipmentVariantSchema = z.enum([
  "standard_barbell",
  "olympic_barbell",
  "ez_curl_bar",
  "trap_bar",
  "safety_squat_bar",
  "fixed_dumbbells",
  "adjustable_dumbbells",
  "single_stack_cable",
  "dual_crossover_cable",
  "functional_trainer",
  "leg_press",
  "hack_squat",
  "chest_press_machine",
  "lat_pulldown_machine",
  "seated_row_machine",
  "leg_extension_machine",
  "leg_curl_machine",
  "pec_deck",
  "smith_machine_standard",
  "flat_treadmill",
  "incline_treadmill",
  "upright_bike",
  "recumbent_bike",
  "spin_bike",
  "concept2_rower",
  "standard_elliptical",
  "standard_kettlebell",
  "competition_kettlebell",
  "loop_band",
  "tube_band",
  "standard_stairmaster",
  "stepper",
  "speed_rope",
  "weighted_rope",
  "power_rack",
  "squat_stand",
  "pull_up_bar",
  "dip_station",
  "flat_bench",
  "adjustable_bench",
  "decline_bench",
  "preacher_curl_bench",
  "ghd",
  "other_variant",
]);

const EquipmentWeightSystemSchema = z.enum([
  "none",
  "bar",
  "weight_stack",
  "plate_loaded",
  "free_weight",
]);

/** Mirrors GymEquipmentItem */
const GymEquipmentItemSchema = z.object({
  id: z.string().min(1).max(128),
  type: EquipmentTypeSchema,
  variant: EquipmentVariantSchema.optional(),
  weightSystem: EquipmentWeightSystemSchema.optional(),
  weightStackKg: z.number().nonnegative().optional(),
  // App's GymEquipmentItemSchema allows incrementKg: 0 (min(0)); rejecting 0
  // here would 400 the gym PUT and silently drop the write in the outbox.
  incrementKg: z.number().nonnegative().optional(),
  minWeightKg: z.number().nonnegative().optional(),
  maxWeightKg: z.number().nonnegative().optional(),
  count: z.number().int().positive(),
  notes: z.string().max(500).optional(),
});

// ---------------------------------------------------------------------------
// Body schema — mirrors GymProfile minus userId
// ---------------------------------------------------------------------------

const gymBodySchema = z.object({
  name: z.string().min(1).max(200),
  location: GymLocationSchema.optional(),
  equipmentTypes: z.array(EquipmentTypeSchema),
  equipmentIds: z.array(z.string().min(1).max(128)),
  equipmentItems: z.array(GymEquipmentItemSchema),
  exerciseSelectionMode: z.enum(["equipment_based", "exercise"]),
  isActive: z.boolean(),
  createdAt: z.coerce.date().optional(),
  updatedAt: z.coerce.date().optional(),
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const gymsRouter = createCrudRouter({
  delegate: prisma.gym,
  resourceName: "Gym",
  bodySchema: gymBodySchema,
  idParam: "id",
  deleteStyle: "soft",
  listFilters: (req: Request): Record<string, unknown> => {
    const { isActive } = req.query;
    if (isActive === undefined) return {};
    return { isActive: isActive !== "false" };
  },
});
