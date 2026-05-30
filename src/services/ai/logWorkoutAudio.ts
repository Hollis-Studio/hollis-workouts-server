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

// ── Per-operation Zod schemas (V2 operations[] shape) ─────────────────────────

// Flat set shape used inside add_exercise.sets
const VoiceOpSetSchema = z.object({
  weightKg: z.number().min(0).max(1000).optional(),
  reps: z.number().int().min(0).max(200).optional(),
  rir: z.number().int().min(0).max(10).optional(),
  durationSeconds: z.number().int().min(1).max(3600).optional(),
  distanceKm: z.number().min(0).max(1000).optional(),
});

// Flat "raw" operation shape as Gemini emits it (no discriminated union yet)
const VoiceLogOperationRawSchema = z.object({
  op: z.enum([
    "log_set",
    "modify_set",
    "delete_set",
    "skip_set",
    "set_rest",
    "set_active_exercise",
    "add_exercise",
  ]),
  exerciseIndex: z.number().int().min(0).optional(),
  setIndex: z.number().int().min(0).optional(),
  weightKg: z.number().min(0).max(1000).optional(),
  reps: z.number().int().min(0).max(200).optional(),
  rir: z.number().int().min(0).max(10).optional(),
  durationSeconds: z.number().int().min(1).max(3600).optional(),
  distanceKm: z.number().min(0).max(1000).optional(),
  restAfterSec: z.number().int().min(0).max(3600).nullable().optional(),
  exerciseName: z.string().min(1).optional(),
  trackingMode: z.enum(["reps", "timed", "cardio", "stretch"]).optional(),
  insertAfterIndex: z.number().int().min(0).nullable().optional(),
  sets: z.array(VoiceOpSetSchema).optional(),
  confidence: z.number().min(0).max(1),
  explanation: z.string().optional(),
});

// superRefine: enforce per-op required fields after Gemini flattens everything
const VoiceLogOperationSchema = VoiceLogOperationRawSchema.superRefine((op, ctx) => {
  // Operations that require exerciseIndex
  const needsExerciseIndex = new Set([
    "log_set",
    "modify_set",
    "delete_set",
    "skip_set",
    "set_rest",
    "set_active_exercise",
  ]);
  if (needsExerciseIndex.has(op.op) && op.exerciseIndex === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${op.op} requires exerciseIndex`,
      path: ["exerciseIndex"],
    });
  }

  // Operations that require setIndex
  const needsSetIndex = new Set(["modify_set", "delete_set", "skip_set", "set_rest"]);
  if (needsSetIndex.has(op.op) && op.setIndex === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${op.op} requires setIndex`,
      path: ["setIndex"],
    });
  }

  // set_rest requires restAfterSec
  if (op.op === "set_rest" && op.restAfterSec === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "set_rest requires restAfterSec",
      path: ["restAfterSec"],
    });
  }

  // add_exercise requires exerciseName and trackingMode
  if (op.op === "add_exercise") {
    if (!op.exerciseName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "add_exercise requires exerciseName",
        path: ["exerciseName"],
      });
    }
    if (!op.trackingMode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "add_exercise requires trackingMode",
        path: ["trackingMode"],
      });
    }
  }
});

export type VoiceLogOperation = z.infer<typeof VoiceLogOperationSchema>;

const VoiceWorkoutLogResponseSchema = z.object({
  summary: z.string().min(1),
  transcript: z.string().min(1),
  operations: z.array(VoiceLogOperationSchema).max(50),
  unmatched: z.array(z.string()).max(20),
});

// ── Legacy V1 schema (entries[]) — served to clients that do NOT send
// protocolVersion: 2 (i.e. app builds shipped before the operations[] refactor).
// Kept verbatim from the pre-refactor contract so existing installs keep working. ──

const VoiceWorkoutLogV1SetSchema = z.object({
  setIndex: z.number().int().min(0).optional(),
  weightKg: z.number().min(0).max(1000).optional(),
  reps: z.number().int().min(0).max(200).optional(),
  rir: z.number().int().min(0).max(10).optional(),
  durationSeconds: z.number().int().min(1).max(3600).optional(),
  restAfterSec: z.number().int().min(0).max(3600).nullable().optional(),
});

