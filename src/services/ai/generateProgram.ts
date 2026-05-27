/**
 * @ai-context AI service — generate a training program from a description.
 *
 * Ports functions/src/programGeneration/generateProgram.ts.
 * Model: Gemini Pro, JSON mode.
 * Entitlement: hollisIntelligence required (applied at route level).
 * Includes server-side hallucination guard: all canonicalExerciseId values
 * in the response must exist in the input availableExercises list.
 *
 * deps: lib/gemini, lib/logger | consumers: src/routes/ai/generateProgram.ts
 */

import { z } from "zod";
import type { Result } from "@hollis-studio/contracts";
import { ok, err } from "@hollis-studio/contracts";
import {
  getGeminiClient,
  getGeminiProModel,
  getGeminiThinkingConfig,
} from "../../lib/gemini.js";
import { recordTokenUsage } from "./tokenUsage.js";
import { logger } from "../../lib/logger.js";

// ── Response schema (mirrors functions/src/schemas/ai/programGeneration.ts) ───

const GenerateProgramExerciseSchema = z.object({
  canonicalExerciseId: z.string(),
  sets: z.number().int().min(1).max(10),
  reps: z.number().int().min(1).max(100),
  rir: z.number().int().min(0).max(5),
  progressionMode: z.enum(["weight_first", "reps_first"]),
  goalMode: z.enum(["progress", "maintain", "track_only"]).optional(),
  priorityLevel: z.enum(["primary", "secondary", "supporting"]).optional(),
});

const GenerateProgramDaySchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  name: z.string(),
  exercises: z.array(GenerateProgramExerciseSchema),
});

const GenerateProgramResponseSchema = z.object({
  name: z.string(),
  description: z.string(),
  type: z.enum(["linear", "undulating", "block", "custom"]),
  durationWeeks: z.number().int().min(1),
  deloadWeekNumbers: z.array(z.number().int()),
  deloadPercent: z.number().min(0).max(1),
  schedule: z.array(GenerateProgramDaySchema),
});

export type GenerateProgramResult = z.infer<typeof GenerateProgramResponseSchema>;

// ── Input types ────────────────────────────────────────────────────────────────

interface ExerciseSummary {
  id: string;
  name: string;
  category: string;
  primaryMuscleGroups: string[];
  equipmentType: string;
}

interface GenerateProgramParams {
  userId: string;
  description: string;
  availableExercises: ExerciseSummary[];
  preferences?: { durationWeeks?: number; daysPerWeek?: number };
  userContext?: {
    programType?: string;
    goal?: string;
    baselines?: { exerciseId: string; exerciseName: string; currentE1RM_Kg: number }[];
  };
}

// ── Prompts (ported from functions/src/prompts/generateProgram.ts) ─────────────

const GENERATE_PROGRAM_SYSTEM =
  "You are a direct, data-driven strength and conditioning coach designing a training program. " +
  "Calibrate volume and intensity to the lifter's current strength levels when baselines are provided. " +
  "Use ONLY exercise IDs from the provided list — never invent IDs. (IDs are validated server-side; invented IDs cause a hard error.) " +
  "Do not produce motivational filler. One sentence of genuine rationale in \"description\" is enough. " +
  "Respond ONLY with valid JSON matching the requested schema. No text outside the JSON object.";

