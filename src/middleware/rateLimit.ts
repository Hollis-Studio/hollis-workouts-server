/**
 * @ai-context Rate limiting middleware for Workouts Server.
 *
 * Provides general API rate limiting (100 req/min per IP).
 * Uses in-memory store — suitable for single-instance ECS deployment.
 *
 * deps: express-rate-limit | consumers: src/index.ts
 */

import rateLimit from "express-rate-limit";
import { logger } from "../lib/logger.js";

const isTest = () => process.env.NODE_ENV === "test";

/**
 * General API rate limiter — 100 requests per minute per IP.
 * Skipped in test environment.
 */
export const apiRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  handler: (req, res, _next, options) => {
    const retryAfterSeconds = Math.ceil(options.windowMs / 1000);
    logger.warn({ ip: req.ip, path: req.path }, "Rate limit exceeded");
    res.setHeader("Retry-After", retryAfterSeconds.toString());
    res.status(429).json({
      ok: false,
      err: { code: "RATE_LIMIT_EXCEEDED", message: "Too many requests. Please slow down." },
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTest(),
});
