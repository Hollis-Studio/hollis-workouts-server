/**
 * Seed the Workouts reviewer account through the production REST APIs.
 *
 * This intentionally writes through Identity + Workouts Server instead of
 * connecting directly to Postgres, so auth and validation match the app path.
 */

const IDENTITY_BASE_URL =
  process.env.IDENTITY_BASE_URL ??
  process.env.EXPO_PUBLIC_IDENTITY_BASE_URL ??
  "https://identity.hollis.health/v1";
const WORKOUTS_API_BASE_URL =
  process.env.WORKOUTS_API_BASE_URL ??
  process.env.EXPO_PUBLIC_WORKOUTS_API_BASE_URL ??
  "https://workouts-api.hollis.health/v1";
const REVIEWER_EMAIL = process.env.REVIEWER_EMAIL ?? process.env.EXPO_PUBLIC_DEMO_EMAIL;
const REVIEWER_PASSWORD =
  process.env.REVIEWER_PASSWORD ?? process.env.EXPO_PUBLIC_DEMO_PASSWORD;

const ENTITLEMENT_ID = "Hollis Intelligence";
const PRODUCT_ID = "hollis_intelligence_annual";

interface IdentityProfile {
  userId?: string;
  uid?: string;
  email: string | null;
  displayName?: string;
  role: string;
  organizationId: string | null;
}

interface IdentitySessionResponse {
  profile: IdentityProfile;
  idToken: string;
  expiresAt: string;
  provider: string;
}

interface Envelope<T> {
  ok?: boolean;
  success?: boolean;
  data?: T;
  err?: { code?: string; message?: string };
  error?: { code?: string; message?: string };
  message?: string;
}

interface ListResponse<T> {
  items: T[];
  nextCursor: string | null;
}

interface AiAuditLogItem {
  id: string;
  surface: string;
}

interface SeedContext {
  token: string;
  userId: string;
  expiresAt: string;
}

type JsonObject = Record<string, unknown>;

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/$/, "");
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text.trim()) return undefined as T;
  return JSON.parse(text) as T;
}

function unwrap<T>(envelope: Envelope<T> | T): T {
  if (
    envelope &&
    typeof envelope === "object" &&
    "data" in envelope &&
    (("ok" in envelope && typeof envelope.ok === "boolean") ||
      ("success" in envelope && typeof envelope.success === "boolean"))
  ) {
    return (envelope as Envelope<T>).data as T;
  }
  return envelope as T;
}

