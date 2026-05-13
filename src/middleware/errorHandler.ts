/**
 * @ai-context Express error handling middleware for Workouts Server.
 *
 * Catches AppError instances and maps them to HTTP responses.
 * Catches Prisma errors and returns 500 without leaking internals.
 *
 * deps: lib/AppError, lib/logger | consumers: src/index.ts (mounted last)
 */

import type { NextFunction, Request, Response } from "express";
import { AppError } from "../lib/AppError.js";
import { logger } from "../lib/logger.js";
import { sendError } from "../utils/response.js";

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const errWithType = err as Error & { type?: string; statusCode?: number };

  // Payload too large (Express body-parser)
  if (
    errWithType.type === "entity.too.large" ||
    errWithType.statusCode === 413
  ) {
    logger.warn({ path: req.path, requestId: req.requestId }, "Request payload too large");
    res.status(413).json({ ok: false, err: { code: "PAYLOAD_TOO_LARGE", message: "Request payload is too large" } });
    return;
  }

  // Malformed JSON
  if (err instanceof SyntaxError && "body" in err) {
    logger.warn({ path: req.path, requestId: req.requestId }, "Invalid JSON in request body");
    res.status(400).json({ ok: false, err: { code: "INVALID_JSON", message: "Invalid JSON in request body" } });
    return;
  }

  // Known AppError
  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      logger.error({ err, requestId: req.requestId }, "AppError (server error)");
    } else {
      logger.warn(
        { code: err.code, message: err.message, statusCode: err.statusCode, path: req.path },
        "AppError (client error)",
      );
    }
    res.status(err.statusCode).json(err.toJSON());
    return;
  }

  // Unexpected error
  logger.error({ err, requestId: req.requestId, path: req.path }, "Unexpected error in request");
  sendError(res, "An unexpected error occurred", 500, "INTERNAL_ERROR");
}

/**
 * Wraps an async route handler so errors are forwarded to next().
 */
export function asyncWrapper<P = Record<string, string>, ResBody = unknown, ReqBody = unknown>(
  fn: (req: Request<P, ResBody, ReqBody>, res: Response<ResBody>, next: NextFunction) => Promise<void>,
): (req: Request<P, ResBody, ReqBody>, res: Response<ResBody>, next: NextFunction) => void {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
