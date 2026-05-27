/**
 * @ai-context AI service — tag exercises with canonical muscle groups.
 *
 * Ports functions/src/exerciseTagging/tagExerciseMuscles.ts.
 * Model: Gemini Flash, JSON mode.
 * Entitlement: none (all authenticated users). Admin/dev pipeline use.
 *
 * deps: lib/gemini, lib/logger | consumers: src/routes/ai/tagExerciseMuscles.ts
 */

import { z } from "zod";
import type { Result } from "@hollis-studio/contracts";
import { ok, err } from "@hollis-studio/contracts";
import { getGeminiClient, getGeminiFlashModel, getGeminiThinkingConfig } from "../../lib/gemini.js";
import { logger } from "../../lib/logger.js";

// ── Response schema ────────────────────────────────────────────────────────────

const TagExerciseMusclesResponseSchema = z.object({
  tags: z.array(
    z.object({
      name: z.string(),
      muscleGroups: z.array(z.string()),
    }),
  ),
});

export type TagExerciseMusclesResult = z.infer<typeof TagExerciseMusclesResponseSchema>;

// ── Prompts (ported from functions/src/prompts/tagExerciseMuscles.ts) ─────────

const CANONICAL_MUSCLE_GROUPS = [
  "chest", "back", "shoulders", "biceps", "triceps", "forearms",
  "quadriceps", "hamstrings", "glutes", "calves", "core", "traps",
  "lats", "anterior_deltoids", "lateral_deltoids", "posterior_deltoids",
  "hip_flexors", "adductors", "abductors", "neck", "obliques",
  "lower_back", "upper_back",
] as const;

const TAG_EXERCISES_SYSTEM = `You are a strength training exercise classifier for an admin pipeline. Tag each exercise with its primary muscle groups.

## Valid muscle group values — use ONLY these exact strings
${CANONICAL_MUSCLE_GROUPS.join(", ")}
DO NOT use values not in this list.

## Tagging rules
- Return 1–4 muscle groups per exercise. Fewer is better — include only primary movers.
- Prefer specific over generic: "lats" not "back"; "anterior_deltoids" not "shoulders".
- Compound exercises include all primary movers (e.g. squat → quadriceps, glutes, hamstrings).
- For unknown exercises, use your best judgment — never return an empty muscleGroups array.
- Respond ONLY with valid JSON — no prose, no markdown.

## Examples
"Bench Press" → ["chest", "anterior_deltoids", "triceps"]
"Romanian Deadlift" → ["hamstrings", "glutes", "lower_back"]
"Pull-up" → ["lats", "biceps"]
"Overhead Press" → ["anterior_deltoids", "lateral_deltoids", "triceps"]
"Back Squat" → ["quadriceps", "glutes", "hamstrings"]`;

function buildPrompt(exerciseNames: string[]): string {
  const list = exerciseNames.map((n, i) => `${i + 1}. "${n.replace(/"/g, '\\"')}"`).join("\n");
  return `Classify each of the following exercise names. Return a JSON object with this exact shape:
{ "tags": [{ "name": "<name as given>", "muscleGroups": ["group1", "group2"] }] }

Exercise names to classify:
${list}`;
}

// ── Service function ──────────────────────────────────────────────────────────

export async function tagExerciseMuscles(
  exerciseNames: string[],
): Promise<Result<TagExerciseMusclesResult>> {
  const client = getGeminiClient();
  if (!client) {
    return err("INTERNAL_ERROR", "AI service is not configured (missing GOOGLE_CLOUD_PROJECT)");
  }

  const model = getGeminiFlashModel();

  let response: Awaited<ReturnType<typeof client.models.generateContent>>;
  try {
    response = await client.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: buildPrompt(exerciseNames) }] }],
      config: {
        thinkingConfig: getGeminiThinkingConfig(),
        systemInstruction: TAG_EXERCISES_SYSTEM,
        responseMimeType: "application/json",
      },
    });
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error), component: "tagExerciseMuscles" },
      "Gemini call failed",
    );
    return err("INTERNAL_ERROR", "AI service is temporarily unavailable. Please try again.");
  }

  const text = response.text ?? "";
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    logger.error({ raw: text.slice(0, 500), component: "tagExerciseMuscles" }, "AI returned invalid JSON");
    return err("INTERNAL_ERROR", "AI returned an unexpected response. Please try again.");
  }

  const validated = TagExerciseMusclesResponseSchema.safeParse(json);
  if (!validated.success) {
    logger.error(
      { error: validated.error.flatten(), raw: text.slice(0, 500), component: "tagExerciseMuscles" },
      "AI response failed validation",
    );
    return err("INTERNAL_ERROR", "AI returned a malformed response. Please try again.");
  }

  return ok(validated.data);
}