const VoiceWorkoutLogV1EntrySchema = z.object({
  exerciseIndex: z.number().int().min(0),
  exerciseName: z.string().min(1),
  confidence: z.number().min(0).max(1),
  sets: z.array(VoiceWorkoutLogV1SetSchema).min(1).max(20),
});

const VoiceWorkoutLogV1ResponseSchema = z.object({
  summary: z.string().min(1),
  transcript: z.string().min(1),
  entries: z.array(VoiceWorkoutLogV1EntrySchema).max(20),
  unmatched: z.array(z.string()).max(20),
});

export type LogWorkoutAudioResultV2 = z.infer<typeof VoiceWorkoutLogResponseSchema>;
export type LogWorkoutAudioResultV1 = z.infer<typeof VoiceWorkoutLogV1ResponseSchema>;
export type LogWorkoutAudioResult = LogWorkoutAudioResultV2 | LogWorkoutAudioResultV1;

// ── Input types ────────────────────────────────────────────────────────────────

interface LoggedSetContext {
  setIndex: number;
  weightKg: number | null;
  reps: number | null;
  rir: number | null;
  durationSeconds: number | null;
  isConfirmed: boolean;
  isWarmup: boolean;
}

interface ExerciseContext {
  exerciseIndex: number;
  exerciseName: string;
  canonicalExerciseId: string | null;
  trackingMode: "reps" | "timed" | "cardio" | "stretch";
  targetSetCount: number;
  isActive?: boolean;
  loggedSets?: LoggedSetContext[];
}

interface LogWorkoutAudioParams {
  userId: string;
  audioBase64: string;
  mimeType: "audio/m4a" | "audio/mp4" | "audio/wav" | "audio/webm";
  defaultWeightUnit: "kg" | "lbs";
  hideRirControls?: boolean;
  /** When 2, return the operations[] response; otherwise the legacy entries[] response. */
  protocolVersion?: 2;
  exercises: ExerciseContext[];
}

// ── Structured response schema (Type enum from @google/genai) ─────────────────
// Gemini's responseSchema does NOT support discriminated unions, so each operation
// is a single flat OBJECT with all possible fields. Per-op constraints are enforced
// post-generation by VoiceLogOperationSchema.superRefine above.

const VOICE_WORKOUT_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING },
    transcript: { type: Type.STRING },
    operations: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          op: {
            type: Type.STRING,
            enum: [
              "log_set",
              "modify_set",
              "delete_set",
              "skip_set",
              "set_rest",
              "set_active_exercise",
              "add_exercise",
            ],
          },
          exerciseIndex: { type: Type.INTEGER },
          setIndex: { type: Type.INTEGER },
          weightKg: { type: Type.NUMBER },
          reps: { type: Type.INTEGER },
          rir: { type: Type.INTEGER },
          durationSeconds: { type: Type.INTEGER },
          distanceKm: { type: Type.NUMBER },
          restAfterSec: { type: Type.INTEGER, nullable: true },
          exerciseName: { type: Type.STRING },
          trackingMode: {
            type: Type.STRING,
            enum: ["reps", "timed", "cardio", "stretch"],
          },
          insertAfterIndex: { type: Type.INTEGER, nullable: true },
          sets: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                weightKg: { type: Type.NUMBER },
                reps: { type: Type.INTEGER },
                rir: { type: Type.INTEGER },
                durationSeconds: { type: Type.INTEGER },
                distanceKm: { type: Type.NUMBER },
              },
            },
          },
          confidence: { type: Type.NUMBER },
          explanation: { type: Type.STRING },
        },
        required: ["op", "confidence"],
      },
    },
    unmatched: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ["summary", "transcript", "operations", "unmatched"],
} as const;

