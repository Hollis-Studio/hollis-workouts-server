/**
 * @ai-context Sentry SDK initialisation for Workouts Server.
 *
 * Exports:
 *   initSentry()  — call once at process start (in src/index.ts, NOT here).
 *                   NO-OPs when SENTRY_DSN is unset so the server boots in
 *                   development / CI without any Sentry credentials.
 *
 * Integration agent wiring (src/index.ts — NOT this file):
 *   import { initSentry } from "./lib/sentry.js";
 *   initSentry(); // must be the FIRST thing called, before createApp()
 *
 * PHI / secrets redaction:
 *   `beforeSend` runs `sanitizeSentryEvent` from @hollis-studio/contracts which
 *   strips known auth headers (Authorization, Cookie, x-api-key, etc.) and
 *   sensitive field names (tokens, passwords, PII fields) from every event.
 *   Request bodies are removed entirely — we never want to send user workout
 *   data or health payloads to Sentry.
 *
 * Profiling:
 *   nodeProfilingIntegration() is included. tracesSampleRate and
 *   profilesSampleRate are tuned for production (1 % traces, 100 % profiles on
 *   sampled traces). Adjust via SENTRY_TRACES_SAMPLE_RATE / SENTRY_PROFILES_SAMPLE_RATE
 *   env vars if needed in the future — hardcoded for now per the gold standard.
 *
 * deps: @sentry/node, @sentry/profiling-node, @hollis-studio/contracts,
 *       lib/env, lib/logger
 * consumers: src/index.ts (initSentry call), src/app.ts (error handler wiring)
 */

import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";
import { sanitizeSentryEvent } from "@hollis-studio/contracts";
import { env } from "./env.js";
import { logger } from "./logger.js";

/**
 * Initialize the Sentry SDK.
 *
 * Call this once at process start — before `createApp()` — so Sentry can
 * instrument modules as they are loaded (OpenTelemetry auto-instrumentation).
 *
 * NO-OPs when SENTRY_DSN is unset (development / CI).
 */
export function initSentry(): void {
  if (!env.SENTRY_DSN) {
    logger.info("Sentry DSN not configured — error tracking disabled");
    return;
  }

  Sentry.init({
    dsn: env.SENTRY_DSN,

    environment: env.NODE_ENV,

    integrations: [
      nodeProfilingIntegration(),
    ],

    // 1 % of transactions — enough for production performance insight without
    // significant overhead on a mobile-sync API.
    tracesSampleRate: 0.01,

    // Profile 100 % of the sampled transactions (profiling is gated by tracesSampleRate).
    profilesSampleRate: 1.0,

    /**
     * PHI / secrets scrub — runs before every event is sent to Sentry.
     *
     * 1. Remove the full request body — workout payloads, health data, etc.
     *    must never leave the server unencrypted.
     * 2. Run sanitizeSentryEvent from @hollis-studio/contracts which strips
     *    auth headers (Authorization, Cookie, x-api-key …) and known sensitive
     *    field names (tokens, passwords, PII) from the event envelope.
     */
    beforeSend(event) {
      // Strip the request body entirely before any field-level sanitization.
      if (event.request) {
        delete event.request.data;
      }
      // Strip sensitive headers and fields via the shared contracts helper.
      return sanitizeSentryEvent(event);
    },
  });

  logger.info({ environment: env.NODE_ENV }, "Sentry initialised");
}

// Re-export Sentry so app.ts (and any future callers) don't need a second
// `import * as Sentry from "@sentry/node"` — reduces surface for version drift.
export { Sentry };
