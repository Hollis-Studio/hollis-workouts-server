/**
 * @ai-context AI service — transcribe and parse spoken workout logs from audio.
 *
 * Ports functions/src/workoutVoice/logWorkoutAudio.ts.
 * Model: Gemini Flash, multimodal audio input + structured responseSchema.
 * Entitlement: hollisIntelligence required (applied at route level).
 *
 * Critical guards ported from the Cloud Function:
 *   - VOICE_WORKOUT_RESPONSE_SCHEMA: structured output schema (Type.OBJECT)
 *     constrains the response format to prevent hallucinated shapes.
 *   - exerciseIndex validation: all returned indexes must match input indexes.
 *   - Markdown fence stripping before JSON.parse (Gemini occasionally wraps JSON
 *     in ```json...``` even with responseMimeType: "application/json").
 *
 * NOTE: The route applies express.json({ limit: "20mb" }) locally — the default
 * 100 KB global limit would reject real audio blobs.
 *
 * deps: lib/gemini, lib/logger | consumers: src/routes/ai/logWorkoutAudio.ts
 */

import { z } from "zod";
import { Type } from "@google/genai";
import type { Result } from "@hollis-studio/contracts";
import { ok, err } from "@hollis-studio/contracts";
import {
  getGeminiClient,
  getGeminiFlashModel,
  getGeminiThinkingConfig,
} from "../../lib/gemini.js";
import { recordTokenUsage } from "./tokenUsage.js";
import { logger } from "../../lib/logger.js";

// ── Response schema (mirrors functions/src/schemas/ai/workoutVoice.ts) ─────────

const VoiceWorkoutLogSetSchema = z.object({
  setIndex: z.number().int().min(0).optional(),
  weightKg: z.number().min(0).max(1000).optional(),
  reps: z.number().int().min(0).max(200).optional(),
  rir: z.number().int().min(0).max(10).optional(),
  durationSeconds: z.number().int().min(1).max(3600).optional(),
  restAfterSec: z.number().int().min(0).max(3600).nullable().optional(),
});

const VoiceWorkoutLogEntrySchema = z.object({
  exerciseIndex: z.number().int().min(0),
  exerciseName: z.string().min(1),
  confidence: z.number().min(0).max(1),
  sets: z.array(VoiceWorkoutLogSetSchema).min(1).max(20),
});

const VoiceWorkoutLogResponseSchema = z.object({
  summary: z.string().min(1),
  transcript: z.string().min(1),
  entries: z.array(VoiceWorkoutLogEntrySchema).max(20),
  unmatched: z.array(z.string()).max(20),
});

export type LogWorkoutAudioResult = z.infer<typeof VoiceWorkoutLogResponseSchema>;

// ── Input types ────────────────────────────────────────────────────────────────

interface ExerciseContext {
  exerciseIndex: number;
  exerciseName: string;
  canonicalExerciseId: string | null;
  trackingMode: "reps" | "timed" | "cardio" | "stretch";
  targetSetCount: number;
}

interface LogWorkoutAudioParams {
  userId: string;
  audioBase64: string;
  mimeType: "audio/m4a" | "audio/mp4" | "audio/wav" | "audio/webm";
  defaultWeightUnit: "kg" | "lbs";
  exercises: ExerciseContext[];
}

// ── Structured response schema (Type enum from @google/genai) ─────────────────
// This must exactly match the Cloud Function's VOICE_WORKOUT_RESPONSE_SCHEMA.

const VOICE_WORKOUT_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING },
    transcript: { type: Type.STRING },
    entries: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          exerciseIndex: { type: Type.INTEGER },
          exerciseName: { type: Type.STRING },
          confidence: { type: Type.NUMBER },
          sets: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                setIndex: { type: Type.INTEGER },
                weightKg: { type: Type.NUMBER },
                reps: { type: Type.INTEGER },
                rir: { type: Type.INTEGER },
                durationSeconds: { type: Type.INTEGER },
                restAfterSec: { type: Type.INTEGER, nullable: true },
              },
            },
          },
        },
        required: ["exerciseIndex", "exerciseName", "confidence", "sets"],
      },
    },
    unmatched: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ["summary", "transcript", "entries", "unmatched"],
} as const;

// ── Prompts (ported from functions/src/prompts/workoutVoice.ts) ────────────────

