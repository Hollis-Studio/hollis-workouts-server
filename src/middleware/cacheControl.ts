/**
 * @ai-context Default Cache-Control header middleware for Workouts Server.
 *
 * Sets `Cache-Control: no-store, private` on every response by default.
 * This is the correct posture for all user-scoped API responses — they must
 * never be stored by a shared cache, CDN, or browser cache.
 *
 * ORDERING NOTE: This middleware must be mounted in app.ts BEFORE the /v1
 * route handler.  Route handlers (e.g. the exercises catalog) may call
 * `res.setHeader("Cache-Control", ...)` later in the request cycle.
 * Express uses last-write-wins semantics for `res.setHeader`, so a route
 * handler's explicit override (e.g. `private, max-age=3600`) always wins
 * over the default set here — no special ordering machinery is needed.
 *
 * deps: express | consumers: src/app.ts
 */

import type { NextFunction, Request, Response } from "express";

/**
 * The default cache directive applied to every response.
 * - `no-store`  — prohibits any cache (shared or private) from storing the response.
 * - `private`   — defense-in-depth: even if a proxy ignores `no-store`, it is
 *                 told the response is user-specific and must not be shared.
 */
const USER_DATA_CACHE = "no-store, private";

export function defaultCacheControl(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Cache-Control", USER_DATA_CACHE);
  next();
}
