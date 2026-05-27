/**
 * @ai-context Shared Zod request/response schemas for the AI REST routes.
 *
 * These mirror the Cloud Function input shapes from the app's
 * src/types/api.ts and functions/src/schemas/ai.ts — kept co-located
 * here so each route file stays slim.
 *
 * NOTE: @google/genai is NOT yet installed in this server (Wave 2 task).
 * Route stubs import only these schemas and return 501 NOT_IMPLEMENTED.
 *
 * deps: zod | consumers: src/routes/ai/*
 */

import { z } from "zod";

// ── recognizeEquipment ──────────────────────────────────────────────────────

export const RecognizeEquipmentBodySchema = z.object({
  imageBase64: z.string().min(1),
  userDescription: z.string().optional(),
});

// ── matchExercises ───────────────────────────────────────────────────────────

const ExerciseSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  category: z.string().min(1),
  primaryMuscleGroups: z.array(z.string()),
  equipmentType: z.string(),
});

export const MatchExercisesBodySchema = z.object({
  freestyleNames: z.array(z.string().min(1)).min(1),
  availableExercises: z.array(ExerciseSummarySchema),
});

// ── exerciseSearchSemanticScores ─────────────────────────────────────────────

export const ExerciseSearchSemanticScoresBodySchema = z.object({
  query: z.string().trim().min(1).max(200),
  exercises: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        searchText: z.string().min(1).max(2000).optional(),
      }),
    )
    .min(1)
    .max(150),
});

// ── logWorkoutAudio ──────────────────────────────────────────────────────────

export const LogWorkoutAudioBodySchema = z.object({
  audioBase64: z.string().min(1),
  mimeType: z.enum(["audio/m4a", "audio/mp4", "audio/wav", "audio/webm"]),
  defaultWeightUnit: z.enum(["kg", "lbs"]),
  exercises: z.array(
    z.object({
      exerciseIndex: z.number().int().min(0),
      exerciseName: z.string().min(1),
      canonicalExerciseId: z.string().nullable(),
      trackingMode: z.enum(["reps", "timed", "cardio", "stretch"]),
      targetSetCount: z.number().int().min(1),
    }),
  ),
});

// ── generateProgram ──────────────────────────────────────────────────────────

export const GenerateProgramBodySchema = z.object({
  description: z.string().min(1),
  availableExercises: z.array(ExerciseSummarySchema),
  preferences: z
    .object({
      durationWeeks: z.number().int().positive().optional(),
      daysPerWeek: z.number().int().min(1).max(7).optional(),
    })
    .optional(),
  userContext: z
    .object({
      programType: z.string().optional(),
      goal: z.string().optional(),
      baselines: z
        .array(
          z.object({
            exerciseId: z.string().min(1),
            exerciseName: z.string().min(1),
            currentE1RM_Kg: z.number().positive(),
          }),
        )
        .optional(),
    })
    .optional(),
});

// ── smartBuilderChat ─────────────────────────────────────────────────────────

const ConversationMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

export const SmartBuilderChatBodySchema = z.object({
  action: z.enum(["converse", "generate", "refine"]),
  conversationHistory: z.array(ConversationMessageSchema),
  userContext: z.record(z.string(), z.unknown()),
  currentProgram: z.record(z.string(), z.unknown()).optional(),
});

// ── gymSetupChat ─────────────────────────────────────────────────────────────

export const GymSetupChatBodySchema = z.object({
  conversationHistory: z.array(ConversationMessageSchema),
  currentEquipment: z.array(z.record(z.string(), z.unknown())),
  gymName: z.string().optional(),
});

// ── tagExerciseMuscles ───────────────────────────────────────────────────────

export const TagExerciseMusclesBodySchema = z.object({
  exerciseNames: z.array(z.string().min(1)).min(1),
});
