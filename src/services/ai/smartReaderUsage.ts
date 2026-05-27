/**
 * @ai-context Smart Reader free-use counter service.
 *
 * Tracks monthly non-entitled Smart Reader (equipment recognition) calls in
 * the SmartReaderUsage table. Entitled users (hollisIntelligence) never touch
 * this service — the route layer bypasses it via the `entitled` flag.
 *
 * Contract:
 *   checkAndIncrementSmartReaderUsage(userId) →
 *     ok({ used, limit, remaining })  — under the limit; counter incremented
 *     err('RATE_LIMITED', ...)         — over the limit; counter NOT incremented
 *
 * The month key is the current UTC calendar month ("yyyy-mm") so the counter
 * resets automatically each month without a cron job.
 *
 * deps: lib/prisma, lib/env, lib/logger | consumers: src/routes/ai/recognizeEquipment.ts
 */

import type { Result } from "@hollis-studio/contracts";
import { ok, err } from "@hollis-studio/contracts";
import { prisma } from "../../lib/prisma.js";
import { env } from "../../lib/env.js";
import { logger } from "../../lib/logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SmartReaderUsageCounts {
  used: number;
  limit: number;
  remaining: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function currentMonthKey(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}`;
}

// ── Service functions ─────────────────────────────────────────────────────────

/**
 * Reads the current month's usage for a non-entitled user without incrementing.
 * Used by GET /v1/ai/smart-reader-usage.
 */
export async function getSmartReaderUsage(
  userId: string,
): Promise<Result<SmartReaderUsageCounts>> {
  const limit = env.SMART_READER_FREE_USES;
  const month = currentMonthKey();

  try {
    const row = await prisma.smartReaderUsage.findUnique({
      where: { userId_month: { userId, month } },
      select: { count: true },
    });
    const used = row?.count ?? 0;
    return ok({ used, limit, remaining: Math.max(0, limit - used) });
  } catch (error) {
    logger.error(
      {
        userId,
        month,
        error: error instanceof Error ? error.message : String(error),
        component: "smartReaderUsage",
      },
      "getSmartReaderUsage: DB read failed",
    );
    return err("INTERNAL_ERROR", "Failed to read Smart Reader usage");
  }
}

/**
 * Checks the monthly limit and, if under the limit, atomically increments
 * the counter. Returns the usage counts (post-increment on ok, pre-check on err).
 *
 * On limit exceeded: returns err('RATE_LIMITED', ...) with details.
 * The counter is NOT incremented when the limit is already reached.
 */
export async function checkAndIncrementSmartReaderUsage(
  userId: string,
): Promise<Result<SmartReaderUsageCounts>> {
  const limit = env.SMART_READER_FREE_USES;
  const month = currentMonthKey();

  try {
    // Read current count first to provide a clear error with usage details.
    const existing = await prisma.smartReaderUsage.findUnique({
      where: { userId_month: { userId, month } },
      select: { count: true },
    });
    const currentCount = existing?.count ?? 0;

    if (currentCount >= limit) {
      return err("RATE_LIMITED", "Smart Reader free-use limit reached for this month", {
        used: currentCount,
        limit,
        remaining: 0,
      });
    }

    // Under the limit — upsert to increment the counter.
    const updated = await prisma.smartReaderUsage.upsert({
      where: { userId_month: { userId, month } },
      create: { userId, month, count: 1 },
      update: { count: { increment: 1 } },
      select: { count: true },
    });

    const used = updated.count;
    return ok({ used, limit, remaining: Math.max(0, limit - used) });
  } catch (error) {
    logger.error(
      {
        userId,
        month,
        error: error instanceof Error ? error.message : String(error),
        component: "smartReaderUsage",
      },
      "checkAndIncrementSmartReaderUsage: DB operation failed",
    );
    return err("INTERNAL_ERROR", "Failed to record Smart Reader usage");
  }
}
