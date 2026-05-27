/**
 * @ai-context PlateauCoachingArtifact resource router — per-row collection.
 *
 * Records are written by Cloud Functions (AI pipeline) and read/dismissed by
 * the mobile client. The route supports:
 *
 * Verbs:
 *   GET    /       — list the caller's artifacts (most recent first)
 *   GET    /:id    — single artifact (IDOR-safe, userId scoped)
 *   PUT    /:id    — idempotent upsert (client-provided id); used by Cloud
 *                    Functions and by the client to update dismissedAt
 *   DELETE /:id    — hard delete (remove stale/obsolete artifacts)
 *
 * Uses createCrudRouter() factory: PlateauCoachingArtifact has `id` (String @id)
 * and `createdAt` columns, satisfying the factory's REQUIREMENT.
 *
 * Wired by: src/routes/index.ts at /plateau-coaching
 *   apiRouter.use("/plateau-coaching", plateauCoachingRouter);
 *
 * Body schema mirrors PlateauCoachingArtifact (minus userId — always from token):
 *   exerciseId, detectedAt, narrative, rootCauses[], recommendations[],
 *   dismissedAt?, tokenCount?
 *
 * deps: lib/crud, lib/prisma, zod
 * consumers: routes/index.ts
 */

import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { createCrudRouter } from "../lib/crud.js";

// ---------------------------------------------------------------------------
// Body schema — mirrors PlateauCoachingArtifact (minus userId)
// ---------------------------------------------------------------------------

const tokenCountSchema = z
  .object({
    input: z.number().int().nonnegative().optional(),
    output: z.number().int().nonnegative().optional(),
  })
  .nullable()
  .optional();

const plateauCoachingBodySchema = z.object({
  exerciseId: z.string().min(1).max(512),
  detectedAt: z.coerce.date(),
  narrative: z.string().min(1),
  /** Root causes array — nullable in Prisma (String[]); null treated as [] by the factory */
  rootCauses: z.array(z.string().min(1)),
  /** Recommendations array — nullable in Prisma (String[]); null treated as [] */
  recommendations: z.array(z.string().min(1)),
  /** Epoch timestamp when the user dismissed the artifact; null means active */
  dismissedAt: z.coerce.date().nullable().optional(),
  tokenCount: tokenCountSchema,
  createdAt: z.coerce.date().optional(),
  updatedAt: z.coerce.date().optional(),
});

// ---------------------------------------------------------------------------
// Router via CRUD factory
// ---------------------------------------------------------------------------

export const plateauCoachingRouter = createCrudRouter({
  delegate: prisma.plateauCoachingArtifact,
  resourceName: "PlateauCoachingArtifact",
  bodySchema: plateauCoachingBodySchema,
  idParam: "id",
  deleteStyle: "hard",
  listFilters: (req) => {
    const { exerciseId } = req.query;
    if (typeof exerciseId === "string" && exerciseId.length > 0) {
      return { exerciseId };
    }
    return {};
  },
});
