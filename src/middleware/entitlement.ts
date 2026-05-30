/**
 * @ai-context RevenueCat entitlement guard middleware for Express.
 *
 * Ports functions/src/middleware/requireEntitlement.ts from Cloud Functions.
 * Uses REVENUECAT_REST_API_KEY to verify the `hollis_intelligence` entitlement.
 * In-memory cache with 5-min TTL (keyed by userId).
 *
 * Policy:
 *   - REVENUECAT_REST_API_KEY is unset + NODE_ENV !== production:
 *       ALLOW and log a warn (CI / local dev).
 *   - REVENUECAT_REST_API_KEY is unset + NODE_ENV === production:
 *       DENY with 402 (misconfigured production).
 *   - RevenueCat request fails (network error):
 *       Fall back to stale cache if present; otherwise DENY in production,
 *       ALLOW in non-production (matches CF fallback behavior).
 *   - Active entitlement → 200 next().
 *   - No entitlement → 402 ENTITLEMENT_REQUIRED.
 *
 * deps: lib/env, lib/logger | consumers: src/routes/ai/*
 */

import type { NextFunction, Request, Response } from "express";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const REVENUECAT_SUBSCRIBER_URL = "https://api.revenuecat.com/v1/subscribers/";
const ENTITLEMENT_ID = "hollis_intelligence";
const REVENUECAT_ENTITLEMENT_IDS = [
  ENTITLEMENT_ID,
  "hollisIntelligence",
  "Hollis Intelligence",
] as const;

// ── In-memory cache ───────────────────────────────────────────────────────────

interface CacheEntry {
  hollisIntelligence: boolean;
  hasEverSubscribed: boolean;
  lastChecked: number;
}

const entitlementCache = new Map<string, CacheEntry>();

function isCacheFresh(entry: CacheEntry, now: number): boolean {
  return now - entry.lastChecked < CACHE_TTL_MS;
}

// ── RevenueCat client ─────────────────────────────────────────────────────────

interface RevenueCatEntitlement {
  expires_date?: unknown;
}

interface RevenueCatSubscription {
  expires_date?: unknown;
  original_purchase_date?: unknown;
  purchase_date?: unknown;
}

interface RevenueCatSubscriberResponse {
  subscriber?: {
    entitlements?: Record<string, RevenueCatEntitlement | undefined>;
    subscriptions?: Record<string, RevenueCatSubscription | undefined>;
  };
}

function isEntitlementActive(entitlement: RevenueCatEntitlement | undefined): boolean {
  if (!entitlement) return false;
  const expiresDate = entitlement.expires_date;
  if (expiresDate === null) return true; // lifetime purchase
  if (typeof expiresDate !== "string") return false;
  const expiresAt = Date.parse(expiresDate);
  return !Number.isNaN(expiresAt) && expiresAt > Date.now();
}

function hasSubscriberHistory(response: RevenueCatSubscriberResponse): boolean {
  const subscriber = response.subscriber;
  if (!subscriber) return false;
  if (
    REVENUECAT_ENTITLEMENT_IDS.some(
      (entitlementId) => subscriber.entitlements?.[entitlementId],
    )
  ) {
    return true;
  }
  return Object.values(subscriber.subscriptions ?? {}).some((sub) => {
    if (!sub) return false;
    return (
      typeof sub.purchase_date === "string" ||
      typeof sub.original_purchase_date === "string" ||
      typeof sub.expires_date === "string"
    );
  });
}

