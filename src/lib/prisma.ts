/**
 * @ai-context Prisma client singleton for Workouts Server.
 *
 * Prisma 7 with PrismaPg driver adapter (pg Pool).
 * No multi-tenancy — all workout models are owned by this service directly.
 * User FK relationships point to userId string (Identity Service is authoritative).
 *
 * TLS configuration (production only):
 *   DATABASE_SSL_CA            — path or PEM string for the RDS CA bundle.
 *                                When set, rejectUnauthorized defaults to true.
 *                                Download from:
 *                                https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
 *   DATABASE_SSL_REJECT_UNAUTHORIZED — "false" to temporarily disable cert
 *                                verification while the CA bundle is being
 *                                provisioned; "true" to opt-in to strict mode
 *                                without a CA (public cert chain).
 */

import fs from "fs";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { Prisma, PrismaClient } from "../../prisma/generated/prisma/client.js";
import { logger } from "./logger.js";

export { Prisma, PrismaClient };

// env-ok: bootstrap-order guard — prisma instantiated at module load before validateEnv runs
const isProduction = process.env.NODE_ENV === "production";
const dbUrl = process.env.DATABASE_URL ?? "";

const logDbQueries = process.env.LOG_DB_QUERIES === "true";

// ---------------------------------------------------------------------------
// TLS configuration for production Postgres connections.
//
// Priority:
//   1. If DATABASE_SSL_CA is set: use it as the CA, default rejectUnauthorized
//      to true (secure).  Set DATABASE_SSL_REJECT_UNAUTHORIZED=false to
//      temporarily override while the CA bundle is being provisioned.
//   2. If DATABASE_SSL_CA is not set: fall back to rejectUnauthorized=false
//      (insecure — matches prior behavior).  Set
//      DATABASE_SSL_REJECT_UNAUTHORIZED=true to opt in to strict mode without
//      a CA (useful for databases with a public cert chain).
//
// Production readiness: set DATABASE_SSL_CA to the RDS global bundle path
//   (https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem)
//   before go-live to enable full TLS verification.
// ---------------------------------------------------------------------------

function buildSslConfig(): Record<string, unknown> | boolean {
  if (!isProduction) return false;

  const caSource = process.env.DATABASE_SSL_CA;
  const rejectOverride = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED;

  if (caSource) {
    // Resolve CA: treat as a file path if it exists on disk, else as a raw PEM.
    let ca: string;
    try {
      ca = fs.existsSync(caSource) ? fs.readFileSync(caSource, "utf8") : caSource;
    } catch {
      ca = caSource;
    }
    const rejectUnauthorized = rejectOverride !== "false";
    return { ca, rejectUnauthorized };
  }

  // No CA provided — keep legacy behavior (rejectUnauthorized: false) unless
  // explicitly overridden.
  //
  // NOTE: RDS's CA is NOT in Node's default trust store, so flipping this
  // default to `true` without DATABASE_SSL_CA would immediately break the
  // DB connection. Set DATABASE_SSL_CA to the RDS global bundle before go-live
  // (https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem).
  const rejectUnauthorized = rejectOverride === "true";
  if (!rejectUnauthorized) {
    if (isProduction) {
      logger.error(
        { component: "prisma" },
        "SECURITY: TLS verification is OFF (rejectUnauthorized: false) — " +
          "DATABASE_SSL_CA is not set. All RDS connections are unverified. " +
          "Set DATABASE_SSL_CA to the RDS CA bundle (global-bundle.pem) before go-live.",
      );
    } else {
      logger.warn(
        { component: "prisma" },
        "TLS cert validation is disabled (rejectUnauthorized: false). " +
          "Set DATABASE_SSL_CA to the RDS CA bundle to enable full cert validation.",
      );
    }
  }
  return { rejectUnauthorized };
}

const sslConfig = buildSslConfig();

// pg derives TLS settings from both the connection string's libpq params
// (sslmode/sslrootcert/etc.) AND the explicit `ssl` option. Newer pg parses
// `sslmode=require` as `verify-full`, which shadows our CA-based `ssl` object
// and surfaces as "self-signed certificate in certificate chain" even though
// the correct RDS CA is supplied. Strip libpq SSL params from the URL the Pool
// uses so the `ssl` object below is the single source of truth. Prisma's
// migrate engine reads DATABASE_URL directly and is unaffected.
function stripLibpqSslParams(url: string): string {
  if (!url) return url;
  try {
    const u = new URL(url);
    for (const p of ["sslmode", "ssl", "sslrootcert", "sslcert", "sslkey", "sslnegotiation"]) {
      u.searchParams.delete(p);
    }
    return u.toString();
  } catch {
    return url;
  }
}

const pool = new Pool({
  connectionString: stripLibpqSslParams(dbUrl),
  ...(sslConfig !== false ? { ssl: sslConfig } : {}),
  // connectionTimeoutMillis surfaces pool exhaustion as a fast error instead of
  // an indefinite hang (important on a small Fargate task).
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  // //DEFERRED(audit R1-D5): `max` is provisional. Tune against the Fargate
  // task size and RDS connection limit (N replicas × max ≤ RDS max_connections)
  // once load characteristics are known.
  max: 10,
});

const adapter = new PrismaPg(pool);

const basePrisma = new PrismaClient({
  adapter,
  log: [
    { emit: "event", level: "query" },
    { emit: "event", level: "error" },
    { emit: "event", level: "warn" },
  ],
});

basePrisma.$on("query", (e) => {
  if (logDbQueries) {
    logger.debug({ component: "prisma", durationMs: e.duration }, `Query: ${e.query}`);
  }
});

basePrisma.$on("warn", (err) => {
  logger.warn({ err, component: "prisma" }, "Prisma warn");
});

basePrisma.$on("error", (err) => {
  logger.error({ err, component: "prisma" }, "Prisma error");
});

export const prisma = basePrisma as unknown as PrismaClient;

// NOTE: no `beforeExit` $disconnect hook — it never fires while the HTTP server
// is listening (the event loop never drains naturally), and the SIGTERM/SIGINT
// graceful shutdown in src/index.ts owns `prisma.$disconnect()` explicitly.
