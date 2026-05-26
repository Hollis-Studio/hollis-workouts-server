/**
 * @ai-context Generic user-scoped CRUD router factory for Workouts Server.
 *
 * Produces an Express Router with standard CRUD verbs for any Prisma delegate
 * that follows the { id, userId, ... } ownership pattern.
 *
 * REQUIREMENT: the delegate's model MUST have BOTH an `id` column (the cursor +
 * single-PK where clause) AND a `createdAt` column (the list orderBy + create
 * path). Models without these (composite-PK baselines/weeks, the createdAt-less
 * Session) use bespoke routers instead — do NOT route them through this factory.
 *
 * Implemented verbs:
 *   GET    /          — list (user-scoped, optional query filters via listFilters hook)
 *   GET    /:id       — findFirst by { id, userId } → 404 if absent (IDOR-safe)
 *   PUT    /:id       — idempotent upsert by { id, userId } (offline-first client IDs)
 *   DELETE /:id       — hard delete (deleteStyle: 'hard') or
 *   PATCH  /:id       — soft delete — sets isActive:false (deleteStyle: 'soft')
 *
 * Key design decisions:
 *   - Caller supplies the Prisma delegate as a plain object.  Full generics over
 *     Prisma's complex union delegate types are impractical, so the delegate is
 *     typed as `PrismaDelegate` (see below) — a minimal interface with only the
 *     four methods the factory calls.  The `any` in that interface is isolated
 *     to this one well-commented spot and does not leak into handler signatures.
 *   - All writes (PUT, DELETE, PATCH) go through writeRateLimiter before the
 *     asyncWrapper, so the per-user limit is enforced before any DB I/O.
 *   - createdAt is set explicitly in the PUT create path (schema has no @default(now())).
 *   - userId is always taken from req.userId (set by requireAuth), never from body.
 *
 * deps: express, zod, lib/AppError, lib/prisma, middleware/errorHandler,
 *       middleware/rateLimit, utils/response, validation/common
 * consumers: src/routes/*.ts
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { AppError } from "./AppError.js";
import { asyncWrapper } from "../middleware/errorHandler.js";
import { writeRateLimiter } from "../middleware/rateLimit.js";
import { sendSuccess, sendCreated } from "../utils/response.js";
import { idSchema, paginationSchema } from "../validation/common.js";

// ---------------------------------------------------------------------------
// Minimal Prisma delegate interface
//
// Prisma's concrete delegate types (GymDelegate, ProgramDelegate, …) have
// complex generic bounds that cannot be unified into a single generic parameter
// without reproducing the entire Prisma type machinery.  Instead, we declare
// a structural "duck-type" interface that only requires the four methods the
// factory actually calls.  The `any` parameters here are the minimal isolation
// point — all handler-level types are still sound because the returned data
// flows into sendSuccess/sendCreated which accept generic T.
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PrismaDelegate {
  findMany(args: any): Promise<any[]>;
  findFirst(args: any): Promise<any | null>;
  create(args: any): Promise<any>;
  update(args: any): Promise<any>;
  delete(args: any): Promise<any>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Factory configuration
// ---------------------------------------------------------------------------

export interface CrudConfig<TBody extends z.ZodTypeAny> {
  /**
   * Prisma delegate, e.g. `prisma.gym`.
   * Typed as PrismaDelegate — the `any` is isolated to that interface above.
   */
  delegate: PrismaDelegate;

  /**
   * Human-readable resource name for 404 messages, e.g. "Gym".
   */
  resourceName: string;

  /**
   * Zod schema for the request body on PUT.
   * Use `z.object({}).passthrough()` as a stub; replace with the real schema.
   */
  bodySchema: TBody;

  /**
   * Name of the id path parameter (default: "id").
   * Use "canonicalExerciseId" for progression/cardio baselines.
   * Use "weekIso" for weeks.
   */
  idParam?: string;

  /**
   * "hard" → DELETE /:id (prisma.delete)
   * "soft" → PATCH  /:id (prisma.update → { isActive: false })
   */
  deleteStyle: "hard" | "soft";

  /**
   * Optional hook — returns extra where-clause filters derived from req.query
   * for the GET / list handler.  Only scalar/enum query params should be used;
   * do NOT trust user-supplied IDs as ownership filters (userId is always
   * applied separately by the factory).
   *
   * Example:
   *   listFilters: (req) => ({
   *     isActive: req.query.isActive !== "false",
   *   })
   */
  listFilters?: (req: Request) => Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * createCrudRouter — produce a Router implementing standard CRUD for one resource.
 */
