/**
 * @ai-context SmartBuilderDraft resource router — per-user SINGLETON.
 *
 * Special case: singleton row keyed by userId (userId IS the PK).
 * The `payload` column stores the full in-progress program builder state as a
 * Json blob (validated at write time by the inline SmartBuilderDraftPayloadSchema).
 * No `:id` param in any URL.
 *
 * Verbs:
 *   GET    /  — fetch the caller's draft; 404 if absent (no draft in progress)
 *   PUT    /  — upsert the singleton by { userId }; userId always from token
 *   DELETE /  — hard delete (clear the draft)
 *
 * Wired by: src/routes/index.ts at /smart-builder-draft
 *   apiRouter.use("/smart-builder-draft", smartBuilderDraftRouter);
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
// Payload schema — mirrors SmartBuilderDraftSchema from the app's
// src/schemas/smartBuilderDraft.ts (inline to avoid app package import).
// The payload column stores the full draft blob; createdAt/updatedAt are
// Prisma-managed columns on SmartBuilderDraft, not part of the payload.
// ---------------------------------------------------------------------------

const conversationTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  timestamp: z.number().finite().nonnegative(),
});

/**
 * Inline mirror of the app's SmartBuilderDraftSchema.
 * `currentProgram` and `questionGroups` are open shapes (unknown) — they evolve
 * with the AI builder conversation and are not validated beyond presence.
 * `userAnswers` values are string | number | boolean to match the app schema.
 */
const smartBuilderDraftPayloadSchema = z.object({
  conversationHistory: z.array(conversationTurnSchema),
  currentProgram: z.unknown(),
  phase: z.enum(["input", "conversing", "generating", "preview", "refining"]),
  questionGroups: z.unknown().optional(),
  readyMessage: z.string().nullable().optional(),
  selectedGymId: z.string().nullable().optional(),
  userAnswers: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean()]),
  ),
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
});

// PUT body wraps the draft in a `payload` key to match the Prisma column name.
const draftBodySchema = z.object({
  payload: smartBuilderDraftPayloadSchema,
  // createdAt on the server row — client may supply for first-write fidelity
  createdAt: z.coerce.date().optional(),
});

type DraftBody = z.infer<typeof draftBodySchema>;

export const smartBuilderDraftRouter = Router();

// GET / — fetch singleton
smartBuilderDraftRouter.get(
  "/",
  asyncWrapper(async (req: Request, res: Response) => {
    if (!req.userId) throw AppError.unauthorized();

    const draft = await prisma.smartBuilderDraft.findUnique({
      where: { userId: req.userId },
    });

    if (!draft) throw AppError.notFound("SmartBuilderDraft");

    sendSuccess(res, draft);
  }),
);

// PUT / — upsert singleton
smartBuilderDraftRouter.put(
  "/",
  writeRateLimiter,
  asyncWrapper(async (req: Request, res: Response) => {
    if (!req.userId) throw AppError.unauthorized();

    const bodyParsed = draftBodySchema.safeParse(req.body);
    if (!bodyParsed.success) {
      throw AppError.badRequest("Invalid SmartBuilderDraft body", bodyParsed.error.issues);
    }

    const { payload, createdAt: bodyCreatedAt }: DraftBody = bodyParsed.data;

    const createdAt =
      bodyCreatedAt instanceof Date ? bodyCreatedAt : new Date();

    // userId is always authoritative from the token, never from body.
    const draft = await prisma.smartBuilderDraft.upsert({
      where: { userId: req.userId },
      create: {
        userId: req.userId,
        createdAt,
        payload: payload as Parameters<
          typeof prisma.smartBuilderDraft.upsert
        >[0]["create"]["payload"],
      },
      update: {
        payload: payload as Parameters<
          typeof prisma.smartBuilderDraft.upsert
        >[0]["update"]["payload"],
      },
    });

    // Singleton upsert — 200 (idempotent)
    sendSuccess(res, draft);
  }),
);

// DELETE / — clear the draft (hard delete)
smartBuilderDraftRouter.delete(
  "/",
  writeRateLimiter,
  asyncWrapper(async (req: Request, res: Response) => {
    if (!req.userId) throw AppError.unauthorized();

    // IDOR guard: confirm the row exists for this user before deleting.
    const existing = await prisma.smartBuilderDraft.findUnique({
      where: { userId: req.userId },
    });
    if (!existing) throw AppError.notFound("SmartBuilderDraft");

    // Defense-in-depth: delete is scoped to userId (PK) — cannot touch another
    // user's row.
    await prisma.smartBuilderDraft.delete({
      where: { userId: req.userId },
    });

    sendSuccess(res, { deleted: true });
  }),
);
