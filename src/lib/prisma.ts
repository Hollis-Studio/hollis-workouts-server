/**
 * @ai-context Prisma client singleton for Workouts Server.
 *
 * Prisma 7 with PrismaPg driver adapter (pg Pool).
 * No multi-tenancy — all workout models are owned by this service directly.
 * User FK relationships point to userId string (Identity Service is authoritative).
 */

import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { Prisma, PrismaClient } from "../../prisma/generated/prisma/client.js";
import { logger } from "./logger.js";

export { Prisma, PrismaClient };

// env-ok: bootstrap-order guard — prisma instantiated at module load before validateEnv runs
const isProduction = process.env.NODE_ENV === "production";
const dbUrl = process.env.DATABASE_URL ?? "";

const logDbQueries = process.env.LOG_DB_QUERIES === "true";

const pool = new Pool({
  connectionString: dbUrl,
  ...(isProduction ? { ssl: { rejectUnauthorized: false } } : {}),
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

process.on("beforeExit", () => {
  basePrisma.$disconnect().catch((err: unknown) => {
    logger.warn({ err }, "Failed to disconnect Prisma on beforeExit");
  });
});