export function createCrudRouter<TBody extends z.ZodTypeAny>(
  config: CrudConfig<TBody>,
): Router {
  const {
    delegate,
    resourceName,
    bodySchema,
    idParam = "id",
    deleteStyle,
    listFilters,
  } = config;

  const router = Router();

  // ── GET / — list ──────────────────────────────────────────────────────────

  router.get(
    "/",
    asyncWrapper(async (req: Request, res: Response) => {
      if (!req.userId) throw AppError.unauthorized();

      // Pagination
      const pageResult = paginationSchema.safeParse(req.query);
      if (!pageResult.success) {
        throw AppError.badRequest("Invalid pagination parameters", pageResult.error.issues);
      }
      const { limit, cursor } = pageResult.data;

      const extraFilters = listFilters ? listFilters(req) : {};

      const items = await delegate.findMany({
        // userId is spread LAST so it always wins — a listFilters hook can never
        // override the ownership scope (structural IDOR guard, not just docs).
        where: { ...extraFilters, userId: req.userId },
        take: limit,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        // Stable cursor pagination: `id` is the unique tiebreaker so rows that
        // share a createdAt timestamp cannot be skipped or duplicated across
        // page boundaries (cursor is on id; orderBy must include it).
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });

      sendSuccess(res, { items, nextCursor: items.length === limit ? items[items.length - 1]?.id : null });
    }),
  );

  // ── GET /:id — single resource ────────────────────────────────────────────

  router.get(
    `/:${idParam}`,
    asyncWrapper(async (req: Request, res: Response) => {
      if (!req.userId) throw AppError.unauthorized();

      const idValue = req.params[idParam];
      const parsed = idSchema.safeParse(idValue);
      if (!parsed.success) {
        throw AppError.badRequest(`Invalid ${idParam}`, parsed.error.issues);
      }

      const item = await delegate.findFirst({
        where: { [idParam]: parsed.data, userId: req.userId },
      });

      if (!item) throw AppError.notFound(resourceName);

      sendSuccess(res, item);
    }),
  );

  // ── PUT /:id — idempotent upsert (ownership-checked two-step) ────────────
  //
  // Security: we do NOT use prisma.upsert({ where: { [idParam]: id } }) because
  // that keys only on the PK — a malicious user could overwrite another user's
  // row by guessing its id.  Instead:
  //   1. findFirst({ where: { id, userId } }) — ownership check
  //   2a. If found → update (200)
  //   2b. If not found → create (201); if the PK belongs to another user the DB
  //       unique constraint will reject the insert — that's the intended behavior.
  //       We do NOT distinguish "PK conflict" from other errors to avoid leaking
  //       row-existence information to the requester.

  router.put(
    `/:${idParam}`,
    writeRateLimiter,
    asyncWrapper(async (req: Request, res: Response) => {
      if (!req.userId) throw AppError.unauthorized();

      const idValue = req.params[idParam];
      const idParsed = idSchema.safeParse(idValue);
      if (!idParsed.success) {
        throw AppError.badRequest(`Invalid ${idParam}`, idParsed.error.issues);
      }

      const bodyParsed = bodySchema.safeParse(req.body);
      if (!bodyParsed.success) {
        throw AppError.badRequest(`Invalid ${resourceName} body`, bodyParsed.error.issues);
      }

      // Strip server-managed timestamps from the client-supplied body so that
      // clients cannot rewrite them.  createdAt on the create path is handled
      // separately below (we honour a client-supplied value for resources like
      // injuries that carry a meaningful event date, otherwise we use now).
      // updatedAt is always Prisma-managed and never accepted from the body.
      const rawData = bodyParsed.data as Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { createdAt: bodyCreatedAt, updatedAt: _updatedAt, userId: _userId, ...updateData } = rawData;

      // userId is always authoritative from the token — never from body.
      const ownedUpdateData = { ...updateData, userId: req.userId };

      // Step 1: ownership check
      const existing = await delegate.findFirst({
        where: { [idParam]: idParsed.data, userId: req.userId },
      });

      if (existing) {
        // Step 2a: UPDATE — row exists and belongs to this user
        const item = await delegate.update({
          where: { [idParam]: idParsed.data, userId: req.userId },
          data: ownedUpdateData,
        });
        return sendSuccess(res, item);
      }

      // Step 2b: CREATE — row does not exist for this user.
      // Use client-supplied createdAt if provided (meaningful event date), else now.
      const createdAt =
        bodyCreatedAt instanceof Date
          ? bodyCreatedAt
          : typeof bodyCreatedAt === "string" && bodyCreatedAt.length > 0
            ? new Date(bodyCreatedAt)
            : new Date();

      const item = await delegate.create({
        data: { [idParam]: idParsed.data, ...ownedUpdateData, createdAt },
      });
      return sendCreated(res, item);
    }),
  );

  // ── DELETE /:id (hard) or PATCH /:id (soft) ───────────────────────────────

  if (deleteStyle === "hard") {
    router.delete(
      `/:${idParam}`,
      writeRateLimiter,
      asyncWrapper(async (req: Request, res: Response) => {
        if (!req.userId) throw AppError.unauthorized();

        const idValue = req.params[idParam];
        const parsed = idSchema.safeParse(idValue);
        if (!parsed.success) {
          throw AppError.badRequest(`Invalid ${idParam}`, parsed.error.issues);
        }

        // IDOR guard: confirm ownership before deleting
        const existing = await delegate.findFirst({
          where: { [idParam]: parsed.data, userId: req.userId },
        });
        if (!existing) throw AppError.notFound(resourceName);

        // Defense-in-depth: include userId in the delete where clause so that
        // even if the pre-check result is stale, the DB op cannot touch another
        // user's row.
        await delegate.delete({ where: { [idParam]: parsed.data, userId: req.userId } });

        sendSuccess(res, { deleted: true });
      }),
    );
  } else {
    // Soft delete — PATCH sets isActive: false
    router.patch(
      `/:${idParam}`,
      writeRateLimiter,
      asyncWrapper(async (req: Request, res: Response) => {
        if (!req.userId) throw AppError.unauthorized();

        const idValue = req.params[idParam];
        const parsed = idSchema.safeParse(idValue);
        if (!parsed.success) {
          throw AppError.badRequest(`Invalid ${idParam}`, parsed.error.issues);
        }

        // IDOR guard: confirm ownership before updating
        const existing = await delegate.findFirst({
          where: { [idParam]: parsed.data, userId: req.userId },
        });
        if (!existing) throw AppError.notFound(resourceName);

        // Defense-in-depth: include userId in the update where clause so that
        // even if the pre-check result is stale, the DB op cannot touch another
        // user's row.
        const item = await delegate.update({
          where: { [idParam]: parsed.data, userId: req.userId },
          data: { isActive: false },
        });

        sendSuccess(res, item);
      }),
    );
  }

  return router;
}
