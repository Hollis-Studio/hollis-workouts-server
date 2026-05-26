/**
 * @ai-context Exercises resource router — READ-ONLY canonical exercise catalog.
 *
 * Special case: NOT user-scoped (no userId filter). Global catalog.
 * No auth is technically required for read access to the catalog, but it is
 * within the authenticated apiRouter — this is intentional (catalog is only
 * served to authenticated Hollis users).
 *
 * Verbs:
 *   GET  /     — list exercises; filters: ?isActive=true|false, ?category=<str>,
 *                ?equipmentType=<str>, ?search=<text> (case-insensitive name contains),
 *                cursor/limit pagination.
 *   GET  /:id  — single exercise by catalog slug id
 *
 * No POST / PUT / DELETE / PATCH — catalog is seeded server-side.
 * Seed script: prisma/seed-exercises.ts
 * Data source: hollis-workouts/scripts/data/exercises.json
 *
 * Caching: Cache-Control: private, max-age=3600 on all responses. `private`
 *   (not `public`) because the endpoint sits behind requireAuth — a shared
 *   cache/CDN must never serve it unauthenticated. The payload itself is
 *   global/stable, but the endpoint is authenticated.
 *
 * Wired by: src/routes/index.ts at /exercises
 *
 * deps: express, zod, lib/AppError, lib/prisma, middleware/errorHandler,
 *       utils/response, validation/common
 * consumers: routes/index.ts
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { AppError } from "../lib/AppError.js";
import { prisma } from "../lib/prisma.js";
import { asyncWrapper } from "../middleware/errorHandler.js";
import { sendSuccess } from "../utils/response.js";
import { idSchema } from "../validation/common.js";

// ---------------------------------------------------------------------------
// Query schema — supports isActive, category, equipmentType, search, and
// cursor-based pagination.
// ---------------------------------------------------------------------------

const listQuerySchema = z.object({
  isActive: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? true : v !== "false")),
  category: z.string().min(1).max(64).optional(),
  equipmentType: z.string().min(1).max(64).optional(),
  search: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Cache header applied to every catalog response (catalog is global / stable).
// ---------------------------------------------------------------------------

// `private` because the catalog is served behind requireAuth — a `public`
// directive would allow shared caches (CDNs, proxies) to serve it without
// authentication. The data itself is not user-specific, but the endpoint is.
const CATALOG_CACHE = "private, max-age=3600";

export const exercisesRouter = Router();

// ── GET / — list catalog ────────────────────────────────────────────────────

exercisesRouter.get(
  "/",
  asyncWrapper(async (req: Request, res: Response) => {
    // No req.userId filter — catalog is shared across all authenticated users.
    const queryParsed = listQuerySchema.safeParse(req.query);
    if (!queryParsed.success) {
      throw AppError.badRequest("Invalid query parameters", queryParsed.error.issues);
    }
    const { isActive, category, equipmentType, search, limit, cursor } = queryParsed.data;

    const items = await prisma.canonicalExercise.findMany({
      where: {
        isActive,
        ...(category ? { category } : {}),
        ...(equipmentType ? { equipmentType } : {}),
        ...(search
          ? { name: { contains: search, mode: "insensitive" } }
          : {}),
      },
      take: limit,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      // Stable cursor pagination: `id` tiebreaker so exercises with duplicate
      // names cannot be skipped/duplicated across pages.
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });

    res.setHeader("Cache-Control", CATALOG_CACHE);
    sendSuccess(res, {
      items,
      nextCursor: items.length === limit ? (items[items.length - 1]?.id ?? null) : null,
    });
  }),
);

// ── GET /:id — single exercise by catalog slug ──────────────────────────────

exercisesRouter.get(
  "/:id",
  asyncWrapper(async (req: Request, res: Response) => {
    const idParsed = idSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      throw AppError.badRequest("Invalid exercise id", idParsed.error.issues);
    }

    // Catalog is global — no userId filter. id is the PK so findUnique is correct.
    const exercise = await prisma.canonicalExercise.findUnique({
      where: { id: idParsed.data },
    });

    if (!exercise) throw AppError.notFound("Exercise");

    res.setHeader("Cache-Control", CATALOG_CACHE);
    sendSuccess(res, exercise);
  }),
);
