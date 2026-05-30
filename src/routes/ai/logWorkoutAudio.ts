/**
 * @ai-context POST /ai/log-workout-audio — voice workout logging.
 *
 * Ported from functions/src/workoutVoice/logWorkoutAudio.ts.
 * Model: Gemini Flash, multimodal audio input + structured responseSchema.
 * Entitlement: hollisIntelligence required.
 *
 * Route-level body-parser override: applies express.json({ limit: "20mb" })
 * so base64-encoded audio blobs (m4a/mp4/wav/webm, typically 5-15 MB) are
 * accepted. The global parser in app.ts stays at its default limit.
 *
 * Critical guards ported:
 *   - VOICE_WORKOUT_RESPONSE_SCHEMA: structured output schema constrains response format.
 *   - exerciseIndex validation: all returned indexes must match input indexes.
 *   - Markdown fence stripping before JSON.parse.
 *
 * deps: express, zod, lib/AppError, middleware/errorHandler, middleware/entitlement,
 *       services/ai/logWorkoutAudio, utils/response
 * consumers: src/routes/ai/index.ts
 */

import express, { Router } from "express";
import type { Request, Response } from "express";
import { AppError } from "../../lib/AppError.js";
import { asyncWrapper } from "../../middleware/errorHandler.js";
import { requireEntitlement } from "../../middleware/entitlement.js";
import { sendSuccess } from "../../utils/response.js";
import { LogWorkoutAudioBodySchema } from "./schemas.js";
import { logWorkoutAudio } from "../../services/ai/logWorkoutAudio.js";

export const logWorkoutAudioRouter = Router();

logWorkoutAudioRouter.post(
  "/",
  // Route-level body parser override — audio blobs up to ~15 MB base64.
  // Must come before other middleware so Express uses this limit for this route.
  express.json({ limit: "20mb" }),
  requireEntitlement,
  asyncWrapper(async (req: Request, res: Response): Promise<void> => {
    if (!req.userId) throw AppError.unauthorized();

    const parsed = LogWorkoutAudioBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.badRequest("Invalid request body", parsed.error.issues);
    }

    const result = await logWorkoutAudio({
      userId: req.userId,
      audioBase64: parsed.data.audioBase64,
      mimeType: parsed.data.mimeType,
      defaultWeightUnit: parsed.data.defaultWeightUnit,
      hideRirControls: parsed.data.hideRirControls,
      protocolVersion: parsed.data.protocolVersion,
      exercises: parsed.data.exercises,
    });

    if (!result.ok) {
      throw AppError.internal(result.error.message);
    }

    sendSuccess(res, result.data);
  }),
);