const WORKOUT_VOICE_SYSTEM = [
  "You convert spoken workout logs into structured JSON for Hollis Workouts.",
  "Return only facts present in the audio or safely implied by the current exercise context.",
  "Map each logged lift to one of the provided exerciseIndex values. Do not invent exercises not in the context.",
  "Do not invent weights, reps, RIR, or durations not stated in the audio.",
  "Output all weights in kilograms. If the speaker says pounds, convert to kilograms.",
  "If the speaker omits units, use the defaultWeightUnit from context.",
  "For reps exercises, include weightKg, reps, and rir when known or clearly implied.",
  "For timed exercises, include durationSeconds. Include weightKg/reps/rir only if the audio clearly states them.",
  "The top-level array field MUST be entries. Never return lifts, exercisesLogged, parsedSets, or any other alias.",
  "If a spoken phrase cannot be mapped with the provided context, put it in unmatched instead of guessing.",
  "summary: ONE factual sentence (~10 words) stating what was logged. No praise. No emojis.",
  "transcript: the concise phrase-level words you heard, preserving exercises, weights, reps, RIR, and durations.",
  "unmatched: any audio content you could not map to an exercise.",
].join("\n");

function buildVoicePrompt(params: LogWorkoutAudioParams): string {
  return [
    "## Workout context (authoritative exercise list)",
    JSON.stringify({ defaultWeightUnit: params.defaultWeightUnit, exercises: params.exercises }, null, 2),
    "",
    "## Task",
    "Transcribe the attached audio and extract lifting results as structured JSON.",
    "Only map to exerciseIndex values listed above — do not invent exercises.",
    "For timed sets, return durationSeconds per set. For reps sets, return weightKg and reps.",
    "summary: one factual sentence (~10 words). No praise.",
  ].join("\n");
}

// ── JSON parse with markdown fence stripping ──────────────────────────────────

function parseJsonResponse(text: string): unknown {
  const stripped = text
    .replace(/^```(?:json)?\n?/i, "")
    .replace(/\n?```$/i, "")
    .trim();

  return JSON.parse(stripped);
}

// ── Service function ──────────────────────────────────────────────────────────

export async function logWorkoutAudio(
  params: LogWorkoutAudioParams,
): Promise<Result<LogWorkoutAudioResult>> {
  const client = getGeminiClient();
  if (!client) {
    return err("INTERNAL_ERROR", "AI service is not configured (missing GOOGLE_CLOUD_PROJECT)");
  }

  const model = getGeminiFlashModel();
  const validExerciseIndexes = new Set(params.exercises.map((e) => e.exerciseIndex));

  let response: Awaited<ReturnType<typeof client.models.generateContent>>;
  try {
    response = await client.models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            { text: buildVoicePrompt(params) },
            { inlineData: { mimeType: params.mimeType, data: params.audioBase64 } },
          ],
        },
      ],
      config: {
        thinkingConfig: getGeminiThinkingConfig(),
        systemInstruction: WORKOUT_VOICE_SYSTEM,
        responseMimeType: "application/json",
        responseSchema: VOICE_WORKOUT_RESPONSE_SCHEMA,
      },
    });
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error), component: "logWorkoutAudio" },
      "Gemini call failed",
    );
    return err("INTERNAL_ERROR", "AI service is temporarily unavailable. Please try again.");
  }

  void recordTokenUsage({
    userId: params.userId,
    feature: "workout_voice",
    model,
    usageMetadata: response.usageMetadata,
  });

  let json: unknown;
  try {
    json = parseJsonResponse(response.text ?? "");
  } catch {
    logger.error(
      { raw: (response.text ?? "").slice(0, 500), component: "logWorkoutAudio" },
      "AI returned invalid JSON",
    );
    return err("INTERNAL_ERROR", "AI returned an unexpected response. Please try again.");
  }

  const validated = VoiceWorkoutLogResponseSchema.safeParse(json);
  if (!validated.success) {
    logger.error(
      { error: validated.error.flatten(), component: "logWorkoutAudio" },
      "AI response failed validation",
    );
    return err("INTERNAL_ERROR", "AI response failed validation. Please try again.");
  }

  // Exercise index guard: all returned indexes must match input indexes.
  const invalidIndexes = validated.data.entries
    .map((entry) => entry.exerciseIndex)
    .filter((idx) => !validExerciseIndexes.has(idx));

  if (invalidIndexes.length > 0) {
    logger.error(
      { invalidIndexes, component: "logWorkoutAudio" },
      "AI returned unknown exercise indexes",
    );
    return err("INTERNAL_ERROR", "AI returned unknown exercise indexes. Please try again.");
  }

  return ok(validated.data);
}
