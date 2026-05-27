/**
 * @ai-context POST /ai/generate-program — AI training program generation.
 *
 * Ported from functions/src/programGeneration/generateProgram.ts.
 * Model: Gemini Pro, JSON mode.
 * Entitlement: hollisIntelligence required.
 * Includes hallucination guard: canonicalExerciseId values validated in service.
 *
 * deps: express, zod, lib/AppError, middleware/errorHandler, middleware/entitlement,
 *       services/ai/generateProgram, utils/response
 * consumers: src/routes/ai/index.ts
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { AppError } from "../../lib/AppError.js";
import { asyncWrapper } from "../../middleware/errorHandler.js";
import { requireEntitlement } from "../../middleware/entitlement.js";
import { sendSuccess } from "../../utils/response.js";
import { GenerateProgramBodySchema } from "./schemas.js";
import { generateProgram } from "../../services/ai/generateProgram.js";

export const generateProgramRouter = Router();

generateProgramRouter.post(
  "/",
  requireEntitlement,
  asyncWrapper(async (req: Request, res: Response): Promise<void> => {
    if (!req.userId) throw AppError.unauthorized();

    const parsed = GenerateProgramBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.badRequest("Invalid request body", parsed.error.issues);
    }

    const result = await generateProgram({
      userId: req.userId,
      description: parsed.data.description,
      availableExercises: parsed.data.availableExercises,
      preferences: parsed.data.preferences,
      userContext: parsed.data.userContext,
    });

    if (!result.ok) {
      throw AppError.internal(result.error.message);
    }

    sendSuccess(res, result.data);
  }),
);
