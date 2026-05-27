/**
 * @ai-context POST /ai/match-exercises — freestyle name → canonical ID matching.
 *
 * Ported from functions/src/exerciseMatching/matchExercises.ts.
 * Model: Gemini Flash, JSON mode.
 * Entitlement: hollisIntelligence required.
 *
 * deps: express, zod, lib/AppError, middleware/errorHandler, middleware/entitlement,
 *       services/ai/matchExercises, utils/response
 * consumers: src/routes/ai/index.ts
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { AppError } from "../../lib/AppError.js";
import { asyncWrapper } from "../../middleware/errorHandler.js";
import { requireEntitlement } from "../../middleware/entitlement.js";
import { sendSuccess } from "../../utils/response.js";
import { MatchExercisesBodySchema } from "./schemas.js";
import { matchExercises } from "../../services/ai/matchExercises.js";

export const matchExercisesRouter = Router();

matchExercisesRouter.post(
  "/",
  requireEntitlement,
  asyncWrapper(async (req: Request, res: Response): Promise<void> => {
    if (!req.userId) throw AppError.unauthorized();

    const parsed = MatchExercisesBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.badRequest("Invalid request body", parsed.error.issues);
    }

    const result = await matchExercises(
      parsed.data.freestyleNames,
      parsed.data.availableExercises,
    );

    if (!result.ok) {
      throw AppError.internal(result.error.message);
    }

    sendSuccess(res, result.data);
  }),
);
