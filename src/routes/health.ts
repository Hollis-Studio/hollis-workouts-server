/**
 * @ai-context Health check routes for Workouts Server.
 *
 * GET /healthz — liveness probe (always 200 if process is running)
 * GET /readyz  — readiness probe (checks DB connectivity)
 *
 * deps: prisma | consumers: src/index.ts
 */

import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

export const healthRouter = Router();

healthRouter.get("/healthz", (_req, res) => {
  res.json({ ok: true, service: "hollis-workouts-server" });
});

healthRouter.get("/readyz", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, db: "connected" });
  } catch (err) {
    logger.error({ err }, "Readiness check failed — DB unreachable");
    res.status(503).json({ ok: false, err: { code: "DB_UNAVAILABLE", message: "Database unavailable" } });
  }
});
