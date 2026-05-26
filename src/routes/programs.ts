/**
 * @ai-context Programs resource router — CRUD for Program records.
 *
 * Operations:
 *   GET    /programs       — list user's programs; ?isActive=true|false filter
 *   GET    /programs/:id   — single program (IDOR-safe, userId scoped)
 *   PUT    /programs/:id   — idempotent full-document upsert (client-generated UUID)
 *   DELETE /programs/:id   — hard delete (IDOR-safe ownership check first)
 *
 * DELETE style: hard
 * Wired by: src/routes/index.ts at /programs
 *
 * Body schema mirrors Program (minus userId — always taken from token):
 *   id, name, description?, type, startDate, endDate?, durationWeeks,
 *   isActive, deloadWeekNumbers[], deloadPercent, schedule (ProgramDay[]),
 *   schemaVersion?, createdAt?, updatedAt?
 *
 * JSON blob validation: schedule (ProgramDay[] with nested ProgramExercise[]
 *   and ProgramSet[]) is validated by the canonical ProgramSchema from
 *   @hollis-studio/contracts — no hand-rolled copy (see body schema note).
 *
 * deps: lib/crud, lib/prisma, zod, @hollis-studio/contracts | consumers: routes/index.ts
 */

import { z } from "zod";
import { ProgramSchema } from "@hollis-studio/contracts/progression/program";
import { prisma } from "../lib/prisma.js";
import { createCrudRouter } from "../lib/crud.js";
import type { Request } from "express";

// ---------------------------------------------------------------------------
// Body schema — derive from the CANONICAL ProgramSchema in @hollis-studio/
// contracts, NOT a hand-rolled copy. A previous inline schema had silently
// drifted from the contract (deloadPercent 0..100 vs 0..1, dayOfWeek min 0 vs
// -1 rest-day sentinel, goalMode required vs optional+useSmartProgress
// transform, missing .min(1) on schedule/exercises, looser target bounds),
// which would have 400'd or corrupted legitimate client documents on sync.
// Deriving from the contract keeps the server and client in lockstep.
//
// id/userId come from the URL + token. createdAt is optional on the body (the
// CRUD factory honors a client value or defaults to now() on create, and
// strips it on update). updatedAt is always server-managed (@updatedAt) and is
// never accepted from the body.
// ---------------------------------------------------------------------------

const programBodySchema = ProgramSchema.omit({
  id: true,
  userId: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  createdAt: z.coerce.date().optional(),
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const programsRouter = createCrudRouter({
  delegate: prisma.program,
  resourceName: "Program",
  bodySchema: programBodySchema,
  idParam: "id",
  deleteStyle: "hard",
  listFilters: (req: Request): Record<string, unknown> => {
    const { isActive } = req.query;
    if (isActive === undefined) return {};
    return { isActive: isActive !== "false" };
  },
});
