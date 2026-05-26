/**
 * Express type augmentation for Workouts Server authentication.
 *
 * Attaches userId and tokenClaims to Request after requireAuth middleware runs.
 */

import type { AccessTokenClaims } from "@hollis-studio/auth-client";

declare module "express-serve-static-core" {
  interface Request {
    /** User ID extracted from the verified JWT (set by requireAuth middleware) */
    userId?: string;
    /** Full parsed token claims (set by requireAuth middleware) */
    tokenClaims?: AccessTokenClaims;
    /** Request ID for tracing */
    requestId?: string;
  }
}

export {};
