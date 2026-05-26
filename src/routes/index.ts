/**
 * @ai-context Router barrel for Workouts Server resource routes.
 *
 * Each resource lives in its own file under src/routes/.  This file imports and
 * mounts them.  requireAuth is applied once here on apiRouter — all sub-routers
 * inherit it.
 *
 * Resources wired here (14 total):
 *   Standard factory routers (GET / GET :id / PUT :id / DELETE or PATCH :id):
 *     gyms                       soft-delete   src/routes/gyms.ts
 *     programs                   hard-delete   src/routes/programs.ts
 *     sessions                   hard-delete   src/routes/sessions.ts
 *     gym-exercise-instances     hard-delete   src/routes/gymExerciseInstances.ts
 *     user-exercises             soft-delete   src/routes/userExercises.ts
 *     exercise-aliases           hard-delete   src/routes/exerciseAliases.ts
 *     injuries                   soft-delete   src/routes/injuries.ts
 *     metric-basket-snapshots    hard-delete   src/routes/metricBasketSnapshots.ts   ← 13th resource
 *
 *   Custom routers (special-cased, do NOT use the factory directly):
 *     progression-baselines  src/routes/progressionBaselines.ts  (composite key upsert)
 *     cardio-baselines       src/routes/cardioBaselines.ts        (composite key upsert)
 *     weeks                  src/routes/weeks.ts                  (composite PK, no delete)
 *     ai-audit-log           src/routes/aiAuditLog.ts             (immutable, POST-only write)
 *     conversation-rolling-summary  src/routes/conversationRollingSummary.ts (singleton)
 *     exercises              src/routes/exercises.ts              (read-only catalog)
 *
 * deps: express, middleware/auth, routes/*
 * consumers: src/index.ts (mounted at /v1)
 */

import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";

// ── Per-resource routers ───────────────────────────────────────────────────────

import { gymsRouter } from "./gyms.js";
import { programsRouter } from "./programs.js";
import { sessionsRouter } from "./sessions.js";
import { progressionBaselinesRouter } from "./progressionBaselines.js";
import { cardioBaselinesRouter } from "./cardioBaselines.js";
import { gymExerciseInstancesRouter } from "./gymExerciseInstances.js";
import { userExercisesRouter } from "./userExercises.js";
import { exerciseAliasesRouter } from "./exerciseAliases.js";
import { weeksRouter } from "./weeks.js";
import { aiAuditLogRouter } from "./aiAuditLog.js";
import { injuriesRouter } from "./injuries.js";
import { conversationRollingSummaryRouter } from "./conversationRollingSummary.js";
import { exercisesRouter } from "./exercises.js";
import { metricBasketSnapshotsRouter } from "./metricBasketSnapshots.js";

// ── Root router ────────────────────────────────────────────────────────────────

export const apiRouter = Router();

// All resource routes require authentication
apiRouter.use(requireAuth);

apiRouter.use("/gyms", gymsRouter);
apiRouter.use("/programs", programsRouter);
apiRouter.use("/sessions", sessionsRouter);
apiRouter.use("/progression-baselines", progressionBaselinesRouter);
apiRouter.use("/cardio-baselines", cardioBaselinesRouter);
apiRouter.use("/gym-exercise-instances", gymExerciseInstancesRouter);
apiRouter.use("/user-exercises", userExercisesRouter);
apiRouter.use("/exercise-aliases", exerciseAliasesRouter);
apiRouter.use("/weeks", weeksRouter);
apiRouter.use("/ai-audit-log", aiAuditLogRouter);
apiRouter.use("/injuries", injuriesRouter);
apiRouter.use("/conversation-rolling-summary", conversationRollingSummaryRouter);
apiRouter.use("/exercises", exercisesRouter);
apiRouter.use("/metric-basket-snapshots", metricBasketSnapshotsRouter);