async function fetchEntitlementFromRevenueCat(
  userId: string,
  apiKey: string,
): Promise<CacheEntry> {
  const response = await fetch(
    `${REVENUECAT_SUBSCRIBER_URL}${encodeURIComponent(userId)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    },
  );

  if (!response.ok) {
    throw new Error(`RevenueCat returned HTTP ${response.status}`);
  }

  const json = (await response.json()) as RevenueCatSubscriberResponse;
  const hollisIntelligence = REVENUECAT_ENTITLEMENT_IDS.some((entitlementId) =>
    isEntitlementActive(json.subscriber?.entitlements?.[entitlementId]),
  );

  return {
    hollisIntelligence,
    hasEverSubscribed: hollisIntelligence || hasSubscriberHistory(json),
    lastChecked: Date.now(),
  };
}

// ── Middleware factory ─────────────────────────────────────────────────────────

function denyEntitlement(res: Response): void {
  res.status(402).json({
    ok: false,
    err: {
      code: "ENTITLEMENT_REQUIRED",
      message: "Hollis Intelligence entitlement required.",
      details: { entitlement: "hollisIntelligence" },
    },
  });
}

/**
 * Express middleware that verifies the hollisIntelligence RevenueCat entitlement.
 * Must be called after requireAuth (requires req.userId).
 */
export async function requireEntitlement(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ ok: false, err: { code: "UNAUTHORIZED", message: "Unauthorized" } });
    return;
  }

  const apiKey = env.REVENUECAT_REST_API_KEY;

  // ── No API key configured ────────────────────────────────────────────────
  if (!apiKey) {
    if (env.NODE_ENV === "production") {
      logger.error(
        { userId, component: "entitlement" },
        "REVENUECAT_REST_API_KEY is not configured in production — denying request",
      );
      denyEntitlement(res);
      return;
    }
    // Non-production: allow with a warn (CI / local dev)
    logger.warn(
      { userId, component: "entitlement" },
      "REVENUECAT_REST_API_KEY is not set — allowing request in non-production",
    );
    next();
    return;
  }

  const now = Date.now();
  const cached = entitlementCache.get(userId);

  // ── Fresh cache hit ──────────────────────────────────────────────────────
  if (cached && isCacheFresh(cached, now)) {
    if (cached.hollisIntelligence) {
      next();
      return;
    }
    denyEntitlement(res);
    return;
  }

  // ── Fetch from RevenueCat ────────────────────────────────────────────────
  try {
    const entry = await fetchEntitlementFromRevenueCat(userId, apiKey);
    entitlementCache.set(userId, entry);

    if (entry.hollisIntelligence) {
      next();
      return;
    }
    denyEntitlement(res);
    return;
  } catch (error) {
    logger.warn(
      {
        userId,
        error: error instanceof Error ? error.message : String(error),
        component: "entitlement",
      },
      "requireEntitlement: RevenueCat lookup failed; falling back to cache",
    );

    // Fall back to stale cache
    if (cached?.hollisIntelligence) {
      next();
      return;
    }

    // No cache at all or cache says no entitlement
    if (env.NODE_ENV === "production") {
      denyEntitlement(res);
      return;
    }

    // Non-production: allow on RevenueCat failure (matches CF behavior)
    logger.warn(
      { userId, component: "entitlement" },
      "requireEntitlement: allowing request in non-production after RevenueCat failure",
    );
    next();
    return;
  }
}

/** Clears the in-memory entitlement cache (useful for tests). */
export function clearEntitlementCacheForTests(): void {
  entitlementCache.clear();
}

/**
 * Non-blocking entitlement check — returns true if the user holds the
 * hollisIntelligence entitlement, false otherwise.
 *
 * Follows the same cache + fallback logic as requireEntitlement but never
 * sends an HTTP response. Use this when the route handles entitled and
 * non-entitled users differently (e.g. Smart Reader free-use counter).
 *
 * Must be called after requireAuth (requires req.userId).
 */
export async function checkHollisIntelligence(userId: string): Promise<boolean> {
  const apiKey = env.REVENUECAT_REST_API_KEY;

  if (!apiKey) {
    // Non-production or misconfigured: mirror requireEntitlement fallback.
    return env.NODE_ENV !== "production";
  }

  const now = Date.now();
  const cached = entitlementCache.get(userId);

  if (cached && isCacheFresh(cached, now)) {
    return cached.hollisIntelligence;
  }

  try {
    const entry = await fetchEntitlementFromRevenueCat(userId, apiKey);
    entitlementCache.set(userId, entry);
    return entry.hollisIntelligence;
  } catch (error) {
    logger.warn(
      {
        userId,
        error: error instanceof Error ? error.message : String(error),
        component: "entitlement",
      },
      "checkHollisIntelligence: RevenueCat lookup failed; falling back to cache",
    );
    // Fall back to stale cache if available, else deny in production
    if (cached?.hollisIntelligence) return true;
    return env.NODE_ENV !== "production";
  }
}
