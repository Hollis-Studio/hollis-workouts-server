/**
 * @ai-context POST /ai/smart-builder-chat — Smart Program Builder AI conversation.
 *
 * Ported from functions/src/programBuilder/smartBuilderChat.ts.
 * Model: Gemini Pro, JSON mode.
 * Entitlement: hollisIntelligence required.
 *
 * Three action modes: converse | generate | refine.
 * Up to 2 retries on hallucinated exercise IDs and type mismatches.
 *
 * HALLUCINATION_EXHAUSTED contract:
 *   When all retries are exhausted, the service returns err("HALLUCINATION_EXHAUSTED", ...).
 *   This route surfaces it as HTTP 422 with body:
 *   { ok: false, err: { code: "HALLUCINATION_EXHAUSTED", message: "HALLUCINATION_EXHAUSTED: ...",
 *     details: { invalidIds: [] } } }
 *   The client app reads message.includes("HALLUCINATION_EXHAUSTED") and details.invalidIds.
 *   This error shape is intentionally preserved across the Firebase→REST migration.
 *
 * deps: express, zod, lib/AppError, middleware/errorHandler, middleware/entitlement,
 *       services/ai/smartBuilderChat, utils/response
 * consumers: src/routes/ai/index.ts
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { AppError } from "../../lib/AppError.js";
import { asyncWrapper } from "../../middleware/errorHandler.js";
import { requireEntitlement } from "../../middleware/entitlement.js";
import { sendSuccess } from "../../utils/response.js";
import { SmartBuilderChatBodySchema } from "./schemas.js";
import { smartBuilderChat, HALLUCINATION_EXHAUSTED } from "../../services/ai/smartBuilderChat.js";

export const smartBuilderChatRouter = Router();

smartBuilderChatRouter.post(
  "/",
  requireEntitlement,
  asyncWrapper(async (req: Request, res: Response): Promise<void> => {
    if (!req.userId) throw AppError.unauthorized();

    const parsed = SmartBuilderChatBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.badRequest("Invalid request body", parsed.error.issues);
    }

    const result = await smartBuilderChat({
      userId: req.userId,
      action: parsed.data.action,
      conversationHistory: parsed.data.conversationHistory,
      userContext: parsed.data.userContext as Parameters<typeof smartBuilderChat>[0]["userContext"],
      currentProgram: parsed.data.currentProgram,
    });

    if (!result.ok) {
      // HALLUCINATION_EXHAUSTED: the service encodes this sentinel in the message.
      // Surface the special error shape the client parses:
      //   { ok: false, err: { code: "HALLUCINATION_EXHAUSTED", message: "...", details: { invalidIds: [] } } }
      // The client reads message.includes("HALLUCINATION_EXHAUSTED") and details.invalidIds.
      if (result.error.message.includes(HALLUCINATION_EXHAUSTED)) {
        res.status(422).json({
          ok: false,
          err: {
            code: HALLUCINATION_EXHAUSTED,
            message: result.error.message,
            details: { invalidIds: [] },
          },
        });
        return;
      }
      throw AppError.internal(result.error.message);
    }

    sendSuccess(res, result.data);
  }),
);
