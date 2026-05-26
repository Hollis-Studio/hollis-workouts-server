/**
 * @ai-context MetricBasketSnapshots resource router — CRUD for MetricBasketSnapshotRecord.
 *
 * Operations:
 *   GET    /metric-basket-snapshots       — list user's snapshots; filters below
 *   GET    /metric-basket-snapshots/:id   — single snapshot (IDOR-safe)
 *   PUT    /metric-basket-snapshots/:id   — idempotent upsert (offline-first sync)
 *   DELETE /metric-basket-snapshots/:id   — hard delete
 *
 * DELETE style: hard (snapshots may be cleaned up per-session on discard)
 * Wired by: src/routes/index.ts at /metric-basket-snapshots
 *
 * The `id` is a caller-provided composite string:
 *   "{exerciseId}__{captureKind}__{sourceSessionId|timestamp}"
 *
 * listFilters:
 *   ?exerciseId=<id>        — most common query pattern
 *   ?captureKind=<kind>     — "manual" | "pre_session" | "post_session"
 *   ?since=<ISO datetime>   — capturedAt >= since
 *   ?sourceSessionId=<id>   — session that triggered the capture
 *
 * Body schema mirrors MetricBasketSnapshotRecord (from @hollis-studio/contracts):
 *   exerciseId, capturedAt, captureKind, sourceSessionId?, snapshot
 * createdAt is server-managed (set by factory on create; not accepted from client).
 *
 * deps: lib/crud, lib/prisma, zod, @hollis-studio/contracts/progression/metrics
 * consumers: routes/index.ts
 */

import { z } from "zod";
import {
  MetricBasketSnapshotSchema,
  MetricBasketSnapshotCaptureKindSchema,
} from "@hollis-studio/contracts/progression/metrics";
import { prisma } from "../lib/prisma.js";
import { createCrudRouter } from "../lib/crud.js";
import { AppError } from "../lib/AppError.js";
import { idSchema } from "../validation/common.js";
import type { Request } from "express";

// ---------------------------------------------------------------------------
// Body schema — mirrors MetricBasketSnapshotRecord minus userId and createdAt.
// userId is always taken from the auth token.
// createdAt is server-managed: the factory sets it on create, never from client.
// snapshot is validated via the canonical contracts schema.
// ---------------------------------------------------------------------------

const metricBasketSnapshotBodySchema = z.object({
  exerciseId: z.string().min(1).max(128),
  // z.coerce.date() converts ISO 8601 strings to Date objects, which is what
  // the Prisma DateTime column requires.  z.string().datetime() would pass a
  // string through and cause a Prisma type error at runtime.
  capturedAt: z.coerce.date(),
  captureKind: MetricBasketSnapshotCaptureKindSchema,
  sourceSessionId: z.string().min(1).max(128).optional(),
  snapshot: MetricBasketSnapshotSchema,
});

// ---------------------------------------------------------------------------
// listFilters — all four query params honoured; since is parsed to Date for
// Prisma's gte filter on the capturedAt DateTime column.
//
// When a filter param is present but invalid we throw 400 immediately rather
// than silently dropping it.  Silently dropping would return ALL rows when the
// client expected a narrowed result, which is both incorrect and a potential
// data-volume / information-disclosure issue.
// ---------------------------------------------------------------------------

function metricBasketListFilters(req: Request): Record<string, unknown> {
  const { exerciseId, captureKind, since, sourceSessionId } = req.query as Record<string, string | undefined>;

  const filters: Record<string, unknown> = {};

  if (exerciseId !== undefined) {
    const result = idSchema.safeParse(exerciseId);
    if (!result.success) throw AppError.badRequest("Invalid exerciseId filter", result.error.issues);
    filters.exerciseId = result.data;
  }

  if (captureKind !== undefined) {
    const kindResult = MetricBasketSnapshotCaptureKindSchema.safeParse(captureKind);
    if (!kindResult.success) {
      throw AppError.badRequest("Invalid captureKind filter", kindResult.error.issues);
    }
    filters.captureKind = kindResult.data;
  }

  if (since !== undefined) {
    const sinceDate = new Date(since);
    if (Number.isNaN(sinceDate.getTime())) {
      throw AppError.badRequest("Invalid since filter — must be a valid ISO 8601 datetime");
    }
    filters.capturedAt = { gte: sinceDate };
  }

  if (sourceSessionId !== undefined) {
    const result = idSchema.safeParse(sourceSessionId);
    if (!result.success) throw AppError.badRequest("Invalid sourceSessionId filter", result.error.issues);
    filters.sourceSessionId = result.data;
  }

  return filters;
}

export const metricBasketSnapshotsRouter = createCrudRouter({
  delegate: prisma.metricBasketSnapshotRecord,
  resourceName: "MetricBasketSnapshot",
  bodySchema: metricBasketSnapshotBodySchema,
  idParam: "id",
  deleteStyle: "hard",
  listFilters: metricBasketListFilters,
});
