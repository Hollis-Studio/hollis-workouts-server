/**
 * @ai-context UserProfile resource router — per-user SINGLETON.
 *
 * Special case: singleton row keyed by userId (userId IS the PK — mirrors the
 * Firestore `users/{uid}` singleton doc pattern and resolves the historical
 * client-sync mismatch where the doc was mis-keyed).
 * No `:id` param in any URL.
 *
 * Verbs:
 *   GET /  — fetch the caller's profile; 404 if absent (first-use bootstrap)
 *   PUT /  — upsert the singleton by { userId }; userId always from token
 *
 * The app writes `settings` and `entitlements` as deeply nested Json blobs.
 * Scalar columns that are individually gated (fcmDeviceToken,
 * smartReaderFreeUsesRemaining) are promoted to first-class PUT fields so they
 * can be written alongside the blobs without an extra PATCH surface.
 *
 * Wired by: src/routes/index.ts at /profile
 *   apiRouter.use("/profile", userProfileRouter);
 *
 * deps: express, zod, lib/AppError, lib/prisma, middleware/errorHandler,
 *       middleware/rateLimit, utils/response
 * consumers: routes/index.ts
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { AppError } from "../lib/AppError.js";
import { prisma } from "../lib/prisma.js";
import { asyncWrapper } from "../middleware/errorHandler.js";
import { writeRateLimiter } from "../middleware/rateLimit.js";
import { sendSuccess } from "../utils/response.js";

// ---------------------------------------------------------------------------
// Sub-schemas — mirrors app UserSettingsSchema and UserEntitlementsSchema
// but kept inline (no import from the app package) to maintain server/client
// package isolation.
// ---------------------------------------------------------------------------

/**
 * UserSettings — stored as Json but validated at write time.
 * passthrough() so that forward-compat fields from newer clients are not
 * rejected and silently dropped.
 */
const userSettingsSchema = z
  .object({
    defaultWeightUnit: z.enum(["kg", "lbs"]),
    defaultWeightMode: z.enum(["absolute", "relative"]),
    defaultDistanceUnit: z.enum(["km", "mi"]),
    defaultWeightIncrementKg: z.number().min(0).optional(),
    workoutExperienceLevel: z
      // "new" is the app's first-run value (WORKOUT_EXPERIENCE_LEVELS) — must be
      // accepted or every freshly-onboarded user's profile PUT 400s.
      .enum(["new", "beginner", "intermediate", "advanced"])
      .optional(),
    progressionIncrementKg: z.number().min(0),
    repIncrement: z.number().int().min(1),
    goEasierPercent: z.number().min(0).max(1),
    defaultRestTimerSec: z.number().int().min(0),
    theme: z.string().min(1),
    languageTag: z.string().optional(),
    gender: z.string().optional(),
    appleHealthConnected: z.boolean(),
    repThresholdForWeightJump: z.number().int().min(1),
    cardioProgressionFocus: z.enum(["duration", "distance", "pace"]),
    notificationsEnabled: z.boolean(),
    dailySummaryTime: z.string().regex(/^\d{2}:\d{2}$/),
    weeklySummaryDay: z.number().int().min(0).max(6),
    timeZone: z.string().min(1).optional(),
    workoutReminderEnabled: z.boolean(),
    workoutReminderTime: z.string().regex(/^\d{2}:\d{2}$/),
    hapticIntensity: z.enum(["light", "medium", "heavy", "off"]).optional(),
    defaultRIR: z.number().int().min(0).max(5).optional(),
    dailyNotificationTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    volumeTargets: z.record(z.string(), z.number().int().min(1)).optional(),
    trainingPhase: z.string().optional(),
    trainingPhaseStartedAt: z.number().optional(),
    phaseEntryBaselines: z.record(z.string(), z.number().min(0)).optional(),
    adaptiveProgression: z.boolean().optional(),
    cardioGoalPreset: z
      .enum(["none", "general", "endurance", "weight_loss", "threshold"])
      .optional(),
    cardioWeeklyTargets: z
      .object({
        z1Min: z.number(),
        z2Min: z.number(),
        z3Min: z.number(),
        z4Min: z.number(),
      })
      .optional(),
    dateOfBirth: z.number().optional(),
    maxHRBpm: z.number().optional(),
    hrZoneOverrides: z
      .object({
        z1: z.object({ minBpm: z.number(), maxBpm: z.number() }).optional(),
        z2: z.object({ minBpm: z.number(), maxBpm: z.number() }).optional(),
        z3: z.object({ minBpm: z.number(), maxBpm: z.number() }).optional(),
        z4: z.object({ minBpm: z.number(), maxBpm: z.number() }).optional(),
      })
      .optional(),
    sundayReview: z
      .object({
        enabled: z.boolean(),
        dayOfWeek: z.union([
          z.literal(0),
          z.literal(1),
          z.literal(2),
          z.literal(3),
          z.literal(4),
          z.literal(5),
          z.literal(6),
        ]),
        hourLocal: z.number().int().min(0).max(23),
        pushEnabled: z.boolean(),
        timeZone: z.string().min(1),
      })
      .optional(),
    notificationSettings: z
      .object({
        masterEnabled: z.boolean(),
        workoutReminder: z.object({
          enabled: z.boolean(),
          reminderTime: z.string().regex(/^\d{2}:\d{2}$/),
          minutesBefore: z.number().int().min(0).optional(),
        }),
        restDayPulse: z.object({ enabled: z.boolean() }),
      })
      .optional(),
    simpleModeEnabled: z.boolean().optional(),
  })
  .passthrough();

