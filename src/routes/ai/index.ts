/**
 * @ai-context AI routes barrel — composes all AI endpoint routers.
 *
 * Wired into src/routes/index.ts at /ai (apiRouter.use("/ai", aiRouter)).
 *
 * Endpoint map (all require auth via parent apiRouter):
 *   GET  /ai/smart-reader-usage          — current month usage for Smart Reader
 *   POST /ai/recognize-equipment         — equipment photo recognition (Smart Reader)
 *   POST /ai/match-exercises
 *   POST /ai/exercise-search-semantic-scores
 *   POST /ai/log-workout-audio
 *   POST /ai/generate-program
 *   POST /ai/smart-builder-chat
 *   POST /ai/gym-setup-chat
 *   POST /ai/tag-exercise-muscles
 *
 * Smart Reader entitlement policy (recognize-equipment + smart-reader-usage):
 *   - Entitled users (hollisIntelligence): bypass the counter.
 *   - Non-entitled users: SMART_READER_FREE_USES (default 5) calls per month.
 *     429 RATE_LIMITED with { used, limit, remaining } when exceeded.
 *
 * deps: express, routes/ai/*
 * consumers: src/routes/index.ts
 */

import { Router } from "express";
import { recognizeEquipmentRouter } from "./recognizeEquipment.js";
import { smartReaderUsageRouter } from "./smartReaderUsage.js";
import { matchExercisesRouter } from "./matchExercises.js";
import { exerciseSearchSemanticScoresRouter } from "./exerciseSearchSemanticScores.js";
import { logWorkoutAudioRouter } from "./logWorkoutAudio.js";
import { generateProgramRouter } from "./generateProgram.js";
import { smartBuilderChatRouter } from "./smartBuilderChat.js";
import { gymSetupChatRouter } from "./gymSetupChat.js";
import { tagExerciseMusclesRouter } from "./tagExerciseMuscles.js";

export const aiRouter = Router();

aiRouter.use("/smart-reader-usage", smartReaderUsageRouter);
aiRouter.use("/recognize-equipment", recognizeEquipmentRouter);
aiRouter.use("/match-exercises", matchExercisesRouter);
aiRouter.use("/exercise-search-semantic-scores", exerciseSearchSemanticScoresRouter);
aiRouter.use("/log-workout-audio", logWorkoutAudioRouter);
aiRouter.use("/generate-program", generateProgramRouter);
aiRouter.use("/smart-builder-chat", smartBuilderChatRouter);
aiRouter.use("/gym-setup-chat", gymSetupChatRouter);
aiRouter.use("/tag-exercise-muscles", tagExerciseMusclesRouter);