function buildPrompt(
  description: string,
  availableExercises: ExerciseSummary[],
  preferences?: { durationWeeks?: number; daysPerWeek?: number },
  userContext?: {
    programType?: string;
    goal?: string;
    baselines?: { exerciseId: string; exerciseName: string; currentE1RM_Kg: number }[];
  },
): string {
  const exerciseList = availableExercises
    .map(
      (e) =>
        `- ID: "${e.id}" | "${e.name}" | ${e.category} | ${e.primaryMuscleGroups.join(", ")} | ${e.equipmentType}`,
    )
    .join("\n");

  const durationHint = preferences?.durationWeeks
    ? `Duration: ${preferences.durationWeeks} weeks`
    : "Duration: choose an appropriate duration (typically 8-12 weeks for a first block)";

  const daysHint = preferences?.daysPerWeek
    ? `Training days per week: ${preferences.daysPerWeek}`
    : "Training days per week: infer from the user description; default to 4 if unclear";

  const goalHint = userContext?.goal
    ? `Training goal: ${userContext.goal} — let this drive exercise selection, volume, and intensity`
    : "Training goal: infer from the user description";

  const programTypeHint = userContext?.programType
    ? `Periodization structure: ${userContext.programType} (explicit preference)`
    : "Periodization structure: choose the best fit for the stated goal";

  let baselinesSection = "";
  if (userContext?.baselines && userContext.baselines.length > 0) {
    const baselineLines = userContext.baselines
      .sort((a, b) => b.currentE1RM_Kg - a.currentE1RM_Kg)
      .slice(0, 15)
      .map((b) => `- "${b.exerciseName}" (${b.exerciseId}): E1RM ${b.currentE1RM_Kg.toFixed(1)}kg`)
      .join("\n");
    baselinesSection =
      `\n## User's current strength baselines (Wathan gated E1RM, kg):\n${baselineLines}\n\n` +
      "Use these baselines to calibrate starting loads and select exercises the user already trains. " +
      "Do not invent weights or baselines beyond what is listed here.";
  }

  return `## User request:
"${description}"

## Constraints:
- ${durationHint}
- ${daysHint}
- ${goalHint}
- ${programTypeHint}
- 3-6 exercises per training day.
- Sets 2-5, reps 1-20, RIR 0-4 — match the stated goal and inferred experience level.
- Include deload weeks (every 4-6 weeks) if the program is longer than 6 weeks; put them in deloadWeekNumbers[].
- Avoid 3+ consecutive training days where possible.
- Use ONLY exercise IDs from the list below. Do NOT invent exercise IDs.
${baselinesSection}

## Available exercises (use these IDs ONLY — never invent):
${exerciseList}

## Required JSON response schema:
{
  "name": "Program name (max 60 chars)",
  "description": "2-3 sentences: training style, goal alignment, periodization approach.",
  "type": "linear" | "undulating" | "block" | "custom",
  "durationWeeks": number,
  "deloadWeekNumbers": [week numbers],
  "deloadPercent": 0.0-1.0,
  "schedule": [
    {
      "dayOfWeek": 0-6 (0=Sunday),
      "name": "Day name",
      "exercises": [
        {
          "canonicalExerciseId": "exact ID from list above",
          "sets": number,
          "reps": number,
          "rir": number,
          "progressionMode": "weight_first" | "reps_first"
        }
      ]
    }
  ]
}

Output ONLY valid JSON. No text outside the JSON object.`;
}

// ── Service function ──────────────────────────────────────────────────────────

export async function generateProgram(
  params: GenerateProgramParams,
): Promise<Result<GenerateProgramResult>> {
  const { userId, description, availableExercises, preferences, userContext } = params;

  const client = getGeminiClient();
  if (!client) {
    return err("INTERNAL_ERROR", "AI service is not configured (missing GOOGLE_CLOUD_PROJECT)");
  }

  const model = getGeminiProModel();
  const prompt = buildPrompt(description, availableExercises, preferences, userContext);

  let response: Awaited<ReturnType<typeof client.models.generateContent>>;
  try {
    response = await client.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        thinkingConfig: getGeminiThinkingConfig(),
        systemInstruction: GENERATE_PROGRAM_SYSTEM,
        responseMimeType: "application/json",
      },
    });
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error), component: "generateProgram" },
      "Gemini call failed",
    );
    return err("INTERNAL_ERROR", "AI service is temporarily unavailable. Please try again.");
  }

  void recordTokenUsage({
    userId,
    feature: "generate_program",
    model,
    usageMetadata: response.usageMetadata,
  });

  const text = response.text ?? "";
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    logger.error({ raw: text.slice(0, 500), component: "generateProgram" }, "AI returned invalid JSON");
    return err("INTERNAL_ERROR", "AI returned an unexpected response. Please try again.");
  }

  const validated = GenerateProgramResponseSchema.safeParse(json);
  if (!validated.success) {
    logger.error(
      { error: validated.error.flatten(), raw: text.slice(0, 500), component: "generateProgram" },
      "AI response failed schema validation",
    );
    return err("INTERNAL_ERROR", "AI returned a malformed response. Please try again.");
  }

  // Server-side hallucination guard: all canonicalExerciseId values must exist
  // in the input list. Invented IDs would create broken program references.
  const validIds = new Set(availableExercises.map((e) => e.id));
  for (const day of validated.data.schedule) {
    for (const exercise of day.exercises) {
      if (!validIds.has(exercise.canonicalExerciseId)) {
        logger.error(
          {
            invalidId: exercise.canonicalExerciseId,
            component: "generateProgram",
          },
          "AI referenced unknown exercise ID",
        );
        return err(
          "INTERNAL_ERROR",
          `AI referenced unknown exercise ID: ${exercise.canonicalExerciseId}`,
        );
      }
    }
  }

  return ok(validated.data);
}
