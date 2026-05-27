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
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "fatal"]).default("info"),

  // Error tracking (optional — Sentry disabled when unset)
  SENTRY_DSN: z.string().url().optional(),

  // AI (Vertex AI via ADC). Optional so the server boots without AI creds;
  // AI routes return a clear error at runtime when GOOGLE_CLOUD_PROJECT is unset.
  GOOGLE_CLOUD_PROJECT: z.string().optional(),
  GOOGLE_CLOUD_LOCATION: z.string().default("global"),
  GEMINI_FLASH_MODEL: z.string().default("gemini-3.1-flash-lite"),
  GEMINI_PRO_MODEL: z.string().default("gemini-3.1-pro-preview"),
  GEMINI_EMBEDDING_MODEL: z.string().default("gemini-embedding-001"),

  // Entitlements (optional — RevenueCat check is bypassed/denied when unset)
  REVENUECAT_REST_API_KEY: z.string().optional(),

  // Database TLS — production Postgres / RDS
  // DATABASE_SSL_CA: file path or raw PEM string for the RDS CA bundle.
  //   When set, rejectUnauthorized defaults to true (secure).
  //   Download from https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
  DATABASE_SSL_CA: z.string().optional(),
  // DATABASE_SSL_REJECT_UNAUTHORIZED: override the rejectUnauthorized behaviour.
  //   "false" — disable cert verification even when DATABASE_SSL_CA is set.
  //   "true"  — force cert verification even when DATABASE_SSL_CA is absent.
  //   Absent  — default behaviour (true when CA is set, false otherwise).
  DATABASE_SSL_REJECT_UNAUTHORIZED: z.enum(["true", "false"]).optional(),

  // Smart Reader free-use limit for non-entitled users (default: 5 per month).
  SMART_READER_FREE_USES: z.coerce.number().int().min(0).default(5),
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
