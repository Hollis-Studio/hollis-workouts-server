/**
 * @ai-context Hollis Workouts Server — Express app entry point.
 *
 * Mounts:
 * - Rate limiter (global)
 * - /healthz, /readyz (unauthenticated)
 * - /v1/* (all resource routes, require auth — see routes/index.ts)
 * - Error handler (last)
 *
 * Auth is enforced inside the apiRouter; health checks bypass it.
 *
 * deps: express, middleware/*, routes/*, lib/env, lib/logger
 */

import "dotenv/config";
import express from "express";
import { env } from "./lib/env.js";
import { logger } from "./lib/logger.js";
import { apiRateLimiter } from "./middleware/rateLimit.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { healthRouter } from "./routes/health.js";
import { apiRouter } from "./routes/index.js";

const app = express();

// ============================================================================
// Middleware
// ============================================================================

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(apiRateLimiter);

// ============================================================================
// Health checks (unauthenticated)
// ============================================================================

app.use(healthRouter);

// ============================================================================
// Resource routes (authenticated, under /v1)
// ============================================================================

app.use("/v1", apiRouter);

// ============================================================================
// Error handler (must be last)
// ============================================================================

app.use(errorHandler);

// ============================================================================
// Start server
// ============================================================================

const port = env.PORT;

app.listen(port, () => {
  logger.info({ port, service: "hollis-workouts-server" }, "Workouts Server started");
});

export default app;
