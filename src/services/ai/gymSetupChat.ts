/**
 * @ai-context AI service — gym setup wizard conversation step.
 *
 * Ports functions/src/gymSetup/gymSetupChat.ts.
 * Model: Gemini Pro, JSON mode.
 * Entitlement: hollisIntelligence required (applied at route level).
 * Stateless: full conversation history + equipment list sent each request.
 * Returns a discriminated union: questions | confirm | update.
 *
 * deps: lib/gemini, lib/logger | consumers: src/routes/ai/gymSetupChat.ts
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

// ── Response schema (mirrors functions/src/schemas/ai/gymSetup.ts) ─────────────

const GymSetupEquipmentResultSchema = z.object({
  type: z.string().min(1),
  variant: z.string().optional(),
  weightStackKg: z.number().min(0).optional(),
  incrementKg: z.number().min(0).optional(),
  count: z.number().int().min(1).default(1),
  notes: z.string().optional(),
});

const GymSetupQuestionSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  type: z.enum(["chips", "slider", "toggle", "text", "multi_chips"]),
  options: z.array(z.string()).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
  placeholder: z.string().optional(),
});

const GymSetupQuestionGroupSchema = z.object({
  topic: z.string(),
  questions: z.array(GymSetupQuestionSchema).min(1),
});

export const GymSetupResponseSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("questions"),
    message: z.string().optional(),
    groups: z.array(GymSetupQuestionGroupSchema).min(1),
  }),
  z.object({
    type: z.literal("confirm"),
    message: z.string(),
    equipment: z.array(GymSetupEquipmentResultSchema),
  }),
  z.object({
    type: z.literal("update"),
    message: z.string().optional(),
    equipment: z.array(GymSetupEquipmentResultSchema),
    groups: z.array(GymSetupQuestionGroupSchema).optional(),
  }),
]);

export type GymSetupChatResult = z.infer<typeof GymSetupResponseSchema>;

// ── Input types ────────────────────────────────────────────────────────────────

type ConversationMessage = { role: "user" | "assistant"; content: string };
type EquipmentItem = Record<string, unknown>;

interface GymSetupChatParams {
  userId: string;
  conversationHistory: ConversationMessage[];
  currentEquipment: EquipmentItem[];
  gymName?: string;
}

// ── Prompts (ported from functions/src/prompts/gymSetupChat.ts) ────────────────

const GYM_SETUP_CHAT_EQUIPMENT_TYPES = [
  "barbell", "dumbbell", "kettlebell", "cable", "machine", "bodyweight",
  "resistance_band", "squat_rack", "bench", "pull_up_bar", "plate_loaded_machine",
  "smith_machine", "treadmill", "stationary_bike", "rowing_machine", "elliptical",
  "stairmaster", "jump_rope", "other",
] as const;

const GYM_SETUP_CHAT_EQUIPMENT_VARIANTS = [
  "standard_barbell", "olympic_barbell", "ez_curl_bar", "trap_bar", "safety_squat_bar",
  "fixed_dumbbells", "adjustable_dumbbells", "single_stack_cable", "dual_crossover_cable",
  "functional_trainer", "leg_press", "hack_squat", "chest_press_machine",
  "lat_pulldown_machine", "seated_row_machine", "leg_extension_machine", "leg_curl_machine",
  "pec_deck", "smith_machine_standard", "flat_treadmill", "incline_treadmill",
  "upright_bike", "recumbent_bike", "spin_bike", "concept2_rower", "standard_elliptical",
  "standard_kettlebell", "competition_kettlebell", "loop_band", "tube_band",
  "standard_stairmaster", "stepper", "speed_rope", "weighted_rope", "power_rack",
  "squat_stand", "pull_up_bar", "dip_station", "flat_bench", "adjustable_bench",
  "decline_bench", "preacher_curl_bench", "ghd", "other_variant",
] as const;

const GYM_SETUP_SYSTEM = `You are a gym equipment cataloger. Build a complete, accurate equipment profile through structured conversation.

## Your approach
1. Start by asking what TYPE of gym (commercial, home, garage, hotel, university, CrossFit box).
2. Work through equipment ONE CATEGORY at a time: free weights → machines → cardio → accessories.
3. For confirmed equipment, ask follow-up specifics: variant/model, weight stack or max weight (kg), increment (kg), count.
4. Keep "message" fields to 1–2 sentences. No affirmations ("Great!", "Perfect!") — just the next question or confirmation.
5. When the user says they're done or you've covered all categories, respond with type "confirm".
6. DO NOT promise or include equipment the user has not confirmed.

## Response format — ONLY valid JSON, no prose outside the object
### "questions" — ask the user about a category
{ "type": "questions", "message": "<optional 1-2 sentence context>", "groups": [...] }
### "update" — record confirmed equipment, optionally ask more
{ "type": "update", "message": "<1-2 sentences>", "equipment": [...], "groups": [...] }
### "confirm" — present the final list for user approval
{ "type": "confirm", "message": "<1-sentence summary>", "equipment": [...] }

## Equipment types — use ONLY these exact strings in the "type" field
${GYM_SETUP_CHAT_EQUIPMENT_TYPES.join(", ")}

## Equipment variants — use ONLY these exact strings in the "variant" field (omit if unknown)
${GYM_SETUP_CHAT_EQUIPMENT_VARIANTS.join(", ")}

## Rules
- All weights in kg.
- "count" is required and must be an integer ≥ 1.
- Do not ask about equipment already in the current profile.`;

function renderHistory(history: ConversationMessage[]): string {
  if (!history.length) return "(no prior conversation)";
  return history.map((m) => `[${m.role.toUpperCase()}]: ${m.content}`).join("\n\n");
}

function renderCurrentEquipment(equipment: EquipmentItem[]): string {
  if (!equipment.length) return "(none yet — start from scratch)";
  return equipment
    .map((e) => {
      const type = typeof e["type"] === "string" ? e["type"] : "unknown";
      const variant = typeof e["variant"] === "string" ? ` (${e["variant"]})` : "";
      const stack = typeof e["weightStackKg"] === "number" ? `, ${e["weightStackKg"]}kg stack` : "";
      const inc = typeof e["incrementKg"] === "number" ? `, ${e["incrementKg"]}kg increments` : "";
      const count = typeof e["count"] === "number" ? e["count"] : 1;
      return `- ${type}${variant}${stack}${inc} × ${count}`;
    })
    .join("\n");
}

function buildUserPrompt(params: GymSetupChatParams): string {
  return `=== CURRENT EQUIPMENT PROFILE ===
${renderCurrentEquipment(params.currentEquipment)}

=== GYM NAME ===
${params.gymName ?? "(not set yet)"}

=== CONVERSATION HISTORY ===
${renderHistory(params.conversationHistory)}

Based on the conversation so far and the current equipment list, continue helping the user build their gym equipment profile. Respond with the appropriate JSON shape.`;
}

// ── Service function ──────────────────────────────────────────────────────────

export async function gymSetupChat(
  params: GymSetupChatParams,
): Promise<Result<GymSetupChatResult>> {
  const client = getGeminiClient();
  if (!client) {
    return err("INTERNAL_ERROR", "AI service is not configured (missing GOOGLE_CLOUD_PROJECT)");
  }

  const model = getGeminiProModel();
  const userPrompt = buildUserPrompt(params);

  let response: Awaited<ReturnType<typeof client.models.generateContent>>;
  try {
    response = await client.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      config: {
        thinkingConfig: getGeminiThinkingConfig(),
        systemInstruction: GYM_SETUP_SYSTEM,
        responseMimeType: "application/json",
      },
    });
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error), component: "gymSetupChat" },
      "Gemini call failed",
    );
    return err("INTERNAL_ERROR", "AI service is temporarily unavailable. Please try again.");
  }

  void recordTokenUsage({
    userId: params.userId,
    feature: "gym_setup_chat",
    model,
    usageMetadata: response.usageMetadata,
  });

  const text = response.text ?? "";
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    logger.error({ raw: text.slice(0, 500), component: "gymSetupChat" }, "AI returned invalid JSON");
    return err("INTERNAL_ERROR", "The AI returned an unexpected response. Please try again.");
  }

  const validated = GymSetupResponseSchema.safeParse(json);
  if (!validated.success) {
    logger.error(
      { error: validated.error.flatten(), raw: text.slice(0, 500), component: "gymSetupChat" },
      "AI response failed schema validation",
    );
    return err("INTERNAL_ERROR", "The AI returned a malformed response. Please try again.");
  }

  return ok(validated.data);
}
