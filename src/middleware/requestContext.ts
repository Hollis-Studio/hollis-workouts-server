/**
 * @ai-context Request-context + access-log middleware for Workouts Server.
 *
 * Responsibilities:
 *   - Assign req.requestId (used by errorHandler + all logs for correlation):
 *       X-Amzn-Trace-Id ▸ X-Request-Id ▸ crypto.randomUUID()
 *   - Echo it back as the `X-Request-Id` response header.
 *   - Emit one structured access-log line per request on response finish
 *     (method, path, status, durationMs, userId, requestId).
 *
 * Must be mounted early (before routes) so requestId is available everywhere.
 *
 * deps: node:crypto, lib/logger | consumers: src/app.ts
 */

import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { logger } from "../lib/logger.js";

// req.requestId / req.userId types come from the ambient augmentation in
// src/types/express.d.ts (applied via tsconfig include) — no runtime import.

// Accept only printable ASCII, max 128 chars, for any inbound trace id —
// prevents log/header injection or bloat. Applied to BOTH X-Amzn-Trace-Id and
// X-Request-Id: an AWS ALB preserves (does not strip) a client-supplied
// X-Amzn-Trace-Id, so it is not fully trusted either. Legit ALB trace ids
// ("Root=1-...;Parent=...;Self=...") are printable ASCII well under 128 chars.
const SAFE_REQUEST_ID = /^[\x20-\x7E]{1,128}$/;

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function safeClientId(value: string | undefined): string | undefined {
  return value !== undefined && SAFE_REQUEST_ID.test(value) ? value : undefined;
}

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const requestId =
    safeClientId(headerValue(req.headers["x-amzn-trace-id"])) ??
    safeClientId(headerValue(req.headers["x-request-id"])) ??
    randomUUID();

  req.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);

  const startedAt = process.hrtime.bigint();

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    logger.info(
      {
        component: "http",
        requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        userId: req.userId,
      },
      "request",
    );
  });

  next();
}
