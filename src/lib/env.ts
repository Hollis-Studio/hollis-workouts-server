/**
 * @ai-context Centralized environment validation for Workouts Server.
 *
 * Validates vars relevant to Workouts Server:
 * - Core: DATABASE_URL, PORT, LOG_LEVEL, NODE_ENV
 * - Auth: IDENTITY_SERVICE_URL, IDENTITY_JWT_SECRET, AUDIENCE
 *
 * deps: zod | consumers: index.ts (startup), middleware/auth.ts
 */

import { z } from "zod";

// ============================================================================
// Schema
// ============================================================================

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3002),

  // Database
  DATABASE_URL: z.string().url(),

  // Auth — delegated to Identity Service
  IDENTITY_SERVICE_URL: z.string().url().default("http://localhost:3001"),
  // HS256 signing key: require ≥32 bytes (256-bit) — the NIST SP 800-131A floor
  // for HMAC-SHA256. An 8-char secret is brute-forceable offline from any token.
  IDENTITY_JWT_SECRET: z.string().min(32),
  AUDIENCE: z.string().default("hollis-workouts"),

  // Logging
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

// ============================================================================
// Types
// ============================================================================

export type Env = z.infer<typeof envSchema>;

// ============================================================================
// Validation State
// ============================================================================

let _validatedEnv: Env | null = null;

// ============================================================================
// Validation
// ============================================================================

export function validateEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.issues.map((issue) => {
      const path = issue.path.join(".");
      return `  - ${path}: ${issue.message}`;
    });

    throw new Error(
      `\n${"=".repeat(60)}\n` +
        `FATAL: Environment validation failed\n` +
        `${"=".repeat(60)}\n\n` +
        `The following environment variables are missing or invalid:\n\n` +
        errors.join("\n") +
        `\n\n` +
        `See .env.example for required environment variables.\n` +
        `\n${"=".repeat(60)}\n`,
    );
  }

  return result.data;
}

export function getEnv(): Env {
  if (!_validatedEnv) {
    _validatedEnv = validateEnv();
  }
  return _validatedEnv;
}

// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
export const env = new Proxy({} as Env, {
  get(_target, prop: string) {
    const validated = getEnv();
    return validated[prop as keyof Env];
  },
});

export function resetEnvValidation(): void {
  _validatedEnv = null;
}
