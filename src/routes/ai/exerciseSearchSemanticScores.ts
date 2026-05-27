/**
 * @ai-context POST /ai/exercise-search-semantic-scores — embedding-based search ranking.
 *
 * Ported from functions/src/exerciseSearch/semanticScores.ts.
 * Model: gemini-embedding-001 via Vertex AI.
 * Entitlement: none (all authenticated users).
 *
 * Key improvements over the Cloud Function:
 *   - Parallelizes document embeddings (Promise.all) instead of sequential loop.
 *   - Uses ExerciseEmbeddingCache in Postgres to avoid re-embedding static exercises.
 *
 * deps: express, zod, lib/AppError, middleware/errorHandler,
 *       services/ai/exerciseSearchSemanticScores, utils/response
 * consumers: src/routes/ai/index.ts
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { AppError } from "../../lib/AppError.js";
import { asyncWrapper } from "../../middleware/errorHandler.js";
import { sendSuccess } from "../../utils/response.js";
import { ExerciseSearchSemanticScoresBodySchema } from "./schemas.js";
import { exerciseSearchSemanticScores } from "../../services/ai/exerciseSearchSemanticScores.js";

export const exerciseSearchSemanticScoresRouter = Router();

exerciseSearchSemanticScoresRouter.post(
  "/",
  asyncWrapper(async (req: Request, res: Response): Promise<void> => {
    if (!req.userId) throw AppError.unauthorized();

    const parsed = ExerciseSearchSemanticScoresBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.badRequest("Invalid request body", parsed.error.issues);
    }

    const result = await exerciseSearchSemanticScores(
      parsed.data.query,
      parsed.data.exercises,
    );

    if (!result.ok) {
      throw AppError.internal(result.error.message);
    }

    sendSuccess(res, result.data);
  }),
);
