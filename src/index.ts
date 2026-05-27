/**
 * @ai-context Hollis Workouts Server — process entrypoint.
 *
 * Responsibilities (the Express app itself lives in src/app.ts → createApp):
 *   - Load env, then fail-fast validate it BEFORE listening.
 *   - Register process-level safety nets (unhandledRejection, uncaughtException).
 *   - Start the HTTP server and handle bind errors.
 *   - Graceful shutdown on SIGTERM/SIGINT (ECS sends SIGTERM on task stop):
 *     stop accepting connections, drain in-flight requests, disconnect Prisma,
 *     force-exit after a timeout.
 *
 * deps: dotenv, lib/env, lib/logger, lib/prisma, app
 */

import "dotenv/config";
import { validateEnv } from "./lib/env.js";

// Fail-fast: validate required env before anything starts serving traffic.
// (ESM evaluates static imports before this line; the pg Pool in lib/prisma is
// constructed at import time with raw env but never opens a connection until a
// query runs — so validateEnv() throwing here still prevents the server from
// ever listening with a bad config.)
const env = validateEnv();

import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { initSentry } from "./lib/sentry.js";
import { createApp } from "./app.js";

// No-op when SENTRY_DSN is unset; otherwise wires error/perf capture before the app handles traffic.
initSentry();

const app = createApp();
const port = env.PORT;

const server = app.listen(port, () => {
  logger.info({ port, service: "hollis-workouts-server" }, "Workouts Server started");
});

// Bind failures (port in use, EACCES) surface here — otherwise Node throws
// without a structured log and ECS restarts blindly.
server.on("error", (err: Error) => {
  logger.fatal({ err, port }, "Server failed to bind — exiting");
  process.exit(1);
});

// ============================================================================
// Graceful shutdown
// ============================================================================

let shuttingDown = false;

// exitCode is decided by the CALLER (0 for a clean signal, 1 for a crash) so
// the process's exit status reflects the cause — gracefulShutdown must not
// hard-code 0, or a crash that drains cleanly would look like a clean stop.
async function gracefulShutdown(signal: string, exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, "Shutdown signal received — draining");

  // Force-exit if drain takes too long (ECS sends SIGKILL ~30s after SIGTERM).
  const forceExit = setTimeout(() => {
    logger.warn({ signal }, "Graceful shutdown timed out — forcing exit");
    process.exit(1);
  }, 15_000);
  forceExit.unref();

  try {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await prisma.$disconnect();
    clearTimeout(forceExit);
    logger.info({ signal }, "Graceful shutdown complete");
    process.exit(exitCode);
  } catch (err) {
    clearTimeout(forceExit);
    logger.error({ err, signal }, "Error during graceful shutdown — forcing exit");
    process.exit(1);
  }
}

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM", 0));
process.on("SIGINT", () => void gracefulShutdown("SIGINT", 0));

// ============================================================================
// Process-level safety nets — drain best-effort, then exit non-zero.
// (If a crash fires mid-SIGTERM-drain, the shuttingDown guard lets the original
// drain finish; the forceExit timer still bounds a hang.)
// ============================================================================

process.on("unhandledRejection", (reason: unknown) => {
  logger.fatal({ err: reason }, "Unhandled promise rejection");
  void gracefulShutdown("unhandledRejection", 1);
});

process.on("uncaughtException", (err: Error) => {
  logger.fatal({ err }, "Uncaught exception");
  void gracefulShutdown("uncaughtException", 1);
});

export default app;
