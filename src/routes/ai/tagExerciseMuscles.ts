/**
 * @ai-context POST /ai/tag-exercise-muscles — exercise muscle group tagging.
 *
 * Ported from functions/src/exerciseTagging/tagExerciseMuscles.ts.
 * Model: Gemini Flash, JSON mode.
 * Entitlement: none (all authenticated users). Admin/dev pipeline use.
 *
 * deps: express, zod, lib/AppError, middleware/errorHandler,
 *       services/ai/tagExerciseMuscles, utils/response
 * consumers: src/routes/ai/index.ts
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { AppError } from "../../lib/AppError.js";
import { asyncWrapper } from "../../middleware/errorHandler.js";
import { sendSuccess } from "../../utils/response.js";
import { TagExerciseMusclesBodySchema } from "./schemas.js";
import { tagExerciseMuscles } from "../../services/ai/tagExerciseMuscles.js";

export const tagExerciseMusclesRouter = Router();

tagExerciseMusclesRouter.post(
  "/",
  asyncWrapper(async (req: Request, res: Response): Promise<void> => {
    if (!req.userId) throw AppError.unauthorized();

    const parsed = TagExerciseMusclesBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.badRequest("Invalid request body", parsed.error.issues);
    }

    const result = await tagExerciseMuscles(parsed.data.exerciseNames);

    if (!result.ok) {
      throw AppError.internal(result.error.message);
    }

    sendSuccess(res, result.data);
  }),
);
