/**
 * @ai-context Standardized API response helpers for Workouts Server.
 *
 * Shapes:
 *   Success: { ok: true, data: T }
 *   Error:   { ok: false, err: { code, message } }
 *
 * deps: express | consumers: route handlers, middleware/auth.ts
 */

import type { Response } from "express";

export interface SuccessResponse<T> {
  ok: true;
  data: T;
}

export interface ErrorResponse {
  ok: false;
  err: {
    code: string;
    message: string;
  };
}

export function sendSuccess<T>(res: Response, data: T, statusCode = 200): void {
  res.status(statusCode).json({ ok: true, data } satisfies SuccessResponse<T>);
}

export function sendCreated<T>(res: Response, data: T): void {
  sendSuccess(res, data, 201);
}

export function sendError(
  res: Response,
  message: string,
  statusCode = 500,
  code = "INTERNAL_ERROR",
): void {
  res.status(statusCode).json({ ok: false, err: { code, message } } satisfies ErrorResponse);
}

export function sendNotFound(res: Response, resource: string): void {
  sendError(res, `${resource} not found`, 404, "NOT_FOUND");
}

export function sendBadRequest(res: Response, message: string): void {
  sendError(res, message, 400, "BAD_REQUEST");
}

export function sendUnauthorized(res: Response, message = "Unauthorized"): void {
  sendError(res, message, 401, "UNAUTHORIZED");
}

export function sendForbidden(res: Response, message = "Forbidden"): void {
  sendError(res, message, 403, "FORBIDDEN");
}
