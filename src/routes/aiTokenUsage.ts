/**
 * @ai-context AiTokenUsage resource router — monthly token telemetry per user.
 *
 * Each row is keyed by (userId, month) — unique constraint mirrors the Firestore
 * doc-id pattern `users/{uid}/aiUsage/{yyyy-mm}`. The row also has a surrogate
 * `id` column (String @id) to satisfy the REST PUT /:month pattern without
 * requiring a composite-PK upsert.
 *
 * Verbs:
 *   GET  /          — list the caller's monthly usage entries; ?month= filter
 *   PUT  /:month    — upsert the month entry (merge semantics — token counts are
 *                     ADDED to existing values, not replaced); month param is
 *                     the ISO month key "yyyy-mm"
 *
 * Merge semantics on PUT: the route reads the existing row's tokens map and
 * merges the incoming map into it (existing + incoming per key), then writes
 * the merged result. This matches the Cloud Function addTokens behaviour.
 *
 * Wired by: src/routes/index.ts at /ai-token-usage
 *   apiRouter.use("/ai-token-usage", aiTokenUsageRouter);
 *
 * deps: express, zod, lib/AppError, lib/prisma, middleware/errorHandler,
 *       middleware/rateLimit, utils/response
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

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** ISO month key — "yyyy-mm" */
const monthSchema = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/, "month must be yyyy-mm");

/** Query params for GET / */
const listQuerySchema = z.object({
  month: monthSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

/**
 * PUT body — tokens map: Record<string, number>.
 * Each entry represents token counts for a named feature (e.g. smart_builder).
 * Values must be non-negative integers (token counts are whole numbers).
 */
const aiTokenUsageBodySchema = z.object({
  tokens: z.record(z.string().min(1).max(64), z.number().int().nonnegative()),
  createdAt: z.coerce.date().optional(),
  updatedAt: z.coerce.date().optional(),
});

type AiTokenUsageBody = z.infer<typeof aiTokenUsageBodySchema>;

export const aiTokenUsageRouter = Router();

// GET / — list user's monthly entries
aiTokenUsageRouter.get(
  "/",
  asyncWrapper(async (req: Request, res: Response) => {
    if (!req.userId) throw AppError.unauthorized();

    const queryParsed = listQuerySchema.safeParse(req.query);
    if (!queryParsed.success) {
      throw AppError.badRequest("Invalid query parameters", queryParsed.error.issues);
    }
    const { month, limit, cursor } = queryParsed.data;

    const items = await prisma.aiTokenUsage.findMany({
      where: {
        userId: req.userId,
        ...(month ? { month } : {}),
      },
      take: limit,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      // Most recent month first; `id` is unique tiebreaker for cursor stability.
      orderBy: [{ month: "desc" }, { id: "desc" }],
    });

    const nextCursor =
      items.length === limit ? (items[items.length - 1]?.id ?? null) : null;
    sendSuccess(res, { items, nextCursor });
  }),
);

// PUT /:month — upsert with merge semantics
//
// Security: AiTokenUsage has a UNIQUE constraint on (userId, month) but uses a
// surrogate `id` PK. We cannot use the CRUD factory because the URL param is
// `month` (not `id`) and upsert must use the composite unique key
// `{ userId_month: { userId, month } }` — not a single-column key.
// Merge semantics: existing token counts are summed with incoming counts so that
// multiple sources (Cloud Function + client) can safely increment in parallel.
aiTokenUsageRouter.put(
  "/:month",
  writeRateLimiter,
  asyncWrapper(async (req: Request, res: Response) => {
    if (!req.userId) throw AppError.unauthorized();

    const monthParsed = monthSchema.safeParse(req.params.month);
    if (!monthParsed.success) {
      throw AppError.badRequest("Invalid month parameter", monthParsed.error.issues);
    }

    const bodyParsed = aiTokenUsageBodySchema.safeParse(req.body);
    if (!bodyParsed.success) {
      throw AppError.badRequest("Invalid AiTokenUsage body", bodyParsed.error.issues);
    }

    const { tokens, createdAt: bodyCreatedAt }: AiTokenUsageBody = bodyParsed.data;
    const month = monthParsed.data;
    const userId = req.userId;

    // IDOR guard + merge read: fetch existing row scoped to this user.
    const existing = await prisma.aiTokenUsage.findUnique({
      where: { userId_month: { userId, month } },
    });

    if (existing) {
      // Merge: add incoming token counts on top of existing counts.
      const existingTokens =
        existing.tokens !== null &&
        typeof existing.tokens === "object" &&
        !Array.isArray(existing.tokens)
          ? (existing.tokens as Record<string, unknown>)
          : {};

      const mergedTokens: Record<string, number> = { ...Object.fromEntries(
        Object.entries(existingTokens).map(([k, v]) => [k, Number(v ?? 0)]),
      ) };
      for (const [feature, count] of Object.entries(tokens)) {
        mergedTokens[feature] = (mergedTokens[feature] ?? 0) + count;
      }

      // Defense-in-depth: update scoped to { userId, month } so even if the
      // pre-check above were stale, this write cannot touch another user's row.
      const item = await prisma.aiTokenUsage.update({
        where: { userId_month: { userId, month } },
        data: {
          tokens: mergedTokens as Parameters<
            typeof prisma.aiTokenUsage.update
          >[0]["data"]["tokens"],
        },
      });
      return sendSuccess(res, item);
    }

    // Create — no row yet for this (userId, month).
    const createdAt =
      bodyCreatedAt instanceof Date ? bodyCreatedAt : new Date();

    const item = await prisma.aiTokenUsage.create({
      data: {
        id: crypto.randomUUID(),
        userId,
        month,
        tokens: tokens as Parameters<
          typeof prisma.aiTokenUsage.create
        >[0]["data"]["tokens"],
        createdAt,
      },
    });
    return sendSuccess(res, item);
  }),
);
