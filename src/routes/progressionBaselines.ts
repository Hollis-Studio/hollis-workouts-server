/**
 * @ai-context ProgressionBaselines resource router — CRUD for ProgressionBaseline records.
 *
 * Special case: composite primary key @@id([userId, canonicalExerciseId]) — no
 * surrogate id column. URL param is `canonicalExerciseId`. All upsert/delete
 * operations use the compound Prisma where clause
 * `{ userId_canonicalExerciseId: { userId, canonicalExerciseId } }`.
 *
 * DELETE style: hard
 * Wired by: src/routes/index.ts at /progression-baselines
 *
 * deps: lib/prisma, lib/AppError, middleware/errorHandler, middleware/rateLimit,
 *       utils/response, validation/common, @hollis-studio/contracts
 * consumers: routes/index.ts
 */

import { Router } from "express";
import { ProgressionBaselineSchema } from "@hollis-studio/contracts/progression/baseline";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/AppError.js";
import { asyncWrapper } from "../middleware/errorHandler.js";
import { writeRateLimiter } from "../middleware/rateLimit.js";
import { sendSuccess, sendCreated } from "../utils/response.js";
import { idSchema, paginationSchema } from "../validation/common.js";

// ---------------------------------------------------------------------------
// Body schema — userId and canonicalExerciseId come from the token/URL param,
// never from the request body.  All other progression baseline fields.
// ---------------------------------------------------------------------------

const progressionBaselineBodySchema = ProgressionBaselineSchema.omit({
  userId: true,
  canonicalExerciseId: true,
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const progressionBaselinesRouter = Router();

// ── GET / — list all baselines for the authenticated user ──────────────────

progressionBaselinesRouter.get(
  "/",
  asyncWrapper(async (req, res) => {
    if (!req.userId) throw AppError.unauthorized();

    const pageResult = paginationSchema.safeParse(req.query);
    if (!pageResult.success) {
      throw AppError.badRequest("Invalid pagination parameters", pageResult.error.issues);
    }
    const { limit, cursor } = pageResult.data;
    const userId = req.userId;

    // Cursor pagination: the model has no surrogate id, so we cursor on the
    // composite PK (userId_canonicalExerciseId). The client only needs to send
    // back the last canonicalExerciseId; userId is supplied from the token.
    // canonicalExerciseId is the unique tiebreaker for the lastUpdated sort.
    const items = await prisma.progressionBaseline.findMany({
      where: { userId },
      take: limit,
      ...(cursor
        ? {
            cursor: { userId_canonicalExerciseId: { userId, canonicalExerciseId: cursor } },
            skip: 1,
          }
        : {}),
      orderBy: [{ lastUpdated: "desc" }, { canonicalExerciseId: "desc" }],
    });

    const nextCursor =
      items.length === limit ? (items[items.length - 1]?.canonicalExerciseId ?? null) : null;
    sendSuccess(res, { items, nextCursor });
  }),
);

// ── GET /:canonicalExerciseId — single baseline ────────────────────────────

progressionBaselinesRouter.get(
  "/:canonicalExerciseId",
  asyncWrapper(async (req, res) => {
    if (!req.userId) throw AppError.unauthorized();

    const { canonicalExerciseId } = req.params;
    const parsed = idSchema.safeParse(canonicalExerciseId);
    if (!parsed.success) {
      throw AppError.badRequest("Invalid canonicalExerciseId", parsed.error.issues);
    }

    const item = await prisma.progressionBaseline.findUnique({
      where: {
        userId_canonicalExerciseId: {
          userId: req.userId,
          canonicalExerciseId: parsed.data,
        },
      },
    });

    if (!item) throw AppError.notFound("ProgressionBaseline");

    sendSuccess(res, item);
  }),
);

// ── PUT /:canonicalExerciseId — composite-key upsert ──────────────────────

progressionBaselinesRouter.put(
  "/:canonicalExerciseId",
  writeRateLimiter,
  asyncWrapper(async (req, res) => {
    if (!req.userId) throw AppError.unauthorized();

    const { canonicalExerciseId } = req.params;
    const parsed = idSchema.safeParse(canonicalExerciseId);
    if (!parsed.success) {
      throw AppError.badRequest("Invalid canonicalExerciseId", parsed.error.issues);
    }

    const bodyParsed = progressionBaselineBodySchema.safeParse(req.body);
    if (!bodyParsed.success) {
      throw AppError.badRequest("Invalid ProgressionBaseline body", bodyParsed.error.issues);
    }

    const userId = req.userId;
    const exerciseId = parsed.data;
    const data = bodyParsed.data;

    // Pre-check existence so the response status is correct (200 update / 201
    // create) while the write itself stays atomic via upsert. The where is
    // user-scoped (composite PK includes userId) so there is no IDOR risk.
    const existing = await prisma.progressionBaseline.findUnique({
      where: { userId_canonicalExerciseId: { userId, canonicalExerciseId: exerciseId } },
    });

    const item = await prisma.progressionBaseline.upsert({
      where: {
        userId_canonicalExerciseId: {
          userId,
          canonicalExerciseId: exerciseId,
        },
      },
      create: {
        userId,
        canonicalExerciseId: exerciseId,
        ...data,
        createdAt: new Date(),
      },
      update: {
        ...data,
      },
    });

    if (existing) return sendSuccess(res, item); // 200 on update
    return sendCreated(res, item); // 201 on create
  }),
);

// ── DELETE /:canonicalExerciseId — hard delete by composite key ────────────

progressionBaselinesRouter.delete(
  "/:canonicalExerciseId",
  writeRateLimiter,
  asyncWrapper(async (req, res) => {
    if (!req.userId) throw AppError.unauthorized();

    const { canonicalExerciseId } = req.params;
    const parsed = idSchema.safeParse(canonicalExerciseId);
    if (!parsed.success) {
      throw AppError.badRequest("Invalid canonicalExerciseId", parsed.error.issues);
    }

    const userId = req.userId;
    const exerciseId = parsed.data;

    // IDOR guard: confirm the record exists and belongs to this user
    const existing = await prisma.progressionBaseline.findUnique({
      where: {
        userId_canonicalExerciseId: {
          userId,
          canonicalExerciseId: exerciseId,
        },
      },
    });
    if (!existing) throw AppError.notFound("ProgressionBaseline");

    await prisma.progressionBaseline.delete({
      where: {
        userId_canonicalExerciseId: {
          userId,
          canonicalExerciseId: exerciseId,
        },
      },
    });

    sendSuccess(res, { deleted: true });
  }),
);
