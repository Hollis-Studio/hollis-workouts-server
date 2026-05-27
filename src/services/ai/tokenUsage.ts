/**
 * @ai-context AI token usage telemetry — records per-feature token counts to
 * the AiTokenUsage Postgres table (upsert by userId + month).
 *
 * Mirrors functions/src/middleware/recordTokenUsage.ts but writes to Postgres
 * instead of Firestore.
 *
 * This is fire-and-forget: failures are logged but never propagate to the
 * caller. A telemetry miss must never cause a 5xx for the end user.
 *
 * deps: lib/prisma, lib/logger | consumers: src/services/ai/*
 */

import { createId } from "@paralleldrive/cuid2";
import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RecordTokenUsageParams {
  userId: string;
  feature: string;
  model: string;
  usageMetadata: unknown;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readTokenCount(
  source: Record<string, unknown>,
  key: string,
): number | null {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
}

function extractTokenCounts(usageMetadata: unknown): {
  inputTokens: number;
  outputTokens: number;
} {
  if (typeof usageMetadata !== "object" || usageMetadata === null) {
    return { inputTokens: 0, outputTokens: 0 };
  }

  const usage = usageMetadata as Record<string, unknown>;
  const promptTokenCount = readTokenCount(usage, "promptTokenCount");
  const candidatesTokenCount = readTokenCount(usage, "candidatesTokenCount");
  const thoughtsTokenCount =
    readTokenCount(usage, "thoughtsTokenCount") ?? 0;
  const totalTokenCount = readTokenCount(usage, "totalTokenCount");

  const inputTokens = promptTokenCount ?? 0;
  if (totalTokenCount !== null && promptTokenCount !== null) {
    return {
      inputTokens,
      outputTokens: Math.max(0, totalTokenCount - promptTokenCount),
    };
  }

  return {
    inputTokens,
    outputTokens: (candidatesTokenCount ?? 0) + thoughtsTokenCount,
  };
}

function toMonthKey(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fire-and-forget token usage recording.
 * Never throws — any error is logged at warn level.
 */
export async function recordTokenUsage({
  userId,
  feature,
  usageMetadata,
}: RecordTokenUsageParams): Promise<void> {
  try {
    const { inputTokens, outputTokens } = extractTokenCounts(usageMetadata);
    const totalTokens = inputTokens + outputTokens;
    const month = toMonthKey(new Date());

    // Upsert: merge the new feature count into the existing tokens map.
    // Postgres JSON merge via Prisma: fetch-modify-upsert in a single step is
    // complex; we do a lightweight read-then-write (acceptable since this is
    // telemetry — occasional double-writes under concurrent requests are fine).
    const existing = await prisma.aiTokenUsage.findUnique({
      where: { userId_month: { userId, month } },
      select: { id: true, tokens: true },
    });

    if (existing) {
      const tokens = (
        typeof existing.tokens === "object" && existing.tokens !== null
          ? existing.tokens
          : {}
      ) as Record<string, number>;
      const current = typeof tokens[feature] === "number" ? tokens[feature] : 0;
      tokens[feature] = current + totalTokens;

      await prisma.aiTokenUsage.update({
        where: { id: existing.id },
        data: { tokens },
      });
    } else {
      await prisma.aiTokenUsage.create({
        data: {
          id: createId(),
          userId,
          month,
          tokens: { [feature]: totalTokens },
          createdAt: new Date(),
        },
      });
    }
  } catch (error) {
    logger.warn(
      {
        userId,
        feature,
        error: error instanceof Error ? error.message : String(error),
        component: "tokenUsage",
      },
      "recordTokenUsage: failed to write AI token telemetry",
    );
  }
}
