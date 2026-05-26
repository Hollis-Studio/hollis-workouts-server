/**
 * @ai-context CardioBaselines resource router — CRUD for CardioBaseline records.
 *
 * Special case: composite primary key @@id([userId, canonicalExerciseId]) — no
 * surrogate id column. URL param is `canonicalExerciseId`. All upsert/delete
 * operations use the compound Prisma where clause
 * `{ userId_canonicalExerciseId: { userId, canonicalExerciseId } }`.
 *
 * bestMETs note: CardioBaselineSchema declares bestMETs as
 * z.number().nullable().default(null). Zod always produces the key in parsed
 * output (null when absent), so the create/update payloads always include
 * bestMETs explicitly — satisfying the app-schema requirement that the key be
 * present (never omitted).
 *
 * DELETE style: hard
 * Wired by: src/routes/index.ts at /cardio-baselines
 *
 * deps: lib/prisma, lib/AppError, middleware/errorHandler, middleware/rateLimit,
 *       utils/response, validation/common, @hollis-studio/contracts
 * consumers: routes/index.ts
 */

import { Router } from "express";
import { CardioBaselineSchema } from "@hollis-studio/contracts/progression/baseline";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/AppError.js";
import { asyncWrapper } from "../middleware/errorHandler.js";
import { writeRateLimiter } from "../middleware/rateLimit.js";
import { sendSuccess, sendCreated } from "../utils/response.js";
import { idSchema, paginationSchema } from "../validation/common.js";

// ---------------------------------------------------------------------------
// Body schema — userId and canonicalExerciseId come from the token/URL param,
// never from the request body.  All other cardio baseline fields.
//
// bestMETs is z.number().nullable().default(null) in CardioBaselineSchema:
// Zod's `.default(null)` ensures bestMETs is always present in parsed output
// (null when the client omits it), so the Prisma create/update payload always
// includes the key explicitly — never omits it.
// ---------------------------------------------------------------------------

const cardioBaselineBodySchema = CardioBaselineSchema.omit({
  userId: true,
  canonicalExerciseId: true,
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const cardioBaselinesRouter = Router();

// ── GET / — list all cardio baselines for the authenticated user ───────────

cardioBaselinesRouter.get(
  "/",
  asyncWrapper(async (req, res) => {
    if (!req.userId) throw AppError.unauthorized();

    const pageResult = paginationSchema.safeParse(req.query);
    if (!pageResult.success) {
      throw AppError.badRequest("Invalid pagination parameters", pageResult.error.issues);
    }
    const { limit, cursor } = pageResult.data;
    const userId = req.userId;

    // Cursor pagination on the composite PK (no surrogate id). Client returns
    // the last canonicalExerciseId; userId comes from the token. See
    // progressionBaselines.ts for the full rationale.
    const items = await prisma.cardioBaseline.findMany({
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

// ── GET /:canonicalExerciseId — single cardio baseline ────────────────────

cardioBaselinesRouter.get(
  "/:canonicalExerciseId",
  asyncWrapper(async (req, res) => {
    if (!req.userId) throw AppError.unauthorized();

    const { canonicalExerciseId } = req.params;
    const parsed = idSchema.safeParse(canonicalExerciseId);
    if (!parsed.success) {
      throw AppError.badRequest("Invalid canonicalExerciseId", parsed.error.issues);
    }

    const item = await prisma.cardioBaseline.findUnique({
      where: {
        userId_canonicalExerciseId: {
          userId: req.userId,
          canonicalExerciseId: parsed.data,
        },
      },
    });

    if (!item) throw AppError.notFound("CardioBaseline");

    sendSuccess(res, item);
  }),
);

// ── PUT /:canonicalExerciseId — composite-key upsert ──────────────────────

cardioBaselinesRouter.put(
  "/:canonicalExerciseId",
  writeRateLimiter,
  asyncWrapper(async (req, res) => {
    if (!req.userId) throw AppError.unauthorized();

    const { canonicalExerciseId } = req.params;
    const parsed = idSchema.safeParse(canonicalExerciseId);
    if (!parsed.success) {
      throw AppError.badRequest("Invalid canonicalExerciseId", parsed.error.issues);
    }

    const bodyParsed = cardioBaselineBodySchema.safeParse(req.body);
    if (!bodyParsed.success) {
      throw AppError.badRequest("Invalid CardioBaseline body", bodyParsed.error.issues);
    }

    const userId = req.userId;
    const exerciseId = parsed.data;
    // bestMETs is always present in data (null when client omits it) because
    // CardioBaselineSchema uses z.number().nullable().default(null).
    const data = bodyParsed.data;

    // Pre-check existence for correct 200/201 status; write stays atomic via
    // upsert. Composite PK includes userId, so no IDOR risk.
    const existing = await prisma.cardioBaseline.findUnique({
      where: { userId_canonicalExerciseId: { userId, canonicalExerciseId: exerciseId } },
    });

    const item = await prisma.cardioBaseline.upsert({
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

cardioBaselinesRouter.delete(
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
    const existing = await prisma.cardioBaseline.findUnique({
      where: {
        userId_canonicalExerciseId: {
          userId,
          canonicalExerciseId: exerciseId,
        },
      },
    });
    if (!existing) throw AppError.notFound("CardioBaseline");

    await prisma.cardioBaseline.delete({
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
