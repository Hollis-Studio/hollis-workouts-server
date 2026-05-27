/**
 * @ai-context AI service — match freestyle exercise names to canonical exercise IDs.
 *
 * Ports functions/src/exerciseMatching/matchExercises.ts.
 * Model: Gemini Flash, JSON mode.
 * Entitlement: hollisIntelligence required (applied at route level).
 *
 * deps: lib/gemini, lib/logger | consumers: src/routes/ai/matchExercises.ts
 */

import { z } from "zod";
import type { Result } from "@hollis-studio/contracts";
import { ok, err } from "@hollis-studio/contracts";
import { getGeminiClient, getGeminiFlashModel, getGeminiThinkingConfig } from "../../lib/gemini.js";
import { logger } from "../../lib/logger.js";

// ── Response schema ────────────────────────────────────────────────────────────

const MatchExercisesResponseSchema = z.object({
  matches: z.array(
    z.object({
      freestyleName: z.string(),
      canonicalExerciseId: z.string().nullable(),
      confidence: z.number().min(0).max(1),
      suggestedCategory: z.string().nullable(),
      suggestedMuscleGroups: z.array(z.string()),
      suggestedEquipmentType: z.string().nullable(),
    }),
  ),
});

export type MatchExercisesResult = z.infer<typeof MatchExercisesResponseSchema>;

// ── Prompts (ported from functions/src/prompts/matchExercises.ts) ─────────────

const MATCH_EXERCISES_SYSTEM =
  "You are an exercise name deduplication engine for a strength training app. " +
  "Match user-typed exercise names to canonical exercises from the provided candidate list. " +
  "ONLY return IDs that appear in the candidate list — never invent or guess an ID not supplied. " +
  "If no candidate is a good match, set canonicalExerciseId to null. " +
  "Consider common abbreviations, alternate names, and misspellings (e.g. \"bench\" → \"Bench Press\", \"lat pull\" → \"Lat Pulldown\"). " +
  "Respond ONLY with valid JSON matching the requested schema — no prose, no markdown.";

interface ExerciseSummary {
  id: string;
  name: string;
  category: string;
  primaryMuscleGroups: string[];
  equipmentType: string;
}

function buildPrompt(freestyleNames: string[], availableExercises: ExerciseSummary[]): string {
  const exerciseList = availableExercises
    .map(
      (e) =>
        `- ID: "${e.id}" | Name: "${e.name}" | Category: ${e.category} | Muscles: ${e.primaryMuscleGroups.join(", ")} | Equipment: ${e.equipmentType}`,
    )
    .join("\n");

  return `## Freestyle exercise names to match
${freestyleNames.map((n, i) => `${i + 1}. "${n}"`).join("\n")}

## Canonical exercise candidates (ONLY match to IDs from this list)
${exerciseList}

## Instructions
For each freestyle name, find the best match from the candidate list above.
- Match found (confidence ≥ 0.6): set canonicalExerciseId to the EXACT ID from the list above. DO NOT invent or modify IDs.
- No good match (confidence < 0.6): set canonicalExerciseId to null; populate suggestedCategory, suggestedMuscleGroups, and suggestedEquipmentType to assist creating a new exercise.
- Return one result per freestyle name, in the same order as the input list.

## Required response shape — valid JSON only
{
  "matches": [
    {
      "freestyleName": "<name as given>",
      "canonicalExerciseId": "<exact ID from candidate list, or null>",
      "confidence": <number 0.0–1.0>,
      "suggestedCategory": "<string or null>",
      "suggestedMuscleGroups": ["<muscle group>"],
      "suggestedEquipmentType": "<string or null>"
    }
  ]
}`;
}

// ── Service function ──────────────────────────────────────────────────────────

export async function matchExercises(
  freestyleNames: string[],
  availableExercises: ExerciseSummary[],
): Promise<Result<MatchExercisesResult>> {
  const client = getGeminiClient();
  if (!client) {
    return err("INTERNAL_ERROR", "AI service is not configured (missing GOOGLE_CLOUD_PROJECT)");
  }

  const model = getGeminiFlashModel();
  const prompt = buildPrompt(freestyleNames, availableExercises);

  let response: Awaited<ReturnType<typeof client.models.generateContent>>;
  try {
    response = await client.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        thinkingConfig: getGeminiThinkingConfig(),
        systemInstruction: MATCH_EXERCISES_SYSTEM,
        responseMimeType: "application/json",
      },
    });
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error), component: "matchExercises" },
      "Gemini call failed",
    );
    return err("INTERNAL_ERROR", "AI service is temporarily unavailable. Please try again.");
  }

  const text = response.text ?? "";
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    logger.error({ raw: text.slice(0, 500), component: "matchExercises" }, "AI returned invalid JSON");
    return err("INTERNAL_ERROR", "AI returned an unexpected response. Please try again.");
  }

  const validated = MatchExercisesResponseSchema.safeParse(json);
  if (!validated.success) {
    logger.error(
      { error: validated.error.flatten(), raw: text.slice(0, 500), component: "matchExercises" },
      "AI response failed validation",
    );
    return err("INTERNAL_ERROR", "AI returned a malformed response. Please try again.");
  }

  return ok(validated.data);
}
