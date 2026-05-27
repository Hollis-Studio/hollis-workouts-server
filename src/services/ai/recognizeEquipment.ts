/**
 * @ai-context AI service — recognize gym equipment from a base64 photo.
 *
 * Ports functions/src/equipmentRecognition/recognizeEquipment.ts.
 * Model: Gemini Flash (multimodal image input).
 *
 * Entitlement gating and free-use counting are handled in the route layer
 * (src/routes/ai/recognizeEquipment.ts). This service performs the pure AI
 * call and returns the structured result — it has no side-effects on usage.
 *
 * deps: lib/gemini, lib/logger | consumers: src/routes/ai/recognizeEquipment.ts
 */

import { z } from "zod";
import type { Result } from "@hollis-studio/contracts";
import { ok, err } from "@hollis-studio/contracts";
import { getGeminiClient, getGeminiFlashModel, getGeminiThinkingConfig } from "../../lib/gemini.js";
import { recordTokenUsage } from "./tokenUsage.js";
import { logger } from "../../lib/logger.js";

// ── Response schema (mirrors functions/src/schemas/ai/equipment.ts) ────────────

const RecognizeEquipmentResponseSchema = z.object({
  equipmentType: z.string(),
  suggestedExerciseName: z.string(),
  confidence: z.number().min(0).max(1),
  clarifyingQuestions: z.array(z.string()),
});

export type RecognizeEquipmentResult = z.infer<typeof RecognizeEquipmentResponseSchema>;

// ── Prompts (ported from functions/src/prompts/recognizeEquipment.ts) ─────────

const CANONICAL_EQUIPMENT_TYPES = [
  "barbell", "dumbbell", "kettlebell", "cable", "machine", "bodyweight",
  "resistance_band", "squat_rack", "bench", "pull_up_bar", "plate_loaded_machine",
  "smith_machine", "treadmill", "stationary_bike", "rowing_machine", "elliptical",
  "stairmaster", "jump_rope", "none", "other",
] as const;

const RECOGNIZE_EQUIPMENT_SYSTEM = `You are a gym equipment identification assistant. Identify the primary piece of gym equipment in the photo and suggest the exercise the user intends to log.

## Equipment type — use ONLY one of these exact strings
${CANONICAL_EQUIPMENT_TYPES.join(", ")}
DO NOT invent equipment types not in this list. If the equipment is unusual, use the closest match or "other". (Reason: values are validated against the canonical enum; unknown strings fail downstream.)

## Exercise name
Return stable, movement-based exercise names suited for progress tracking (e.g. "Seated Cable Row", "Lat Pulldown", "Bench Press"). Prefer common movement names over brand names, machine nicknames, or overly specific phrasing. When the user's description is provided, use it as the primary signal for which exercise they intend — do not override a clear description with a generic guess.

## Confidence and ambiguity
- Single piece of equipment clearly visible, lighting adequate → confidence ≥ 0.8; clarifyingQuestions: []
- Equipment visible but type is ambiguous → confidence 0.4–0.7; include 1–2 specific clarifying questions
- Equipment barely visible, multiple pieces in frame, or image very blurry → confidence < 0.4; ask the user to retake
- No gym equipment visible → equipmentType: "none", confidence: 0, suggestedExerciseName: "", clarifyingQuestions: ["No equipment detected. Please retake the photo with the equipment centered in the frame."]

## Response format
Return ONLY valid JSON — no prose, no markdown:
{
  "equipmentType": "<one of the canonical strings above>",
  "suggestedExerciseName": "<movement name or empty string>",
  "confidence": <number 0.0–1.0>,
  "clarifyingQuestions": ["<question>"]
}`;

function buildUserPrompt(userDescription?: string): string {
  const trimmedDescription = userDescription?.trim();
  const base = "Identify the gym equipment in this photo and suggest an exercise.";
  if (!trimmedDescription) return base;
  return `${base}\n\nThe user described the movement as: "${trimmedDescription}".\n\nUse that description to disambiguate which exercise they intend to log.`;
}

// ── Service function ──────────────────────────────────────────────────────────

export async function recognizeEquipment(
  userId: string,
  imageBase64: string,
  userDescription?: string,
): Promise<Result<RecognizeEquipmentResult>> {
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
            { text: buildUserPrompt(userDescription) },
            { inlineData: { mimeType: "image/jpeg", data: imageBase64 } },
          ],
        },
      ],
      config: {
        thinkingConfig: getGeminiThinkingConfig(),
        systemInstruction: RECOGNIZE_EQUIPMENT_SYSTEM,
        responseMimeType: "application/json",
      },
    });
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error), component: "recognizeEquipment" },
      "Gemini call failed",
    );
    return err("INTERNAL_ERROR", "AI service is temporarily unavailable. Please try again.");
  }

  void recordTokenUsage({
    userId,
    feature: "smart_reader",
    model,
    usageMetadata: response.usageMetadata,
  });

  const text = response.text ?? "";
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    logger.error({ raw: text.slice(0, 500), component: "recognizeEquipment" }, "AI returned invalid JSON");
    return err("INTERNAL_ERROR", "AI returned an unexpected response. Please try again.");
  }

  const validated = RecognizeEquipmentResponseSchema.safeParse(json);
  if (!validated.success) {
    logger.error(
      { error: validated.error.flatten(), raw: text.slice(0, 500), component: "recognizeEquipment" },
      "AI response failed validation",
    );
    return err("INTERNAL_ERROR", "AI returned a malformed response. Please try again.");
  }

  return ok(validated.data);
}
