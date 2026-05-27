/**
 * @ai-context POST /ai/recognize-equipment — equipment photo recognition.
 *
 * Ported from functions/src/equipmentRecognition/recognizeEquipment.ts.
 * Model: Gemini Flash (multimodal image).
 *
 * Entitlement gate (Smart Reader free-use counter):
 *   - Entitled users (hollisIntelligence): bypass the counter, call AI directly.
 *   - Non-entitled users: enforced monthly counter (SMART_READER_FREE_USES, default 5).
 *     Once exceeded: 429 RATE_LIMITED with { used, limit, remaining } details.
 *
 * deps: express, zod, lib/AppError, middleware/errorHandler, middleware/entitlement,
 *       services/ai/recognizeEquipment, services/ai/smartReaderUsage, utils/response
 * consumers: src/routes/ai/index.ts
 */

import express, { Router } from "express";
import type { Request, Response } from "express";
import { AppError } from "../../lib/AppError.js";
import { asyncWrapper } from "../../middleware/errorHandler.js";
import { checkHollisIntelligence } from "../../middleware/entitlement.js";
import { sendSuccess } from "../../utils/response.js";
import { RecognizeEquipmentBodySchema } from "./schemas.js";
import { recognizeEquipment } from "../../services/ai/recognizeEquipment.js";
import { checkAndIncrementSmartReaderUsage } from "../../services/ai/smartReaderUsage.js";

export const recognizeEquipmentRouter = Router();

// ── POST /ai/recognize-equipment — recognize gym equipment from a base64 photo ──

recognizeEquipmentRouter.post(
  "/",
  express.json({ limit: "10mb" }), // images can be large base64 strings
  asyncWrapper(async (req: Request, res: Response): Promise<void> => {
    if (!req.userId) throw AppError.unauthorized();

    const parsed = RecognizeEquipmentBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.badRequest("Invalid request body", parsed.error.issues);
    }

    // Entitlement check — entitled users bypass the free-use counter.
    const entitled = await checkHollisIntelligence(req.userId);

    if (!entitled) {
      const usageResult = await checkAndIncrementSmartReaderUsage(req.userId);
      if (!usageResult.ok) {
        if (usageResult.error.code === "RATE_LIMITED") {
          throw new AppError(
            "RATE_LIMITED",
            usageResult.error.message,
            429,
            usageResult.error.details,
          );
        }
        throw AppError.internal(usageResult.error.message);
      }
    }

    const result = await recognizeEquipment(
      req.userId,
      parsed.data.imageBase64,
      parsed.data.userDescription,
    );

    if (!result.ok) {
      throw AppError.internal(result.error.message);
    }

    sendSuccess(res, result.data);
  }),
);
