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

import { createAuthClient } from "@hollis-studio/auth-client";
import type { NextFunction, Request, Response } from "express";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { sendUnauthorized } from "../utils/response.js";

// req.userId / req.tokenClaims types come from the ambient augmentation in
// src/types/express.d.ts (applied via tsconfig include). Do NOT add a runtime
// `import "../types/express.js"` — that path emits no JS and crashes at runtime
// (the .d.ts produces no dist output).

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
        { code: appErr.code, message: appErr.message, path: req.path, component: "auth" },
        "[AUTH] Token verification failed",
      );
      // Generic client message — do NOT echo the underlying reason ("jwt
      // expired" / "invalid signature" / "invalid audience" / "Identity Service
      // unreachable: <net error>"). The specifics are logged above; leaking them
      // to the caller aids token-forgery probing and can disclose internal
      // network topology. Clients should refresh-then-retry on any 401.
      sendUnauthorized(res, "Invalid or expired token");
      return;
    }

    // Security: reject refresh / mfa_pending tokens — only access tokens are
    // valid for API calls. The auth-client populates req.tokenClaims after
    // successful verification.
    if (req.tokenClaims?.type !== "access") {
      logger.warn(
        { tokenType: req.tokenClaims?.type, path: req.path, component: "auth" },
        "[AUTH] Non-access token rejected",
      );
      sendUnauthorized(res, "Access token required");
      return;
    }

    next();
  });
};