async function request<T>(
  baseUrl: string,
  path: string,
  options: RequestInit & { token?: string } = {},
): Promise<T> {
  const { token, headers, ...rest } = options;
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}${path}`, {
    ...rest,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });
  const json = await readJson<Envelope<T> | T>(response);
  if (!response.ok) {
    const envelope = json as Envelope<T>;
    const message =
      envelope.err?.message ??
      envelope.error?.message ??
      envelope.message ??
      `HTTP ${response.status}`;
    throw new Error(`${rest.method ?? "GET"} ${path} failed: ${message}`);
  }
  return unwrap<T>(json);
}

function requireEnv(name: string, value: string | undefined): string {
  if (!value?.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function isoDaysAgo(days: number, hour = 15): Date {
  const date = new Date();
  date.setUTCHours(hour, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function sessionSet(
  setNumber: number,
  completedAt: Date,
  weightKg: number,
  reps: number,
): JsonObject {
  return {
    setNumber,
    weightKg,
    reps,
    rir: 2,
    isWarmup: false,
    isOutlier: false,
    completedAt: completedAt.toISOString(),
    isConfirmed: true,
    restAfterSec: 120,
    setType: "normal",
    repClass: reps <= 6 ? "S" : reps <= 12 ? "H" : "E",
  };
}

function programSet(setNumber: number, weightKg: number, reps: number): JsonObject {
  return {
    setNumber,
    targetWeightKg: weightKg,
    targetReps: reps,
    targetRIR: 2,
    isWarmup: false,
    setType: "normal",
  };
}

function programExercise(
  canonicalExerciseId: string,
  order: number,
  weightKg: number,
  reps: number,
): JsonObject {
  return {
    canonicalExerciseId,
    order,
    sets: [1, 2, 3].map((setNumber) => programSet(setNumber, weightKg, reps)),
    goalMode: "progress",
    progressionMode: "reps_first",
    repThresholdForWeightJump: 12,
    cardioTargets: null,
    maintenanceTarget: null,
    cardioMaintenanceTarget: null,
    priorityLevel: order === 0 ? "primary" : "secondary",
  };
}

function sessionExercise(
  canonicalExerciseId: string,
  order: number,
  startedAt: Date,
  weightKg: number,
  reps: number,
): JsonObject {
  return {
    canonicalExerciseId,
    freestyleName: null,
    freestyleMuscleGroups: null,
    gymExerciseInstanceId: null,
    order,
    sets: [1, 2, 3].map((setNumber) =>
      sessionSet(setNumber, addMinutes(startedAt, order * 16 + setNumber * 4), weightKg, reps),
    ),
    isFromProgram: true,
    canonicalizationStatus: "matched",
    cardioData: null,
    stretchData: null,
    trackingMode: "reps",
  };
}

function questionnaire(index: number): JsonObject {
  return {
    sleepHours: 7 + (index % 3) * 0.25,
    sleepQuality: 4,
    energyLevel: index % 4 === 0 ? 3 : 4,
    stressLevel: index % 5 === 0 ? 3 : 2,
    sorenessLevel: index % 4 === 0 ? 3 : 2,
    hitMacrosYesterday: true,
    hydrationLevel: 4,
    goEasier: false,
    notes: index % 6 === 0 ? "Travel week, kept one rep in reserve." : "Felt solid.",
    autoFilledSleep: false,
    bodyWeightKg: 86.5,
  };
}

function buildSession(index: number, userId: string): JsonObject {
  const isUpper = index % 2 === 0;
  const startedAt = isoDaysAgo((12 - index) * 7 + 2);
  const completedAt = addMinutes(startedAt, 58);
  const exercises = isUpper
    ? [
        sessionExercise("barbell_bench_press", 0, startedAt, 80 + index * 0.5, 8),
        sessionExercise("cable_lat_pulldown", 1, startedAt, 70 + index * 0.5, 10),
        sessionExercise("dumbbell_shoulder_press", 2, startedAt, 24, 10),
      ]
    : [
        sessionExercise("barbell_back_squat", 0, startedAt, 105 + index, 6),
        sessionExercise("barbell_romanian_deadlift", 1, startedAt, 95 + index, 8),
        sessionExercise("dumbbell_lunges", 2, startedAt, 22, 10),
      ];
  const totalVolumeKg = exercises.reduce((sum, exercise) => {
    const sets = exercise.sets as JsonObject[];
    return (
      sum +
      sets.reduce(
        (setSum, set) => setSum + Number(set.weightKg) * Number(set.reps),
        0,
      )
    );
  }, 0);

  return {
    id: `reviewer-session-${String(index + 1).padStart(2, "0")}`,
    userId,
    programId: "reviewer-3mo-program",
    programDayName: isUpper ? "Upper Strength" : "Lower Strength",
    gymProfileId: "reviewer-gym",
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    isFreestyle: false,
    isSubstitution: false,
    status: "completed",
    questionnaire: questionnaire(index),
    totalVolumeKg,
    durationMinutes: 58,
    untrackedVolume: 0,
    aiOutlierLabel: null,
    schemaVersion: 1,
    programPhase: index < 8 ? "hypertrophy" : "strength",
    skippedExerciseIds: [],
    exercises,
  };
}

async function login(): Promise<SeedContext> {
  const email = requireEnv("REVIEWER_EMAIL or EXPO_PUBLIC_DEMO_EMAIL", REVIEWER_EMAIL);
  const password = requireEnv(
    "REVIEWER_PASSWORD or EXPO_PUBLIC_DEMO_PASSWORD",
    REVIEWER_PASSWORD,
  );
  const session = await request<IdentitySessionResponse>(IDENTITY_BASE_URL, "/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  const userId = session.profile.userId ?? session.profile.uid;
  if (!userId) throw new Error("Identity response did not include a user id");
  return { token: session.idToken, userId, expiresAt: session.expiresAt };
}

async function putWorkouts(
  context: SeedContext,
  path: string,
  body: JsonObject,
): Promise<void> {
  await request(WORKOUTS_API_BASE_URL, path, {
    method: "PUT",
    token: context.token,
    body: JSON.stringify(body),
  });
}

async function seedProfile(context: SeedContext): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now);
  expiresAt.setUTCMonth(expiresAt.getUTCMonth() + 3);
  await putWorkouts(context, "/profile", {
    displayName: "Demo User",
    email: REVIEWER_EMAIL,
    createdAt: isoDaysAgo(90).toISOString(),
    settings: {
      defaultWeightUnit: "lbs",
      defaultWeightMode: "absolute",
      defaultDistanceUnit: "mi",
      defaultWeightIncrementKg: 2.5,
      workoutExperienceLevel: "intermediate",
      progressionIncrementKg: 2.5,
      repIncrement: 1,
      goEasierPercent: 0.1,
      defaultRestTimerSec: 120,
      theme: "clay_dark",
      gender: "male",
      appleHealthConnected: false,
      repThresholdForWeightJump: 12,
      cardioProgressionFocus: "duration",
      notificationsEnabled: false,
      dailySummaryTime: "20:00",
      weeklySummaryDay: 0,
      timeZone: "America/Chicago",
      workoutReminderEnabled: false,
      workoutReminderTime: "09:00",
      hapticIntensity: "medium",
      defaultRIR: 2,
      dailyNotificationTime: "07:00",
      trainingPhase: "strength",
      trainingPhaseStartedAt: isoDaysAgo(28).getTime(),
      simpleModeEnabled: false,
      sundayReview: {
        enabled: true,
        dayOfWeek: 0,
        hourLocal: 18,
        pushEnabled: false,
        timeZone: "America/Chicago",
      },
      notificationSettings: {
        masterEnabled: false,
        workoutReminder: { enabled: false, reminderTime: "09:00" },
        restDayPulse: { enabled: false },
      },
    },
    entitlements: {
      aiTier: "paid",
      source: "provider",
      subscriptionStatus: "active",
      subscriptionProvider: "revenuecat",
      productId: PRODUCT_ID,
      originalTransactionId: "reviewer-promotional",
      suiteEntitlementId: ENTITLEMENT_ID,
      expiresAt: expiresAt.toISOString(),
      lastValidatedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
    smartReaderFreeUsesRemaining: 3,
    lastReviewPromptAt: null,
  });
}

async function seedGym(context: SeedContext): Promise<void> {
  await putWorkouts(context, "/gyms/reviewer-gym", {
    name: "Hollis Demo Gym",
    location: { address: "New Braunfels, TX" },
    equipmentTypes: ["barbell", "dumbbell", "cable", "machine", "bench"],
    equipmentIds: [
      "olympic_barbell",
      "weight_plates",
      "power_rack",
      "adjustable_bench",
      "dumbbells",
      "cable_station",
    ],
    equipmentItems: [
      {
        id: "olympic_barbell",
        type: "barbell",
        variant: "olympic_barbell",
        weightSystem: "bar",
        weightStackKg: 20,
        incrementKg: 2.5,
        count: 2,
      },
      {
        id: "dumbbells",
        type: "dumbbell",
        variant: "fixed_dumbbells",
        weightSystem: "free_weight",
        minWeightKg: 2.5,
        maxWeightKg: 45,
        incrementKg: 2.5,
        count: 1,
      },
      {
        id: "cable_station",
        type: "cable",
        variant: "dual_crossover_cable",
        weightSystem: "weight_stack",
        weightStackKg: 90,
        incrementKg: 5,
        count: 1,
      },
    ],
    exerciseSelectionMode: "equipment_based",
    isActive: true,
    createdAt: isoDaysAgo(90).toISOString(),
  });
}

async function seedProgram(context: SeedContext): Promise<void> {
  await putWorkouts(context, "/programs/reviewer-3mo-program", {
    name: "3-Month Strength Review Plan",
    description: "Seeded reviewer program with upper/lower strength sessions.",
    type: "mesocycle",
    startDate: isoDaysAgo(84).toISOString(),
    durationWeeks: 12,
    isActive: true,
    deloadWeekNumbers: [4, 8],
    deloadPercent: 0.4,
    schedule: [
      {
        dayOfWeek: 1,
        name: "Upper Strength",
        exercises: [
          programExercise("barbell_bench_press", 0, 82.5, 8),
          programExercise("cable_lat_pulldown", 1, 72.5, 10),
          programExercise("dumbbell_shoulder_press", 2, 24, 10),
        ],
      },
      {
        dayOfWeek: 3,
        name: "Lower Strength",
        exercises: [
          programExercise("barbell_back_squat", 0, 115, 6),
          programExercise("barbell_romanian_deadlift", 1, 105, 8),
          programExercise("dumbbell_lunges", 2, 22, 10),
        ],
      },
    ],
    schemaVersion: 1,
    createdAt: isoDaysAgo(90).toISOString(),
  });
}

async function seedSessions(context: SeedContext): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    const session = buildSession(index, context.userId);
    await putWorkouts(context, `/sessions/${session.id as string}`, session);
  }
}

async function seedConversation(context: SeedContext): Promise<void> {
  const entries = [
    {
      weekIso: "2026-W18",
      summary:
        "Bench and squat volume were consistent. The user reported solid energy and no pain.",
      retainedFacts: [
        "Prefers upper/lower strength training.",
        "Bench press responds well to 8-10 rep work.",
        "Keep shoulder fatigue monitored after pressing days.",
      ],
      createdAt: isoDaysAgo(28).toISOString(),
    },
    {
      weekIso: "2026-W20",
      summary:
        "Strength block is underway. Squat and Romanian deadlift loads moved up without missed reps.",
      retainedFacts: [
        "Current phase is strength.",
        "Go-easier was not needed in the last two logged sessions.",
      ],
      createdAt: isoDaysAgo(14).toISOString(),
    },
  ];
  await putWorkouts(context, "/conversation-rolling-summary", {
    entries,
    updatedAt: new Date().toISOString(),
  });
}

async function seedAiAuditLog(context: SeedContext): Promise<void> {
  const existing = await request<ListResponse<AiAuditLogItem>>(
    WORKOUTS_API_BASE_URL,
    "/ai-audit-log?surface=sunday_review&limit=10",
    { token: context.token },
  );
  if (existing.items.length > 0) return;

  await request(WORKOUTS_API_BASE_URL, "/ai-audit-log", {
    method: "POST",
    token: context.token,
    body: JSON.stringify({
      surface: "sunday_review",
      modelTier: "flash",
      snapshotRef: "reviewer-seed-2026-05",
      action: "user_applied",
      persisted: true,
      sourceRef: {
        kind: "reviewer_seed",
        sessionWindow: "12 weeks",
      },
      snapshotInline: {
        completedSessions: 12,
        activeProgram: "3-Month Strength Review Plan",
        highlights: ["bench consistency", "squat progression", "lower soreness managed"],
      },
      aiOutput: {
        headline: "Strength block is moving",
        body:
          "Bench volume stayed consistent while squat and hinge work progressed without missed reps.",
      },
      diff: {
        conversationSummaryUpdated: true,
      },
    }),
  });
}

async function grantRevenueCatEntitlement(context: SeedContext): Promise<boolean> {
  const apiKey = process.env.REVENUECAT_REST_API_KEY;
  if (!apiKey?.trim()) {
    console.warn("REVENUECAT_REST_API_KEY not set; skipped RevenueCat promotional grant.");
    return false;
  }
  const expiresAt = new Date();
  expiresAt.setUTCMonth(expiresAt.getUTCMonth() + 3);
  const subscriberUrl = `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(
    context.userId,
  )}`;
  const subscriberResponse = await fetch(subscriberUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });
  if (!subscriberResponse.ok && subscriberResponse.status !== 201) {
    const body = await subscriberResponse.text();
    throw new Error(
      `RevenueCat subscriber lookup failed: HTTP ${subscriberResponse.status} ${body}`,
    );
  }
  const response = await fetch(
    `${subscriberUrl}/entitlements/${encodeURIComponent(ENTITLEMENT_ID)}/promotional`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        start_time_ms: Date.now(),
        end_time_ms: expiresAt.getTime(),
      }),
    },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`RevenueCat promotional grant failed: HTTP ${response.status} ${body}`);
  }
  return true;
}

async function main(): Promise<void> {
  const context = await login();
  await seedProfile(context);
  await seedGym(context);
  await seedProgram(context);
  await seedSessions(context);
  await seedConversation(context);
  await seedAiAuditLog(context);
  const revenueCatGranted = await grantRevenueCatEntitlement(context);

  console.log(
    JSON.stringify(
      {
        ok: true,
        userId: context.userId,
        identityTokenExpiresAt: context.expiresAt,
        seeded: {
          profile: true,
          gyms: 1,
          activePrograms: 1,
          completedSessions: 12,
          conversationRollingSummary: true,
          aiAuditLog: true,
          revenueCatPromotionalEntitlement: revenueCatGranted,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
