/**
 * @ai-context Rate limiting middleware for Workouts Server.
 *
 * Provides:
 *   - apiRateLimiter  — global 100 req/min per IP (mounted in src/index.ts)
 *   - writeRateLimiter — per-user 60 mutations/min applied to write verbs
 *                        (PUT, POST, DELETE, PATCH) by the CRUD factory and
 *                        custom write routes.
 *
 * Uses in-memory store — suitable for single-instance ECS deployment.
 * Both limiters are no-ops in the test environment.
 *
 * deps: express-rate-limit | consumers: src/index.ts, src/lib/crud.ts, src/routes/*
 */

import rateLimit from "express-rate-limit";
import type { Request } from "express";
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
    // Prefer the actual window reset time over the full window length so a
    // client mid-window isn't told to wait the maximum every time.
    const resetTime = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit?.resetTime;
    const retryAfterSeconds = resetTime
      ? Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000))
      : Math.ceil(options.windowMs / 1000);
    logger.warn({ ip: req.ip, path: req.path }, "Rate limit exceeded");
    res.setHeader("Retry-After", retryAfterSeconds.toString());
    res.status(429).json({
      ok: false,
      err: { code: "RATE_LIMITED", message: "Too many requests. Please slow down." },
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTest(),
});

/**
 * Per-user write rate limiter — 60 mutations per minute per userId.
 *
 * Keyed by req.userId (set by requireAuth). Falls back to IP when userId is
 * absent (should not occur on authenticated routes, but guards the edge case).
 *
 * Apply this to write verbs (PUT, POST, DELETE, PATCH) in the CRUD factory
 * and any custom write handler.  Read-only routes (GET) are covered by the
 * global IP limiter only.
 */
export const writeRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,
  keyGenerator: (req: Request) => req.userId ?? req.ip ?? "unknown",
  handler: (req, res, _next, options) => {
    // Prefer the actual window reset time over the full window length so a
    // client mid-window isn't told to wait the maximum every time.
    const resetTime = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit?.resetTime;
    const retryAfterSeconds = resetTime
      ? Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000))
      : Math.ceil(options.windowMs / 1000);
    logger.warn(
      { userId: req.userId, path: req.path, component: "rateLimit" },
      "Write rate limit exceeded",
    );
    res.setHeader("Retry-After", retryAfterSeconds.toString());
    res.status(429).json({
      ok: false,
      err: { code: "RATE_LIMITED", message: "Too many write requests. Please slow down." },
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTest(),
});
