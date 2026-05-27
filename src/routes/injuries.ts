/**
 * @ai-context Injuries resource router — CRUD for InjuryRecord records.
 *
 * Operations:
 *   GET    /injuries       — list user's injuries; ?isActive, ?muscleGroup filters
 *   GET    /injuries/:id   — single injury (IDOR-safe)
 *   PUT    /injuries/:id   — idempotent upsert (client-provided id)
 *   PATCH  /injuries/:id   — soft delete (sets isActive:false)
 *
 * DELETE style: soft — PATCH sets isActive:false
 * Wired by: src/routes/index.ts at /injuries
 *
 * Body schema mirrors InjuryRecord (src/types/models/injury.ts):
 *   - muscleGroup: string (MuscleGroup enum value)
 *   - description: string
 *   - createdAt: ISO string from client → coerced to Date for Prisma
 *   - isActive: boolean
 *
 * createdAt coercion: the app stores InjuryRecord.createdAt as an ISO string
 * (type: string in the interface). The factory write path accepts it from the
 * body and stores it as a Prisma DateTime. Zod `z.coerce.date()` handles the
 * string → Date conversion.
 *
 * updatedAt is server-managed via `@updatedAt` in the Prisma schema — never
 * accepted from the client body.
 *
 * listFilters:
 *   ?isActive=true|false   — defaults to showing ALL (no default filter)
 *   ?muscleGroup=<value>   — exact match on the muscleGroup string
 *
 * deps: lib/crud, lib/prisma, zod | consumers: routes/index.ts
 */

import { z } from "zod";
import { MuscleGroupSchema } from "@hollis-studio/contracts/domain/muscles";
import { AppError } from "../lib/AppError.js";
import { prisma } from "../lib/prisma.js";
import { createCrudRouter } from "../lib/crud.js";
import type { Request } from "express";

// ---------------------------------------------------------------------------
// Body schema — mirrors InjuryRecord (injury.ts interface) minus userId and
// the server-managed updatedAt.
//
// createdAt coercion: InjuryRecord.createdAt is typed as `string` in the app
// interface (ISO string on Firestore/MMKV). We accept any non-empty string and
// coerce it to Date for Prisma's DateTime column. z.coerce.date() handles ISO
// strings, timestamps (number), and Date objects.
// ---------------------------------------------------------------------------

const injuryBodySchema = z.object({
  muscleGroup: z.string().min(1).max(64),
  description: z.string().min(0).max(2000),
  // createdAt: the app sends an ISO string; coerce to Date for Prisma DateTime.
  createdAt: z.coerce.date(),
  isActive: z.boolean(),
});

// ---------------------------------------------------------------------------
// listFilters — ?isActive and ?muscleGroup; isActive has NO default (show all
// when param is absent, matching the app's pattern of listing all and filtering
// client-side for some surfaces).
// ---------------------------------------------------------------------------

function injuryListFilters(req: Request): Record<string, unknown> {
  const { isActive, muscleGroup } = req.query as Record<string, string | undefined>;

  const filters: Record<string, unknown> = {};

  if (isActive !== undefined) {
    filters.isActive = isActive !== "false";
  }

  if (muscleGroup !== undefined && muscleGroup !== "") {
    // Validate against the canonical MuscleGroup enum from @hollis-studio/contracts.
    // safeParse returns a typed union; on failure we throw 400 before touching Prisma.
    const parsed = MuscleGroupSchema.safeParse(muscleGroup);
    if (!parsed.success) {
      throw AppError.badRequest(
        `Invalid muscleGroup: "${muscleGroup}" is not a recognised muscle group`,
        parsed.error.issues,
      );
    }
    filters.muscleGroup = parsed.data;
  }

  return filters;
}

export const injuriesRouter = createCrudRouter({
  delegate: prisma.injuryRecord,
  resourceName: "InjuryRecord",
  bodySchema: injuryBodySchema,
  idParam: "id",
  deleteStyle: "soft",
  listFilters: injuryListFilters,
});
