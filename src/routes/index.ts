/**
 * @ai-context Router barrel for Workouts Server resource routes.
 *
 * All 12 SYNCED_COLLECTIONS are stubbed here — CRUD wiring deferred to W5c.
 * Each sub-router is mounted at its collection path under /v1.
 *
 * TODO(W5c): Implement CRUD handlers for all 12 resource routers below.
 */

import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";

// ── Per-resource routers (stubs) ──────────────────────────────────────────────

const gymsRouter = Router();
// TODO(W5c): GET /v1/gyms, POST /v1/gyms, GET /v1/gyms/:id, PUT /v1/gyms/:id, DELETE /v1/gyms/:id

const programsRouter = Router();
// TODO(W5c): CRUD for /v1/programs

const sessionsRouter = Router();
// TODO(W5c): CRUD for /v1/sessions

const progressionBaselinesRouter = Router();
// TODO(W5c): CRUD for /v1/progression-baselines

const cardioBaselinesRouter = Router();
// TODO(W5c): CRUD for /v1/cardio-baselines

const gymExerciseInstancesRouter = Router();
// TODO(W5c): CRUD for /v1/gym-exercise-instances

const userExercisesRouter = Router();
// TODO(W5c): CRUD for /v1/user-exercises

const exerciseAliasesRouter = Router();
// TODO(W5c): CRUD for /v1/exercise-aliases

const weeksRouter = Router();
// TODO(W5c): CRUD for /v1/weeks

const aiAuditLogRouter = Router();
// TODO(W5c): CRUD for /v1/ai-audit-log

const injuriesRouter = Router();
// TODO(W5c): CRUD for /v1/injuries

const conversationRollingSummaryRouter = Router();
// TODO(W5c): GET/PUT for /v1/conversation-rolling-summary (singleton per user)

const exercisesRouter = Router();
// TODO(W5d): Seed canonical exercises catalog; GET /v1/exercises, GET /v1/exercises/:id (read-only)

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
