/**
 * @ai-context Express app factory for Workouts Server.
 *
 * `createApp()` assembles the full middleware stack and routes WITHOUT calling
 * listen(). Both the production entrypoint (src/index.ts) and the test harness
 * (__tests__/helpers/setup.ts) consume this single factory, so the app under
 * test is byte-for-byte the app that ships — no drift.
 *
 * Middleware order (deliberate):
 *   1. trust proxy (1 hop = AWS ALB) — so req.ip reads X-Forwarded-For
 *   2. requestContext — requestId + access log (before everything for correlation)
 *   3. securityHeaders
 *   4. health router — liveness/readiness BYPASS rate limiting AND auth
 *   5. apiRateLimiter — BEFORE the body parser so a throttled IP never has its
 *      body buffered/parsed
 *   6. express.json (2mb) — JSON only; no urlencoded (JSON API; less surface)
 *   7. /v1 apiRouter — all resource routes (auth enforced inside)
 *   8. 404 catch-all — JSON envelope, not Express's default HTML
 *   9. errorHandler — last
 *
 * deps: express, middleware/*, routes/*, utils/response
 * consumers: src/index.ts, __tests__/helpers/setup.ts
 */

import express from "express";
import type { Express } from "express";
import { apiRateLimiter } from "./middleware/rateLimit.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { requestContext } from "./middleware/requestContext.js";
import { securityHeaders } from "./middleware/securityHeaders.js";
import { healthRouter } from "./routes/health.js";
import { apiRouter } from "./routes/index.js";
import { sendError } from "./utils/response.js";

export function createApp(): Express {
  const app = express();

  // Hide the framework fingerprint.
  app.disable("x-powered-by");

  // Trust the first proxy hop (AWS ALB) so express-rate-limit / req.ip read the
  // real client IP from X-Forwarded-For instead of the ALB's address.
  app.set("trust proxy", 1);

  // Request correlation + access logging (must be first so requestId exists
  // for every downstream log line, including health checks and 404s).
  app.use(requestContext);

  // Security response headers.
  app.use(securityHeaders);

  // Health checks: unauthenticated AND un-rate-limited (ALB probes must always
  // succeed even while the API is shedding load).
  app.use(healthRouter);

  // Global IP rate limiter — BEFORE the body parser.
  app.use(apiRateLimiter);

  // JSON body parsing only (no urlencoded — this is a JSON API).
  app.use(express.json({ limit: "2mb" }));

  // Resource routes (authenticated, under /v1 — see routes/index.ts).
  app.use("/v1", apiRouter);

  // 404 catch-all — keep the JSON envelope consistent for unmatched routes.
  app.use((_req, res) => {
    sendError(res, "Endpoint not found", 404, "NOT_FOUND");
  });

  // Error handler (must be last).
  app.use(errorHandler);

  return app;
}
