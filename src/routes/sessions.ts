/**
 * @ai-context Sessions resource router — CRUD for TrainingSessionLog records.
 *
 * DELETE style: hard (with cascade delete of metric-basket snapshots)
 * Wired by: src/routes/index.ts at /sessions
 *
 * Design notes:
 *   - Written as direct handlers (not via createCrudRouter) because sessions
 *     need: custom list ordering (completedAt/startedAt desc), query filters
 *     (?status, ?since, ?programId), and a transactional cascade DELETE.
 *   - PUT accepts active sessions (offline-first; client generates the UUID and
 *     may save an in-progress session before completion).
 *   - Body schema is ActiveTrainingSessionLogSchema from @hollis-studio/contracts
 *     which allows an empty exercises array (covering in-progress saves).
 *     `skippedExerciseIds` is defaulted to [] when omitted.
 *   - exercises and questionnaire JSON columns are validated by Zod before write.
 *   - CASCADE DELETE: in a single prisma.$transaction, delete all
 *     MetricBasketSnapshotRecord rows where { userId, sourceSessionId: id },
 *     then delete the session itself.
 *
 * deps: lib/prisma, lib/AppError, middleware/errorHandler, middleware/rateLimit,
 *       utils/response, validation/common, @hollis-studio/contracts
 * consumers: routes/index.ts
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import {
  ActiveTrainingSessionLogSchema,
  SessionExerciseSchema,
  QuestionnaireResponseSchema,
} from "@hollis-studio/contracts/domain/training-session-log";

import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/AppError.js";
import { asyncWrapper } from "../middleware/errorHandler.js";
import { writeRateLimiter } from "../middleware/rateLimit.js";
import { sendSuccess, sendCreated } from "../utils/response.js";
import { idSchema, paginationSchema } from "../validation/common.js";

// ---------------------------------------------------------------------------
// Body schema
//
// Use ActiveTrainingSessionLogSchema from contracts — it allows an empty
// exercises array, covering both in-progress and completed sessions.
// We strip id/userId from the body since those come from the URL and token.
// skippedExerciseIds is defaulted to [] here so the Prisma write always gets
// a non-null String[].
// ---------------------------------------------------------------------------

const sessionBodySchema = ActiveTrainingSessionLogSchema.omit({
  id: true,
  userId: true,
}).extend({
  skippedExerciseIds: z.array(z.string()).default([]),
});

// Re-usable schemas for JSON column validation (already bundled in the body
// schema, but aliased for clarity in the PUT handler's explicit checks).
const exercisesArraySchema = z.array(SessionExerciseSchema);

// ---------------------------------------------------------------------------
// List filters schema — parsed from req.query
// ---------------------------------------------------------------------------

const listFiltersSchema = z.object({
  status: z.enum(["active", "completed", "abandoned"]).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  programId: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router = Router();

// ── GET / — list user's sessions ───────────────────────────────────────────
//
// Filters: ?status=active|completed|abandoned, ?since=<ISO datetime>,
//           ?programId=<id>
// Pagination: ?limit (default 50, max 200), ?cursor
// Order: completedAt desc nulls last; ties broken by startedAt desc.

router.get(
  "/",
  asyncWrapper(async (req: Request, res: Response) => {
    if (!req.userId) throw AppError.unauthorized();

    const pageResult = paginationSchema.safeParse(req.query);
    if (!pageResult.success) {
      throw AppError.badRequest("Invalid pagination parameters", pageResult.error.issues);
    }
    const { limit, cursor } = pageResult.data;

    const filterResult = listFiltersSchema.safeParse(req.query);
    if (!filterResult.success) {
      throw AppError.badRequest("Invalid filter parameters", filterResult.error.issues);
    }
    const { status, since, programId } = filterResult.data;

    const where: Record<string, unknown> = { userId: req.userId };
    if (status !== undefined) where.status = status;
    if (since !== undefined) where.updatedAt = { gte: new Date(since) };
    if (programId !== undefined) where.programId = programId;

    const items = await prisma.session.findMany({
      where,
      take: limit,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      // completedAt desc with NULLS LAST so in-progress (completedAt: null)
      // sessions sort last, not first (Postgres defaults DESC → NULLS FIRST).
      // `id` is the unique tiebreaker for stable cursor pagination.
      orderBy: [
        { completedAt: { sort: "desc", nulls: "last" } },
        { startedAt: "desc" },
        { id: "desc" },
      ],
    });

    const nextCursor = items.length === limit ? (items[items.length - 1]?.id ?? null) : null;
    sendSuccess(res, { items, nextCursor });
  }),
);

// ── GET /:id — single session ──────────────────────────────────────────────

router.get(
  "/:id",
  asyncWrapper(async (req: Request, res: Response) => {
    if (!req.userId) throw AppError.unauthorized();

    const idParsed = idSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      throw AppError.badRequest("Invalid session id", idParsed.error.issues);
    }

    const session = await prisma.session.findFirst({
      where: { id: idParsed.data, userId: req.userId },
    });
    if (!session) throw AppError.notFound("Session");

    sendSuccess(res, session);
  }),
);

// ── PUT /:id — idempotent upsert (offline-first) ───────────────────────────
//
// Accepts both active and completed sessions. The client generates the UUID.
// No status restriction — active sessions may be saved before completion.

router.put(
  "/:id",
  writeRateLimiter,
  asyncWrapper(async (req: Request, res: Response) => {
    if (!req.userId) throw AppError.unauthorized();

    const idParsed = idSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      throw AppError.badRequest("Invalid session id", idParsed.error.issues);
    }

    const bodyParsed = sessionBodySchema.safeParse(req.body);
    if (!bodyParsed.success) {
      throw AppError.badRequest("Invalid session body", bodyParsed.error.issues);
    }

    const body = bodyParsed.data;

    // Validate the exercises JSON blob explicitly (belt-and-suspenders; Zod
    // already ran it above via sessionBodySchema, but this makes the error
    // path explicit and readable for callers).
    const exParsed = exercisesArraySchema.safeParse(body.exercises);
    if (!exParsed.success) {
      throw AppError.badRequest("Invalid exercises data", exParsed.error.issues);
    }

    // Validate the questionnaire JSON blob.
    const qParsed = QuestionnaireResponseSchema.safeParse(body.questionnaire);
    if (!qParsed.success) {
      throw AppError.badRequest("Invalid questionnaire data", qParsed.error.issues);
    }

    const id = idParsed.data;
    const userId = req.userId;

    // Build the Prisma data payload. userId is authoritative from the token.
    const writeData = {
      userId,
      programId: body.programId ?? null,
      programDayName: body.programDayName ?? null,
      gymProfileId: body.gymProfileId ?? null,
      startedAt: body.startedAt,
      completedAt: body.completedAt ?? null,
      isFreestyle: body.isFreestyle,
      isSubstitution: body.isSubstitution,
      status: body.status,
      questionnaire: qParsed.data,
      totalVolumeKg: body.totalVolumeKg,
      durationMinutes: body.durationMinutes,
      untrackedVolume: body.untrackedVolume ?? null,
      aiOutlierLabel: body.aiOutlierLabel ?? null,
      schemaVersion: body.schemaVersion ?? null,
      programPhase: body.programPhase ?? null,
      skippedExerciseIds: body.skippedExerciseIds,
      exercises: exParsed.data,
    };

    // IDOR guard: check ownership before deciding create vs update.
    // prisma.session.upsert keys only on the global PK (`id`), so it would
    // allow any authenticated user to overwrite another user's session by id.
    // Instead we do a two-step: findFirst scoped to this user, then
    // update (200) or create (201).
    const existing = await prisma.session.findFirst({
      where: { id, userId },
    });

    if (existing) {
      // userId in the where is defense-in-depth: even if the ownership
      // pre-check above were stale, the write still cannot touch another
      // user's row (mirrors the CRUD factory).
      const session = await prisma.session.update({
        where: { id, userId },
        data: writeData,
      });
      return sendSuccess(res, session);     // 200 on update
    }

    const session = await prisma.session.create({
      data: { id, ...writeData },
    });
    return sendCreated(res, session);       // 201 on create
  }),
);

// ── DELETE /:id — hard delete with cascade ─────────────────────────────────
//
// Deletes all MetricBasketSnapshotRecord rows with sourceSessionId = id
// for the same user in the same transaction, then deletes the session.

router.delete(
  "/:id",
  writeRateLimiter,
  asyncWrapper(async (req: Request, res: Response) => {
    if (!req.userId) throw AppError.unauthorized();

    const idParsed = idSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      throw AppError.badRequest("Invalid session id", idParsed.error.issues);
    }

    const id = idParsed.data;
    const userId = req.userId;

    // IDOR guard: confirm ownership before deleting.
    const existing = await prisma.session.findFirst({
      where: { id, userId },
    });
    if (!existing) throw AppError.notFound("Session");

    // Cascade: delete metric-basket snapshots triggered by this session,
    // then delete the session itself — atomically.
    await prisma.$transaction([
      prisma.metricBasketSnapshotRecord.deleteMany({
        where: { userId, sourceSessionId: id },
      }),
      // userId in the where is defense-in-depth (see PUT update above).
      prisma.session.delete({
        where: { id, userId },
      }),
    ]);

    sendSuccess(res, { deleted: true });
  }),
);

export const sessionsRouter = router;
