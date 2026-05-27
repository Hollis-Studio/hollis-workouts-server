Loaded Prisma config from prisma.config.ts.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "gyms" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location" JSONB,
    "equipmentTypes" TEXT[],
    "equipmentIds" TEXT[],
    "equipmentItems" JSONB NOT NULL,
    "exerciseSelectionMode" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gyms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "programs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "durationWeeks" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL,
    "deloadWeekNumbers" INTEGER[],
    "deloadPercent" DOUBLE PRECISION NOT NULL,
    "schedule" JSONB NOT NULL,
    "schemaVersion" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "programs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "programId" TEXT,
    "programDayName" TEXT,
    "gymProfileId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isFreestyle" BOOLEAN NOT NULL,
    "isSubstitution" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL,
    "questionnaire" JSONB NOT NULL,
    "totalVolumeKg" DOUBLE PRECISION NOT NULL,
    "durationMinutes" DOUBLE PRECISION NOT NULL,
    "untrackedVolume" DOUBLE PRECISION,
    "aiOutlierLabel" TEXT,
    "schemaVersion" INTEGER,
    "programPhase" TEXT,
    "skippedExerciseIds" TEXT[],
    "exercises" JSONB NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "progression_baselines" (
    "userId" TEXT NOT NULL,
    "canonicalExerciseId" TEXT NOT NULL,
    "currentE1RM_Kg" DOUBLE PRECISION NOT NULL,
    "topSetWeightKg" DOUBLE PRECISION NOT NULL,
    "topSetReps" INTEGER NOT NULL,
    "topSetRIR" INTEGER NOT NULL,
    "lastUpdated" TIMESTAMP(3) NOT NULL,
    "history" JSONB NOT NULL,
    "phaseExitE1RM_Kg" DOUBLE PRECISION,
    "phaseExitDate" DOUBLE PRECISION,
    "classMix" JSONB,
    "trendE1RM_Kg" DOUBLE PRECISION,
    "trendTopSetWeightKg" DOUBLE PRECISION,
    "trendTopSetReps" INTEGER,
    "trendTopSetRIR" INTEGER,
    "missStreak" INTEGER,
    "autoDeloadPercent" DOUBLE PRECISION,
    "plateauDeloadUntil" TIMESTAMP(3),
    "plateauDeloadReductionPercent" DOUBLE PRECISION,
    "lastPlateauAlertedAt" TIMESTAMP(3),
    "schemaVersion" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "progression_baselines_pkey" PRIMARY KEY ("userId","canonicalExerciseId")
);

-- CreateTable
CREATE TABLE "cardio_baselines" (
    "userId" TEXT NOT NULL,
    "canonicalExerciseId" TEXT NOT NULL,
    "bestDurationSeconds" DOUBLE PRECISION NOT NULL,
    "bestDistanceKm" DOUBLE PRECISION,
    "bestPaceSecondsPerKm" DOUBLE PRECISION,
    "bestMETs" DOUBLE PRECISION,
    "lowestHRAtPace" INTEGER,
    "lastDurationSeconds" DOUBLE PRECISION NOT NULL,
    "lastDistanceKm" DOUBLE PRECISION,
    "lastAvgSpeedKmh" DOUBLE PRECISION,
    "lastPaceSecondsPerKm" DOUBLE PRECISION,
    "lastIncline" DOUBLE PRECISION,
    "lastResistance" DOUBLE PRECISION,
    "lastAvgHeartRate" INTEGER,
    "lastUpdated" TIMESTAMP(3) NOT NULL,
    "history" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cardio_baselines_pkey" PRIMARY KEY ("userId","canonicalExerciseId")
);