/** UserEntitlements — optional Json blob */
const userEntitlementsSchema = z
  .object({
    aiTier: z.string().optional(),
    source: z.string().optional(),
    subscriptionStatus: z.string().optional(),
    subscriptionProvider: z.string().min(1).optional(),
    productId: z.string().min(1).optional(),
    originalTransactionId: z.string().min(1).optional(),
    suiteEntitlementId: z.string().min(1).optional(),
    expiresAt: z.coerce.date().optional(),
    lastValidatedAt: z.coerce.date().optional(),
    updatedAt: z.coerce.date().optional(),
  })
  .passthrough()
  .optional();

// ---------------------------------------------------------------------------
// Body schema — mirrors UserProfile (minus userId, which comes from the token)
// ---------------------------------------------------------------------------

const userProfileBodySchema = z.object({
  displayName: z.string().min(1).max(200),
  email: z.string().email().optional(),
  settings: userSettingsSchema,
  entitlements: userEntitlementsSchema,
  smartReaderFreeUsesRemaining: z.number().int().min(0).optional(),
  lastReviewPromptAt: z.coerce.date().nullable().optional(),
  fcmDeviceToken: z.string().optional(),
  lastFcmTokenUpdate: z.coerce.date().optional(),
  createdAt: z.coerce.date().optional(),
  // updatedAt is Prisma @updatedAt managed — ignored if supplied
  updatedAt: z.coerce.date().optional(),
});

type UserProfileBody = z.infer<typeof userProfileBodySchema>;

/**
 * The app's UserProfileSchema requires a `uid` field (the singleton doc id from
 * the Firestore era), but this table's PK column is `userId`. Surface `uid` in
 * every response so the client's Zod accepts the payload (extra `userId` is
 * harmless — the client schema strips unknown keys).
 */
function toClientProfile<T extends { userId: string }>(profile: T): T & { uid: string } {
  return { ...profile, uid: profile.userId };
}

export const userProfileRouter = Router();

// GET / — fetch singleton for the authenticated user
userProfileRouter.get(
  "/",
  asyncWrapper(async (req: Request, res: Response) => {
    if (!req.userId) throw AppError.unauthorized();

    const profile = await prisma.userProfile.findUnique({
      where: { userId: req.userId },
    });

    if (!profile) throw AppError.notFound("UserProfile");

    sendSuccess(res, toClientProfile(profile));
  }),
);

// PUT / — upsert singleton
userProfileRouter.put(
  "/",
  writeRateLimiter,
  asyncWrapper(async (req: Request, res: Response) => {
    if (!req.userId) throw AppError.unauthorized();

    const bodyParsed = userProfileBodySchema.safeParse(req.body);
    if (!bodyParsed.success) {
      throw AppError.badRequest("Invalid UserProfile body", bodyParsed.error.issues);
    }

    // Destructure and strip server-managed / client-injected fields.
    const { updatedAt: _updatedAt, createdAt: bodyCreatedAt, ...rest }: UserProfileBody =
      bodyParsed.data;

    // Use client-supplied createdAt for first-write (mirrors Firestore createdAt
    // from the original doc), otherwise fall back to now.
    const createdAt =
      bodyCreatedAt instanceof Date ? bodyCreatedAt : new Date();

    // userId is always authoritative from the token, never from body.
    const profile = await prisma.userProfile.upsert({
      where: { userId: req.userId },
      create: {
        userId: req.userId,
        createdAt,
        displayName: rest.displayName,
        email: rest.email,
        settings: rest.settings as Parameters<
          typeof prisma.userProfile.upsert
        >[0]["create"]["settings"],
        entitlements:
          rest.entitlements !== undefined
            ? (rest.entitlements as Parameters<
                typeof prisma.userProfile.upsert
              >[0]["create"]["entitlements"])
            : undefined,
        smartReaderFreeUsesRemaining: rest.smartReaderFreeUsesRemaining ?? null,
        lastReviewPromptAt: rest.lastReviewPromptAt ?? null,
        fcmDeviceToken: rest.fcmDeviceToken ?? null,
        lastFcmTokenUpdate: rest.lastFcmTokenUpdate ?? null,
      },
      update: {
        displayName: rest.displayName,
        email: rest.email,
        settings: rest.settings as Parameters<
          typeof prisma.userProfile.upsert
        >[0]["update"]["settings"],
        entitlements:
          rest.entitlements !== undefined
            ? (rest.entitlements as Parameters<
                typeof prisma.userProfile.upsert
              >[0]["update"]["entitlements"])
            : undefined,
        smartReaderFreeUsesRemaining: rest.smartReaderFreeUsesRemaining ?? null,
        lastReviewPromptAt: rest.lastReviewPromptAt ?? null,
        fcmDeviceToken: rest.fcmDeviceToken ?? null,
        lastFcmTokenUpdate: rest.lastFcmTokenUpdate ?? null,
      },
    });

    // Singleton upsert — 200 (idempotent; not 201)
    sendSuccess(res, toClientProfile(profile));
  }),
);
