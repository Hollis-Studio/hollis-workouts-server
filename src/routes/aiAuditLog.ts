/**
 * @ai-context AiAuditLog resource router — immutable append-only log.
 *
 * Special case: immutable — no PUT/PATCH/DELETE.
 * On POST the server assigns the id (crypto.randomUUID() — no @paralleldrive/cuid2 in deps).
 * The server ALWAYS sets timestamp = new Date() — client-supplied timestamps are rejected
 * to prevent backdating that would allow entries to evade the ?since filter.
 *
 * The Prisma model is FLATTENED: sourceRef, snapshotInline, aiOutput, diff are
 * top-level columns, not nested inside a `payload` wrapper.
 *
 * Verbs:
 *   GET  /  — list entries (user-scoped); filters: ?since=<ISO datetime> ?surface=<string> ?limit=<n>
 *   POST /  — create entry; server assigns id; timestamp defaults to now
 *
 * Wired by: src/routes/index.ts at /ai-audit-log
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
import { sendSuccess, sendCreated } from "../utils/response.js";
import { idSchema } from "../validation/common.js";

// ---------------------------------------------------------------------------
// Body schema — mirrors AiAuditLogEntry (flattened; no payload wrapper).
// Fields that are Json in Prisma are accepted as arbitrary objects/arrays.
// ---------------------------------------------------------------------------

const aiAuditLogBodySchema = z.object({
  // NOTE: `timestamp` is intentionally absent — the server always sets
  // `timestamp: new Date()` on create to prevent client backdating that would
  // allow entries to evade the `?since` filter. This is an immutable audit log.
  /** Which AI surface produced this entry (SuggestionSource enum value). */
  surface: z.string().min(1).max(64),
  /** "flash" | "pro" | "image" */
  modelTier: z.enum(["flash", "pro", "image"]),
  /** Path to the frozen deterministic snapshot, when applicable. */
  snapshotRef: z.string().optional(),
  /** Outcome of the AI suggestion. */
  action: z.enum(["auto_applied", "user_applied", "user_dismissed", "user_overrode"]),
  /** True iff state was actually written (vs surfaced + dismissed). */
  persisted: z.boolean(),
  // --- Flattened Json columns ---
  /** Describes the input context that triggered the AI call. Non-nullable in DB. */
  sourceRef: z.unknown().refine((v) => v !== null && v !== undefined, "sourceRef is required"),
  /** Inline snapshot for transient (non-week-scoped) calls. */
  snapshotInline: z.unknown().optional(),
  /** Raw structured AI output (schema-versioned per surface). Non-nullable in DB. */
  aiOutput: z.unknown().refine((v) => v !== null && v !== undefined, "aiOutput is required"),
  /** Delta between previous state and applied suggestion; null if not applied. */
  diff: z.unknown().optional(),
});

type AiAuditLogBody = z.infer<typeof aiAuditLogBodySchema>;

// Query filter schema for GET /
const listQuerySchema = z.object({
  // offset:true to match the sessions ?since filter — accept timezone-offset
  // ISO datetimes, not only UTC "Z".
  since: z.string().datetime({ offset: true }).optional(),
  surface: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: idSchema.optional(),
});

export const aiAuditLogRouter = Router();

// GET / — list entries (most recent first)
aiAuditLogRouter.get(
  "/",
  asyncWrapper(async (req: Request, res: Response) => {
    if (!req.userId) throw AppError.unauthorized();

    const queryParsed = listQuerySchema.safeParse(req.query);
    if (!queryParsed.success) {
      throw AppError.badRequest("Invalid query parameters", queryParsed.error.issues);
    }
    const { since, surface, limit, cursor } = queryParsed.data;

    const items = await prisma.aiAuditLogEntry.findMany({
      where: {
        userId: req.userId,
        ...(since ? { timestamp: { gte: new Date(since) } } : {}),
        ...(surface ? { surface } : {}),
      },
      take: limit,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      // id is the unique tiebreaker so entries sharing a timestamp paginate
      // stably (cursor is on id).
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
    });

    const nextCursor =
      items.length === limit ? (items[items.length - 1]?.id ?? null) : null;
    sendSuccess(res, { items, nextCursor });
  }),
);

// POST / — server-assigned id, append-only
aiAuditLogRouter.post(
  "/",
  writeRateLimiter,
  asyncWrapper(async (req: Request, res: Response) => {
    if (!req.userId) throw AppError.unauthorized();

    const bodyParsed = aiAuditLogBodySchema.safeParse(req.body);
    if (!bodyParsed.success) {
      throw AppError.badRequest("Invalid AiAuditLogEntry body", bodyParsed.error.issues);
    }

    const {
      surface,
      modelTier,
      snapshotRef,
      action,
      persisted,
      sourceRef,
      snapshotInline,
      aiOutput,
      diff,
    }: AiAuditLogBody = bodyParsed.data;

    const item = await prisma.aiAuditLogEntry.create({
      data: {
        // Server assigns immutable id — client must not supply one.
        id: crypto.randomUUID(),
        // userId is always authoritative from the token, never from body.
        userId: req.userId,
        // Timestamp is always server-assigned — never trust client time on an
        // immutable audit log (client backdating would evade the ?since filter).
        timestamp: new Date(),
        surface,
        modelTier,
        snapshotRef,
        action,
        persisted,
        // Flattened Json columns — passed directly; Prisma accepts `unknown` for Json.
        sourceRef: sourceRef as Parameters<typeof prisma.aiAuditLogEntry.create>[0]["data"]["sourceRef"],
        snapshotInline: snapshotInline !== undefined
          ? (snapshotInline as Parameters<typeof prisma.aiAuditLogEntry.create>[0]["data"]["snapshotInline"])
          : undefined,
        aiOutput: aiOutput as Parameters<typeof prisma.aiAuditLogEntry.create>[0]["data"]["aiOutput"],
        diff: diff !== undefined
          ? (diff as Parameters<typeof prisma.aiAuditLogEntry.create>[0]["data"]["diff"])
          : undefined,
      },
    });

    sendCreated(res, item);
  }),
);