-- CreateTable
CREATE TABLE "gym_exercise_instances" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "gymProfileId" TEXT NOT NULL,
    "canonicalExerciseId" TEXT NOT NULL,
    "baseWeightKg" DOUBLE PRECISION,
    "weightUnit" TEXT NOT NULL,
    "weightMode" TEXT NOT NULL,
    "weightIncrementKg" DOUBLE PRECISION,
    "isActive" BOOLEAN NOT NULL,
    "notes" TEXT,
    "lastUsedWeightKg" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gym_exercise_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_exercises" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "subcategory" TEXT,
    "primaryMuscleGroups" TEXT[],
    "secondaryMuscleGroups" TEXT[],
    "equipmentType" TEXT NOT NULL,
    "requiredEquipment" TEXT[],
    "isBodyweight" BOOLEAN NOT NULL,
    "isUnilateral" BOOLEAN NOT NULL,
    "defaultRestTimerSec" INTEGER NOT NULL,
    "defaultWeightMode" TEXT NOT NULL,
    "illustrationUrl" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "minimumIncrementKg" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL,
    "trackingMode" TEXT,
    "isActive" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_exercises_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exercise_aliases" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "normalizedAlias" TEXT NOT NULL,
    "canonicalExerciseId" TEXT NOT NULL,
    "equipmentType" TEXT,
    "gymProfileId" TEXT,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exercise_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weeks" (
    "userId" TEXT NOT NULL,
    "weekIso" TEXT NOT NULL,
    "deterministicSnapshot" JSONB,
    "aiRetrospective" JSONB,
    "userAnnotations" JSONB,
    "conversationUpdatedAt" TIMESTAMP(3),
    "hasConversation" BOOLEAN,
    "lastConversationThreadId" TEXT,
    "createdAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "weeks_pkey" PRIMARY KEY ("userId","weekIso")
);

