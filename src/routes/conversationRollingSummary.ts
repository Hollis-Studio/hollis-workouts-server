/**
 * @ai-context ConversationRollingSummary resource router — per-user SINGLETON.
 *
 * Special case: singleton row keyed by userId (userId IS the PK).
 * No list endpoint; no id param in URL. Only GET / and PUT /.
 *
 * GET /: returns 404 (Option A) when no row exists yet. This is consistent
 * with other singleton-first-access patterns in this server. The AI pipeline
 * that manages this document should handle 404 by creating on first PUT.
 *
 * Verbs:
 *   GET /  — fetch the user's summary document; 404 if absent
 *   PUT /  — upsert the singleton by { userId }; updatedAt is @updatedAt managed
 *
 * Wired by: src/routes/index.ts at /conversation-rolling-summary
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
// Body schema — mirrors ConversationRollingSummaryDoc.
// No formal app interface exists for this shape; defined here from the spec.
// `updatedAt` is managed by Prisma @updatedAt; clients must not send it.
// ---------------------------------------------------------------------------

const rollingSummaryEntrySchema = z.object({
  /** ISO week string this entry summarises, e.g. "2025-W20". */
  weekIso: z.string().regex(/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/),
  /** Human-readable prose summary of the week. */
  summary: z.string(),
  /** Discrete facts the AI pipeline decided to carry forward. */
  retainedFacts: z.array(z.string()),
  /** ISO datetime when this entry was created. */
  createdAt: z.string().datetime(),
});

const summaryBodySchema = z.object({
  /**
   * Array of per-week rolling summary entries.
   * Stored as Json in Prisma; validated here as a typed array.
   */
  entries: z.array(rollingSummaryEntrySchema),
  /**
   * Client-provided updatedAt timestamp (the pipeline sets this when it
   * writes; Prisma @updatedAt will overwrite on the server side, so this
   * field is accepted but not stored — Prisma manages updatedAt).
   */
  updatedAt: z.string().datetime().optional(),
});

type SummaryBody = z.infer<typeof summaryBodySchema>;

export const conversationRollingSummaryRouter = Router();

// GET / — fetch singleton for the authenticated user
conversationRollingSummaryRouter.get(
  "/",
  asyncWrapper(async (req: Request, res: Response) => {
    if (!req.userId) throw AppError.unauthorized();

    // ConversationRollingSummary PK = userId (findUnique is appropriate here).
    const summary = await prisma.conversationRollingSummary.findUnique({
      where: { userId: req.userId },
    });

    // Option A: explicit 404 when no row exists yet.
    // The AI pipeline (not the mobile client) is the writer — it should
    // handle 404 on first read and create via PUT.
    if (!summary) throw AppError.notFound("ConversationRollingSummary");

    sendSuccess(res, summary);
  }),
);

// PUT / — upsert singleton
conversationRollingSummaryRouter.put(
  "/",
  writeRateLimiter,
  asyncWrapper(async (req: Request, res: Response) => {
    if (!req.userId) throw AppError.unauthorized();

    const bodyParsed = summaryBodySchema.safeParse(req.body);
    if (!bodyParsed.success) {
      throw AppError.badRequest("Invalid ConversationRollingSummary body", bodyParsed.error.issues);
    }

    // Only `entries` is stored; `updatedAt` is Prisma @updatedAt managed.
    const { entries }: SummaryBody = bodyParsed.data;

    // userId is always authoritative from the token, never from body.
    const summary = await prisma.conversationRollingSummary.upsert({
      where: { userId: req.userId },
      create: {
        userId: req.userId,
        entries: entries as Parameters<typeof prisma.conversationRollingSummary.upsert>[0]["create"]["entries"],
      },
      update: {
        entries: entries as Parameters<typeof prisma.conversationRollingSummary.upsert>[0]["update"]["entries"],
      },
    });

    // Idempotent upsert of a per-user singleton — 200, not 201.
    sendSuccess(res, summary);
  }),
);
