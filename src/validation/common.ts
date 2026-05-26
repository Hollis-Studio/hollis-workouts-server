/**
 * @ai-context Common Zod validation schemas for Workouts Server.
 *
 * deps: zod | consumers: route handlers
 */

import { z } from "zod";

/**
 * Caller-provided string ID (cuid2 or UUID — format-agnostic).
 * Max 512 (not 128): most ids are short, but metric-basket-snapshot ids are a
 * composite "{exerciseId}__{captureKind}__{sourceSessionId|timestamp}" that can
 * legitimately reach ~270 chars. A 128 cap would 400 those on GET/PUT.
 */
export const idSchema = z.string().min(1).max(512);

/** ISO 8601 week string e.g. "2025-W20" */
export const weekIsoSchema = z.string().regex(/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/);

/** Pagination query params */
export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

export type Pagination = z.infer<typeof paginationSchema>;