-- CreateTable
CREATE TABLE "ai_audit_log" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "surface" TEXT NOT NULL,
    "modelTier" TEXT NOT NULL,
    "snapshotRef" TEXT,
    "action" TEXT NOT NULL,
    "persisted" BOOLEAN NOT NULL,
    "sourceRef" JSONB NOT NULL,
    "snapshotInline" JSONB,
    "aiOutput" JSONB NOT NULL,
    "diff" JSONB,

    CONSTRAINT "ai_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "injury_records" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "muscleGroup" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "injury_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_rolling_summaries" (
    "userId" TEXT NOT NULL,
    "entries" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_rolling_summaries_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "metric_basket_snapshots" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "exerciseId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "captureKind" TEXT NOT NULL,
    "sourceSessionId" TEXT,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "metric_basket_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_profiles" (
    "userId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "email" TEXT,
    "fcmDeviceToken" TEXT,
    "lastFcmTokenUpdate" TIMESTAMP(3),
    "smartReaderFreeUsesRemaining" INTEGER,
    "lastReviewPromptAt" TIMESTAMP(3),
    "settings" JSONB NOT NULL,
    "entitlements" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "plateau_coaching_artifacts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "exerciseId" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL,
    "narrative" TEXT NOT NULL,
    "rootCauses" TEXT[],
    "recommendations" TEXT[],
    "dismissedAt" TIMESTAMP(3),
    "tokenCount" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plateau_coaching_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cancellation_feedback" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "option" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cancellation_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "smart_builder_drafts" (
    "userId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "smart_builder_drafts_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "ai_token_usage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "tokens" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_token_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exercise_embedding_cache" (
    "id" TEXT NOT NULL,
    "canonicalExerciseId" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "sourceTextHash" TEXT NOT NULL,
    "embedding" DOUBLE PRECISION[],
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exercise_embedding_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canonical_exercises" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "subcategory" TEXT,
    "primaryMuscleGroups" TEXT[],
    "secondaryMuscleGroups" TEXT[],
    "equipmentType" TEXT NOT NULL,
    "requiredEquipment" TEXT[],
    "isBodyweight" BOOLEAN NOT NULL,
    "isUnilateral" BOOLEAN NOT NULL,
    "defaultRestTimerSec" INTEGER NOT NULL,
    "defaultWeightMode" TEXT NOT NULL,
    "illustrationUrl" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "minimumIncrementKg" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL,
    "trackingMode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "canonical_exercises_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gyms_userId_idx" ON "gyms"("userId");

-- CreateIndex
CREATE INDEX "gyms_userId_isActive_idx" ON "gyms"("userId", "isActive");

-- CreateIndex
CREATE INDEX "programs_userId_idx" ON "programs"("userId");

-- CreateIndex
CREATE INDEX "programs_userId_isActive_idx" ON "programs"("userId", "isActive");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "sessions_userId_completedAt_idx" ON "sessions"("userId", "completedAt");

-- CreateIndex
CREATE INDEX "sessions_userId_status_idx" ON "sessions"("userId", "status");

-- CreateIndex
CREATE INDEX "sessions_userId_startedAt_idx" ON "sessions"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "sessions_userId_updatedAt_idx" ON "sessions"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "progression_baselines_userId_idx" ON "progression_baselines"("userId");

-- CreateIndex
CREATE INDEX "progression_baselines_userId_lastUpdated_idx" ON "progression_baselines"("userId", "lastUpdated");

-- CreateIndex
CREATE INDEX "cardio_baselines_userId_idx" ON "cardio_baselines"("userId");

-- CreateIndex
CREATE INDEX "cardio_baselines_userId_lastUpdated_idx" ON "cardio_baselines"("userId", "lastUpdated");

-- CreateIndex
CREATE INDEX "gym_exercise_instances_userId_idx" ON "gym_exercise_instances"("userId");

-- CreateIndex
CREATE INDEX "gym_exercise_instances_userId_gymProfileId_idx" ON "gym_exercise_instances"("userId", "gymProfileId");

-- CreateIndex
CREATE INDEX "gym_exercise_instances_userId_canonicalExerciseId_idx" ON "gym_exercise_instances"("userId", "canonicalExerciseId");

-- CreateIndex
CREATE INDEX "gym_exercise_instances_userId_createdAt_idx" ON "gym_exercise_instances"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "user_exercises_userId_idx" ON "user_exercises"("userId");

-- CreateIndex
CREATE INDEX "user_exercises_userId_createdAt_idx" ON "user_exercises"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "exercise_aliases_userId_idx" ON "exercise_aliases"("userId");

-- CreateIndex
CREATE INDEX "exercise_aliases_userId_canonicalExerciseId_idx" ON "exercise_aliases"("userId", "canonicalExerciseId");

-- CreateIndex
CREATE INDEX "exercise_aliases_userId_normalizedAlias_idx" ON "exercise_aliases"("userId", "normalizedAlias");

-- CreateIndex
CREATE INDEX "exercise_aliases_userId_createdAt_idx" ON "exercise_aliases"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "weeks_userId_idx" ON "weeks"("userId");

-- CreateIndex
CREATE INDEX "ai_audit_log_userId_idx" ON "ai_audit_log"("userId");

-- CreateIndex
CREATE INDEX "ai_audit_log_userId_timestamp_idx" ON "ai_audit_log"("userId", "timestamp");

-- CreateIndex
CREATE INDEX "ai_audit_log_userId_surface_idx" ON "ai_audit_log"("userId", "surface");

-- CreateIndex
CREATE INDEX "injury_records_userId_idx" ON "injury_records"("userId");

-- CreateIndex
CREATE INDEX "injury_records_userId_isActive_idx" ON "injury_records"("userId", "isActive");

-- CreateIndex
CREATE INDEX "metric_basket_snapshots_userId_idx" ON "metric_basket_snapshots"("userId");

-- CreateIndex
CREATE INDEX "metric_basket_snapshots_userId_exerciseId_idx" ON "metric_basket_snapshots"("userId", "exerciseId");

-- CreateIndex
CREATE INDEX "metric_basket_snapshots_userId_sourceSessionId_idx" ON "metric_basket_snapshots"("userId", "sourceSessionId");

-- CreateIndex
CREATE INDEX "metric_basket_snapshots_userId_capturedAt_idx" ON "metric_basket_snapshots"("userId", "capturedAt");

-- CreateIndex
CREATE INDEX "metric_basket_snapshots_userId_createdAt_idx" ON "metric_basket_snapshots"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "plateau_coaching_artifacts_userId_idx" ON "plateau_coaching_artifacts"("userId");

-- CreateIndex
CREATE INDEX "plateau_coaching_artifacts_userId_exerciseId_idx" ON "plateau_coaching_artifacts"("userId", "exerciseId");

-- CreateIndex
CREATE INDEX "plateau_coaching_artifacts_userId_detectedAt_idx" ON "plateau_coaching_artifacts"("userId", "detectedAt");

-- CreateIndex
CREATE INDEX "cancellation_feedback_userId_idx" ON "cancellation_feedback"("userId");

-- CreateIndex
CREATE INDEX "cancellation_feedback_userId_createdAt_idx" ON "cancellation_feedback"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_token_usage_userId_idx" ON "ai_token_usage"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_token_usage_userId_month_key" ON "ai_token_usage"("userId", "month");

-- CreateIndex
CREATE UNIQUE INDEX "exercise_embedding_cache_canonicalExerciseId_modelVersion_key" ON "exercise_embedding_cache"("canonicalExerciseId", "modelVersion");

-- CreateIndex
CREATE INDEX "canonical_exercises_equipmentType_idx" ON "canonical_exercises"("equipmentType");

-- CreateIndex
CREATE INDEX "canonical_exercises_category_idx" ON "canonical_exercises"("category");

-- CreateIndex
CREATE INDEX "canonical_exercises_isActive_idx" ON "canonical_exercises"("isActive");

