/**
 * @ai-context POST /ai/gym-setup-chat — AI gym setup wizard conversation.
 *
 * Ported from functions/src/gymSetup/gymSetupChat.ts.
 * Model: Gemini Pro, JSON mode.
 * Entitlement: hollisIntelligence required.
 * Stateless: full conversation history + equipment list sent each request.
 *
 * deps: express, zod, lib/AppError, middleware/errorHandler, middleware/entitlement,
 *       services/ai/gymSetupChat, utils/response
 * consumers: src/routes/ai/index.ts
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { AppError } from "../../lib/AppError.js";
import { asyncWrapper } from "../../middleware/errorHandler.js";
import { requireEntitlement } from "../../middleware/entitlement.js";
import { sendSuccess } from "../../utils/response.js";
import { GymSetupChatBodySchema } from "./schemas.js";
import { gymSetupChat } from "../../services/ai/gymSetupChat.js";

export const gymSetupChatRouter = Router();

gymSetupChatRouter.post(
  "/",
  requireEntitlement,
  asyncWrapper(async (req: Request, res: Response): Promise<void> => {
    if (!req.userId) throw AppError.unauthorized();

    const parsed = GymSetupChatBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.badRequest("Invalid request body", parsed.error.issues);
    }

    const result = await gymSetupChat({
      userId: req.userId,
      conversationHistory: parsed.data.conversationHistory,
      currentEquipment: parsed.data.currentEquipment,
      gymName: parsed.data.gymName,
    });

    if (!result.ok) {
      throw AppError.internal(result.error.message);
    }

    sendSuccess(res, result.data);
  }),
);
