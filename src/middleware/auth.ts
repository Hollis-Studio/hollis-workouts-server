/**
 * @ai-context Auth middleware for Workouts Server.
 *
 * Wraps @hollis/auth-client createAuthClient to verify Identity Service tokens
 * and attach req.userId to the request for downstream handlers.
 *
 * All authorization is delegated to the Hollis Identity Service.
 * This server stores no credentials.
 *
 * deps: @hollis/auth-client, lib/env, lib/logger | consumers: routes/*
 */

import { createAuthClient } from "@hollis/auth-client";
import type { NextFunction, Request, Response } from "express";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { sendUnauthorized } from "../utils/response.js";

// Import the type augmentation
import "../types/express.js";

// Lazily-initialized auth client (env not yet validated at module load)
let _authClient: ReturnType<typeof createAuthClient> | null = null;

function getAuthClient(): ReturnType<typeof createAuthClient> {
  if (!_authClient) {
    _authClient = createAuthClient({
      identityServiceUrl: env.IDENTITY_SERVICE_URL,
      audience: env.AUDIENCE as "hollis-workouts",
      jwksSecret: env.IDENTITY_JWT_SECRET,
    });
  }
  return _authClient;
}

/**
 * requireAuth — enforces a valid Identity Service JWT.
 *
 * On success: sets req.userId = claims.userId, req.tokenClaims = claims, calls next().
 * On failure: returns 401 JSON.
 */
export const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
  const client = getAuthClient();
  const middleware = client.requireAuth<Request>();

  middleware(req, res, (err?: unknown) => {
    if (err) {
      const appErr = err as { code?: string; message?: string };
      logger.warn(
        { code: appErr.code, path: req.path, component: "auth" },
        "[AUTH] Token verification failed",
      );
      sendUnauthorized(res, appErr.message ?? "Invalid or expired token");
      return;
    }
    next();
  });
};