// Legacy V1 Gemini schema (entries[]) — served to pre-refactor clients.
const VOICE_WORKOUT_V1_RESPONSE_SCHEMA = {
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

// ── Prompts ───────────────────────────────────────────────────────────────────

const WORKOUT_VOICE_SYSTEM = [
  "You are the voice-logging engine for Hollis Workouts. You convert a spoken workout log (audio) into an ordered list of structured OPERATIONS that mutate the user's live training session. You never chat; you only emit the operations JSON.",
  "",
  "## Core rules",
  "- Emit ONLY facts stated in the audio or unambiguously implied by the workout context. Never invent weights, reps, RIR, durations, distances, or exercises.",
  "- Every operation MUST reference a real exerciseIndex from the provided context, EXCEPT add_exercise, which names a new exercise to insert.",
  "- Output all weights in kilograms. Convert pounds to kg. If no unit is spoken, use defaultWeightUnit. Output distances in kilometers; convert miles.",
  "- Each operation carries a confidence in [0,1] and a short explanation.",
  "- If a phrase cannot be confidently mapped to an operation, add it to unmatched rather than guessing. Prefer unmatched over a low-confidence destructive op.",
  "",
  "## Choosing the right operation",
  "- log_set: a NEW result for a set that is not yet logged. Omit setIndex to append to the next open set; supply setIndex only if the user names a specific set (\"set three was...\").",
  "- modify_set: CORRECT or CHANGE a set that already has logged values (see loggedSets). \"Actually set two was nine reps\", \"make my last set 100 kilos\", \"bump the RIR on bench set one to 2\". ALWAYS prefer modify_set over log_set when the target set already has values. Only include fields that change.",
  "- delete_set / skip_set: \"delete my last set\", \"skip set four\".",
  "- set_rest: rest between sets (\"rested ninety seconds\", \"two minutes rest\").",
  "- set_active_exercise: pure navigation (\"move to squats\", \"next exercise\", \"done with bench\") with no new data.",
  "- add_exercise: the user introduces an exercise NOT in the context (\"add lateral raises, three sets of fifteen\"). Provide exerciseName, trackingMode, and any sets mentioned. Do NOT fabricate a canonicalExerciseId.",
  "",
  "## Targeting",
  "- Resolve spoken exercise names to the closest exerciseIndex in context. Use isActive to disambiguate bare references (\"that set\", \"another one\") — they refer to the active exercise.",
  "- setIndex is 0-based. \"Set one\" = setIndex 0. Warmups count as sets if present in loggedSets.",
  "- For reps exercises include weightKg, reps, and rir when known. If hideRirControls is true, do not solicit or infer RIR.",
  "- For timed exercises include durationSeconds. For cardio include durationSeconds and/or distanceKm. For stretch include durationSeconds.",
  "",
  "## Multiple commands in one recording",
  "- The audio may contain several actions in sequence. Emit one operation per action, IN SPOKEN ORDER. A later modify_set may correct an earlier log_set in the same response — keep both.",
  "",
  "## Output fields",
  "- summary: ONE factual sentence (~10 words) describing the net result. No praise, no emojis.",
  "- transcript: concise phrase-level words you heard, preserving exercises/weights/reps/RIR/durations.",
  "- operations: the ordered operation list (may be empty if nothing was actionable).",
  "- unmatched: any audio you could not confidently map.",
  "",
  "Return only the JSON object matching the provided response schema. The top-level array field MUST be operations. Never use aliases like sets, entries, or lifts.",
].join("\n");

function buildVoicePrompt(params: LogWorkoutAudioParams): string {
  return [
    "## Workout context (authoritative exercise list)",
    JSON.stringify(
      {
        defaultWeightUnit: params.defaultWeightUnit,
        hideRirControls: params.hideRirControls ?? false,
        exercises: params.exercises,
      },
      null,
      2,
    ),
    "",
    "## Task",
    "Transcribe the attached audio and emit an ordered operations[] list describing every action spoken.",
    "Each operation targets a real exerciseIndex from the context above (except add_exercise).",
    "Use isActive on each exercise to resolve bare references (\"that set\", \"another one\").",
    "Use loggedSets to determine whether a set already has values — prefer modify_set when it does.",
    "summary: one factual sentence (~10 words). No praise.",
  ].join("\n");
}

// ── Legacy V1 prompts (entries[]) — served to pre-refactor clients ─────────────

const WORKOUT_VOICE_V1_SYSTEM = [
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

function buildVoiceV1Prompt(params: LogWorkoutAudioParams): string {
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

// Shared Gemini call + JSON parse. The system prompt, task prompt, and response
// schema vary by protocol version; everything else (client/model resolution, token
// accounting, fence-stripping, error mapping) is identical.
async function callVoiceGemini(
  params: LogWorkoutAudioParams,
  systemInstruction: string,
  userPrompt: string,
  responseSchema: unknown,
): Promise<Result<unknown>> {
  const client = getGeminiClient();
  if (!client) {
    return err("INTERNAL_ERROR", "AI service is not configured (missing GOOGLE_CLOUD_PROJECT)");
  }

  const model = getGeminiFlashModel();

  let response: Awaited<ReturnType<typeof client.models.generateContent>>;
  try {
    response = await client.models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            { text: userPrompt },
            { inlineData: { mimeType: params.mimeType, data: params.audioBase64 } },
          ],
        },
      ],
      config: {
        thinkingConfig: getGeminiThinkingConfig(),
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema,
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

  try {
    return ok(parseJsonResponse(response.text ?? ""));
  } catch {
    logger.error(
      { raw: (response.text ?? "").slice(0, 500), component: "logWorkoutAudio" },
      "AI returned invalid JSON",
    );
    return err("INTERNAL_ERROR", "AI returned an unexpected response. Please try again.");
  }
}

// V2 (operations[]) — for clients that send protocolVersion: 2.
async function logWorkoutAudioV2(
  params: LogWorkoutAudioParams,
  validExerciseIndexes: Set<number>,
): Promise<Result<LogWorkoutAudioResultV2>> {
  const raw = await callVoiceGemini(
    params,
    WORKOUT_VOICE_SYSTEM,
    buildVoicePrompt(params),
    VOICE_WORKOUT_RESPONSE_SCHEMA,
  );
  if (!raw.ok) return raw;

  const validated = VoiceWorkoutLogResponseSchema.safeParse(raw.data);
  if (!validated.success) {
    logger.error(
      { error: validated.error.flatten(), component: "logWorkoutAudio" },
      "AI response failed validation",
    );
    return err("INTERNAL_ERROR", "AI response failed validation. Please try again.");
  }

  // Exercise index guard: all returned indexes (except add_exercise, which has none)
  // must match input indexes.
  const invalidIndexes = validated.data.operations
    .filter((op) => op.op !== "add_exercise" && op.exerciseIndex !== undefined)
    .map((op) => op.exerciseIndex as number)
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

// V1 (entries[]) — legacy shape for app builds shipped before the operations refactor.
async function logWorkoutAudioV1(
  params: LogWorkoutAudioParams,
  validExerciseIndexes: Set<number>,
): Promise<Result<LogWorkoutAudioResultV1>> {
  const raw = await callVoiceGemini(
    params,
    WORKOUT_VOICE_V1_SYSTEM,
    buildVoiceV1Prompt(params),
    VOICE_WORKOUT_V1_RESPONSE_SCHEMA,
  );
  if (!raw.ok) return raw;

  const validated = VoiceWorkoutLogV1ResponseSchema.safeParse(raw.data);
  if (!validated.success) {
    logger.error(
      { error: validated.error.flatten(), component: "logWorkoutAudio" },
      "AI response failed validation",
    );
    return err("INTERNAL_ERROR", "AI response failed validation. Please try again.");
  }

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

export async function logWorkoutAudio(
  params: LogWorkoutAudioParams,
): Promise<Result<LogWorkoutAudioResult>> {
  const validExerciseIndexes = new Set(params.exercises.map((e) => e.exerciseIndex));
  return params.protocolVersion === 2
    ? logWorkoutAudioV2(params, validExerciseIndexes)
    : logWorkoutAudioV1(params, validExerciseIndexes);
}
