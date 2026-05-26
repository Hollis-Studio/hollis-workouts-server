/**
 * @ai-context Weeks resource router — GET / + PUT for Week records (composite PK: userId + weekIso).
 *
 * Special case: no delete; PK is composite (userId, weekIso) not a standalone `id`.
 * The factory does not fit this model; this is a fully custom router.
 *
 * IMPORTANT: the Prisma model has no `id` column — the PK is the composite
 * (userId, weekIso). Every response object synthesises `id: weekIso` so that
 * clients receive the WeekDocument shape (which requires `id`).
 *
 * Verbs:
 *   GET  /           — list all weeks for the user (ordered by weekIso desc); filter ?since=<YYYY-Www>
 *   GET  /:weekIso   — single week; 404 if absent
 *   PUT  /:weekIso   — upsert by { userId, weekIso }; no DELETE
 *
 * Wired by: src/routes/index.ts at /weeks
 *
 * deps: express, zod, lib/AppError, lib/prisma, middleware/errorHandler,
 *       middleware/rateLimit, utils/response, validation/common
 * consumers: routes/index.ts
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { AppError } from "../lib/AppError.js";
import { prisma } from "../lib/prisma.js";
import { asyncWrapper } from "../middleware/errorHandler.js";
import { writeRateLimiter } from "../middleware/rateLimit.js";
import { sendSuccess } from "../utils/response.js";
import { weekIsoSchema, paginationSchema } from "../validation/common.js";

// ---------------------------------------------------------------------------
// Body schema — mirrors WeekDocument (Json blobs + forward-spec conversation fields).
// createdAt / updatedAt are Prisma-managed; client must not send them.
// ---------------------------------------------------------------------------

const weekBodySchema = z.object({
  /** Frozen deterministic snapshot for the AI retrospective — arbitrary shape. */
  deterministicSnapshot: z.unknown().optional(),
  /** AI retrospective deck data — arbitrary shape. */
  aiRetrospective: z.unknown().optional(),
  /** User annotations on the week — free-form. */
  userAnnotations: z.unknown().optional(),
  // forward-spec conversation fields (not yet written by any app path)
  conversationUpdatedAt: z.string().datetime().optional(),
  hasConversation: z.boolean().optional(),
  lastConversationThreadId: z.string().optional(),
});

type WeekBody = z.infer<typeof weekBodySchema>;

// Query filter schema for GET /
const listQuerySchema = z.object({
  /** Only return weeks at or after this ISO week string (e.g. "2025-W01"). */
  since: weekIsoSchema.optional(),
});

// ---------------------------------------------------------------------------
// Helper — attach synthetic `id` field required by WeekDocument.
// The Prisma row has no `id` column; the app uses weekIso as the document id.
// ---------------------------------------------------------------------------
function withId<T extends { weekIso: string }>(row: T): T & { id: string } {
  return { id: row.weekIso, ...row };
}

export const weeksRouter = Router();

// GET / — list all weeks for the user
weeksRouter.get(
  "/",
  asyncWrapper(async (req: Request, res: Response) => {
    if (!req.userId) throw AppError.unauthorized();

    const pageResult = paginationSchema.safeParse(req.query);
    if (!pageResult.success) {
      throw AppError.badRequest("Invalid pagination parameters", pageResult.error.issues);
    }
    const { limit, cursor } = pageResult.data;

    const queryParsed = listQuerySchema.safeParse(req.query);
    if (!queryParsed.success) {
      throw AppError.badRequest("Invalid query parameters", queryParsed.error.issues);
    }
    const { since } = queryParsed.data;

    const weeks = await prisma.week.findMany({
      where: {
        userId: req.userId,
        ...(since ? { weekIso: { gte: since } } : {}),
      },
      take: limit,
      // Weeks cursor is weekIso (composite PK, no standalone id column).
      // We use weekIso as the cursor value via the composite unique index.
      ...(cursor
        ? {
            cursor: { userId_weekIso: { userId: req.userId, weekIso: cursor } },
            skip: 1,
          }
        : {}),
      orderBy: { weekIso: "desc" },
    });

    const nextCursor =
      weeks.length === limit ? (weeks[weeks.length - 1]?.weekIso ?? null) : null;
    sendSuccess(res, { items: weeks.map(withId), nextCursor });
  }),
);

// GET /:weekIso
weeksRouter.get(
  "/:weekIso",
  asyncWrapper(async (req: Request, res: Response) => {
    if (!req.userId) throw AppError.unauthorized();

    const weekIsoParsed = weekIsoSchema.safeParse(req.params.weekIso);
    if (!weekIsoParsed.success) {
      throw AppError.badRequest("Invalid weekIso format (expected YYYY-Www)", weekIsoParsed.error.issues);
    }

    const week = await prisma.week.findUnique({
      where: { userId_weekIso: { userId: req.userId, weekIso: weekIsoParsed.data } },
    });

    if (!week) throw AppError.notFound("Week");

    sendSuccess(res, withId(week));
  }),
);

// PUT /:weekIso — upsert by composite key
weeksRouter.put(
  "/:weekIso",
  writeRateLimiter,
  asyncWrapper(async (req: Request, res: Response) => {
    if (!req.userId) throw AppError.unauthorized();

    const weekIsoParsed = weekIsoSchema.safeParse(req.params.weekIso);
    if (!weekIsoParsed.success) {
      throw AppError.badRequest("Invalid weekIso format (expected YYYY-Www)", weekIsoParsed.error.issues);
    }

    const bodyParsed = weekBodySchema.safeParse(req.body);
    if (!bodyParsed.success) {
      throw AppError.badRequest("Invalid Week body", bodyParsed.error.issues);
    }

    const weekIso = weekIsoParsed.data;
    const {
      deterministicSnapshot,
      aiRetrospective,
      userAnnotations,
      conversationUpdatedAt,
      hasConversation,
      lastConversationThreadId,
    }: WeekBody = bodyParsed.data;

    // Build the shared update payload (userId never comes from body).
    const sharedFields = {
      deterministicSnapshot: deterministicSnapshot as Parameters<typeof prisma.week.upsert>[0]["create"]["deterministicSnapshot"],
      aiRetrospective: aiRetrospective as Parameters<typeof prisma.week.upsert>[0]["create"]["aiRetrospective"],
      userAnnotations: userAnnotations as Parameters<typeof prisma.week.upsert>[0]["create"]["userAnnotations"],
      conversationUpdatedAt: conversationUpdatedAt ? new Date(conversationUpdatedAt) : undefined,
      hasConversation,
      lastConversationThreadId,
    };

    const week = await prisma.week.upsert({
      where: { userId_weekIso: { userId: req.userId, weekIso } },
      create: {
        userId: req.userId,
        weekIso,
        ...sharedFields,
        createdAt: new Date(),
      },
      update: sharedFields,
    });

    // Deliberately 200 (not 201) on both create and update: a week doc is an
    // idempotent per-(user, weekIso) record the client re-PUTs as it accrues
    // data; the create-vs-update distinction carries no client-side meaning
    // (same rationale as conversation-rolling-summary).
    sendSuccess(res, withId(week));
  }),
);
