/**
 * @ai-context Structured logging for Workouts Server using pino.
 *
 * deps: pino | consumers: src/middleware/*, src/routes/*
 */

import pino from "pino";

const isDevelopment = process.env.NODE_ENV !== "production";

function getDefaultLogLevel(): string {
  if (process.env.NODE_ENV === "test") return "silent";
  if (isDevelopment) return "debug";
  return "info";
}

const VALID_LOG_LEVELS = ["debug", "info", "warn", "error", "fatal"] as const;
type ValidLogLevel = (typeof VALID_LOG_LEVELS)[number];

const rawLevel = process.env.LOG_LEVEL;
const logLevel: ValidLogLevel = (VALID_LOG_LEVELS as readonly string[]).includes(rawLevel ?? "")
  ? (rawLevel as ValidLogLevel)
  : (getDefaultLogLevel() as ValidLogLevel);

export const logger = pino({
  level: logLevel,
  base: {
    service: "hollis-workouts-server",
    env: process.env.NODE_ENV ?? "development",
    instanceId: process.env.ECS_TASK_ID ?? process.env.HOSTNAME ?? "local",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.body",
      "req.query",
      "res.body",
      "token",
      "refreshToken",
      "accessToken",
      "password",
      "apiKey",
      "*.token",
      "*.accessToken",
      "*.password",
      "*.apiKey",
    ],
    remove: true,
  },
  transport: isDevelopment
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss.l",
          ignore: "pid,hostname,service,env",
          errorLikeObjectKeys: ["err", "error"],
        },
      }
    : undefined,
});

export function createChildLogger(context: Record<string, unknown>): pino.Logger {
  return logger.child(context);
}

export type Logger = pino.Logger;
