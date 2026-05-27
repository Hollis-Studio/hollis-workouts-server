/**
 * @ai-context CancellationFeedback resource router — append-only log.
 *
 * Special case: immutable — no PUT/PATCH/DELETE.
 * On POST the server assigns the id (crypto.randomUUID()).
 * The server ALWAYS sets createdAt = new Date() — client-supplied timestamps
 * are ignored to prevent backdating.
 *
 * Mirrors the immutable pattern of src/routes/aiAuditLog.ts.
 *
 * Verbs:
 *   POST /  — create a feedback entry; server assigns id and createdAt
 *   GET  /  — list the caller's entries (most recent first)
 *
 * Wired by: src/routes/index.ts at /cancellation-feedback
 *   apiRouter.use("/cancellation-feedback", cancellationFeedbackRouter);
 *
 * Body schema mirrors CancellationFeedbackInput from the app service:
 *   option: CancellationFeedbackOption (enum string)
 *   detail: string | null
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
import { paginationSchema } from "../validation/common.js";

// ---------------------------------------------------------------------------
// Body schema — mirrors CancellationFeedbackInput from the app service.
// `option` is a free-form enum string (CancellationFeedbackOption values from
// the app's src/types/constants.ts). We validate as non-empty string rather
// than enumerating all values here so the server stays forward-compatible with
// new option values added to the app without a deploy.
// ---------------------------------------------------------------------------

const cancellationFeedbackBodySchema = z.object({
  /** CancellationFeedbackOption — e.g. "too_expensive", "missing_feature" */
  option: z.string().min(1).max(64),
  /** Optional free-text detail; null means no detail provided */
  detail: z.string().min(1).max(1000).nullable().optional(),
});

type CancellationFeedbackBody = z.infer<typeof cancellationFeedbackBodySchema>;

export const cancellationFeedbackRouter = Router();

// GET / — list entries (user-scoped, most recent first)
cancellationFeedbackRouter.get(
  "/",
  asyncWrapper(async (req: Request, res: Response) => {
    if (!req.userId) throw AppError.unauthorized();

    const pageResult = paginationSchema.safeParse(req.query);
    if (!pageResult.success) {
      throw AppError.badRequest("Invalid pagination parameters", pageResult.error.issues);
    }
    const { limit, cursor } = pageResult.data;

    const items = await prisma.cancellationFeedback.findMany({
      where: { userId: req.userId },
      take: limit,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });

    const nextCursor =
      items.length === limit ? (items[items.length - 1]?.id ?? null) : null;
    sendSuccess(res, { items, nextCursor });
  }),
);

// POST / — server-assigned id, append-only
cancellationFeedbackRouter.post(
  "/",
  writeRateLimiter,
  asyncWrapper(async (req: Request, res: Response) => {
    if (!req.userId) throw AppError.unauthorized();

    const bodyParsed = cancellationFeedbackBodySchema.safeParse(req.body);
    if (!bodyParsed.success) {
      throw AppError.badRequest(
        "Invalid CancellationFeedback body",
        bodyParsed.error.issues,
      );
    }

    const { option, detail }: CancellationFeedbackBody = bodyParsed.data;

    const item = await prisma.cancellationFeedback.create({
      data: {
        // Server assigns immutable id — client must not supply one.
        id: crypto.randomUUID(),
        // userId is always authoritative from the token, never from body.
        userId: req.userId,
        option,
        detail: detail ?? null,
        // createdAt is always server-assigned — never trust client time on an
        // immutable log (backdating would pollute analytics queries).
        createdAt: new Date(),
      },
    });

    sendCreated(res, item);
  }),
);
