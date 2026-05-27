/**
 * @ai-context AI service — Smart Program Builder multi-turn conversation.
 *
 * Ports functions/src/programBuilder/smartBuilderChat.ts.
 * Model: Gemini Pro, JSON mode.
 * Entitlement: hollisIntelligence required (applied at route level).
 *
 * Three action modes: converse | generate | refine.
 * Retry loop (up to 2 retries) on hallucinated exercise IDs and type mismatches.
 * SlotId uniqueness guard on 'program' responses.
 *
 * HALLUCINATION_EXHAUSTED error contract:
 *   When retries are exhausted, the route returns HTTP 422 with body:
 *   { ok: false, err: { code: "HALLUCINATION_EXHAUSTED", message: "...", details: { invalidIds: string[] } } }
 *   The client app's services/ai.ts reads message.includes("HALLUCINATION_EXHAUSTED") and
 *   details.invalidIds — this shape is intentionally preserved.
 *
 * deps: lib/gemini, lib/logger | consumers: src/routes/ai/smartBuilderChat.ts
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

// ── Response schema (mirrors functions/src/schemas/ai/smartBuilder.ts) ─────────

const AIQuestionSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  type: z.enum(["chips", "slider", "toggle", "text"]),
  options: z.array(z.string()).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
  placeholder: z.string().optional(),
  multiline: z.boolean().optional(),
});

const AIQuestionGroupSchema = z.object({
  topic: z.string(),
  questions: z.array(AIQuestionSchema).min(1),
});

const LiftingSlottedExerciseSchema = z.object({
  slotId: z.string().min(1),
  canonicalExerciseId: z.string(),
  exerciseType: z.literal("lifting"),
  sets: z.number().int().min(1).max(10),
  reps: z.number().int().min(1).max(100),
  rir: z.number().int().min(0).max(5),
  progressionMode: z.enum(["weight_first", "reps_first"]),
  goalMode: z.enum(["progress", "maintain", "track_only"]).optional(),
  priorityLevel: z.enum(["primary", "secondary", "supporting"]).optional(),
});

const TimedSlottedExerciseSchema = z.object({
  slotId: z.string().min(1),
  canonicalExerciseId: z.string(),
  exerciseType: z.literal("timed"),
  sets: z.number().int().min(1).max(10),
  durationSeconds: z.number().int().min(5).max(600),
  progressionMode: z.literal("duration_first"),
  goalMode: z.enum(["progress", "maintain", "track_only"]).optional(),
  priorityLevel: z.enum(["primary", "secondary", "supporting"]).optional(),
});

const CardioSlottedExerciseSchema = z.object({
  slotId: z.string().min(1),
  canonicalExerciseId: z.string(),
  exerciseType: z.literal("cardio"),
  durationSeconds: z.number().int().min(60).nullable(),
  targetDistanceKm: z.number().min(0).nullable(),
  targetSpeedKmh: z.number().min(0).nullable(),
  goalMode: z.enum(["progress", "maintain", "track_only"]).optional(),
  priorityLevel: z.enum(["primary", "secondary", "supporting"]).optional(),
});

const SlottedExercisePreprocess = z.preprocess(
  (val: unknown) => {
    if (val && typeof val === "object" && !("exerciseType" in val)) {
      return { ...val, exerciseType: "lifting" };
    }
    return val;
  },
  z.discriminatedUnion("exerciseType", [
    LiftingSlottedExerciseSchema,
    TimedSlottedExerciseSchema,
    CardioSlottedExerciseSchema,
  ]),
);

const SlottedDaySchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  name: z.string(),
  exercises: z.array(SlottedExercisePreprocess),
});

const SlottedProgramSchema = z.object({
  name: z.string(),
  description: z.string(),
  type: z.enum(["linear", "undulating", "block", "custom"]),
  durationWeeks: z.number().int().min(1).max(52),
  deloadWeekNumbers: z.array(z.number().int()).optional(),
  deloadPercent: z.number().min(0).max(1).optional(),
  schedule: z.array(SlottedDaySchema),
});

const ProgramEditSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("replace_exercise"), slotId: z.string(), newExerciseId: z.string() }),
  z.object({
    op: z.literal("update_sets"),
    slotId: z.string(),
    sets: z.number().int().min(1).max(10).optional(),
    reps: z.number().int().min(1).max(100).optional(),
    rir: z.number().int().min(0).max(5).optional(),
    durationSeconds: z.number().int().min(5).max(600).optional(),
    progressionMode: z.enum(["weight_first", "reps_first", "duration_first"]).optional(),
  }),
  z.object({ op: z.literal("remove_exercise"), slotId: z.string() }),
  z.object({
    op: z.literal("add_exercise"),
    dayOfWeek: z.number().int().min(0).max(6),
    newSlotId: z.string(),
    canonicalExerciseId: z.string(),
    exerciseType: z.enum(["lifting", "timed", "cardio"]).default("lifting"),
    sets: z.number().int().min(1).max(10).optional(),
    reps: z.number().int().min(1).max(100).optional(),
    rir: z.number().int().min(0).max(5).optional(),
    durationSeconds: z.number().int().min(5).optional(),
    targetDistanceKm: z.number().min(0).optional(),
    targetSpeedKmh: z.number().min(0).optional(),
    progressionMode: z.enum(["weight_first", "reps_first", "duration_first"]).optional(),
  }),
  z.object({
    op: z.literal("swap_days"),
    fromDayOfWeek: z.number().int().min(0).max(6),
    toDayOfWeek: z.number().int().min(0).max(6),
  }),
]);

const SmartBuilderResponseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("questions"), message: z.string().optional(), groups: z.array(AIQuestionGroupSchema).min(1) }),
  z.object({ type: z.literal("ready"), message: z.string() }),
  z.object({ type: z.literal("program"), message: z.string().optional(), program: SlottedProgramSchema }),
  z.object({ type: z.literal("edits"), edits: z.array(ProgramEditSchema), message: z.string() }),
]);

export type SmartBuilderChatResult = z.infer<typeof SmartBuilderResponseSchema>;

// ── Input types ────────────────────────────────────────────────────────────────

export const HALLUCINATION_EXHAUSTED = "HALLUCINATION_EXHAUSTED";

interface ExerciseInfo {
  id: string;
  name: string;
  category: string;
  subcategory?: string;
  primaryMuscleGroups: string[];
  secondaryMuscleGroups?: string[];
  equipmentType: string;
  isBodyweight?: boolean;
  isUnilateral?: boolean;
  trackingMode?: "reps" | "timed" | "cardio";
  requiredEquipment?: string[];
}

interface SmartBuilderChatParams {
  userId: string;
  action: "converse" | "generate" | "refine";
  conversationHistory: { role: "user" | "assistant"; content: string }[];
  userContext: {
    equipment: string[];
    exerciseSelectionMode?: "equipment_based" | "exercise";
    equipmentIds?: string[];
    gymExerciseConfigs: Record<string, unknown>[];
    injuries: { muscleGroup: string; description: string }[];
    e1rms: Record<string, number>;
    recentWorkouts: Record<string, unknown>[];
    exerciseLibrary: ExerciseInfo[];
    progressionRates?: Record<string, number>;
    recentReadiness?: { score: number; confidence: number };
  };
  currentProgram?: unknown;
}

// ── Prompt builders (imported logic from functions/src/prompts/smartBuilderChat.ts) ──

function renderHistory(history: { role: string; content: string }[]): string {
  if (!history.length) return "(no prior conversation)";
  return history.map((m) => `[${m.role.toUpperCase()}]: ${m.content}`).join("\n\n");
}

function renderExerciseIndex(library: ExerciseInfo[]): string {
  return library
    .map((e, i) => {
      const tracking = e.trackingMode ?? "reps";
      const requiresPart =
        e.requiredEquipment && e.requiredEquipment.length > 0
          ? ` | requires: ${e.requiredEquipment.join(", ")}`
          : "";
      return `  [E${i}] ${e.id} | ${e.name} | ${e.equipmentType} | ${e.primaryMuscleGroups.join(", ")} | ${String(tracking)}${requiresPart}`;
    })
    .join("\n");
}

// Imported verbatim from smartBuilderChat prompts (condensed)
const SMART_BUILDER_CONVERSE_SYSTEM = `You are a direct, opinionated strength training coach conducting an intake conversation. Terse and honest — not a cheerleader.
Ask targeted questions to fill the critical gaps. Batch related questions into topic groups. Skip what the data already answers.
## Response format — ALWAYS valid JSON:
While gathering info: { "type": "questions", "message": "...", "groups": [{ "topic": "...", "questions": [...] }] }
Once enough info is collected: { "type": "ready", "message": "Here is what I will build: [summary]. Tap Generate to continue." }
Output ONLY valid JSON. No text outside the JSON object.`;

const SMART_BUILDER_GENERATE_SYSTEM = `You are a direct, opinionated strength and conditioning coach generating a complete training program.
STRICT: Every canonicalExerciseId MUST be an exact ID from AVAILABLE EXERCISES. SlotIds format: "d{dayIndex}-e{exerciseIndex}". SlotIds must be unique across the entire program.
## Response format: { "type": "program", "message": "...", "program": { ... } }
Output ONLY valid JSON. No text outside the JSON object.`;

const SMART_BUILDER_REFINE_SYSTEM = `You are a direct strength training coach refining an existing training program. Apply SURGICAL edits — change only what is requested.
## Response format: { "type": "edits", "edits": [...], "message": "..." }
Output ONLY valid JSON. No text outside the JSON object.`;

function buildContextBlock(ctx: SmartBuilderChatParams["userContext"]): string {
  const isExerciseMode = ctx.exerciseSelectionMode === "exercise";
  const equipmentList =
    ctx.equipment.length > 0
      ? ctx.equipment.join(", ")
      : "not configured yet";
  const modeLabel = isExerciseMode
    ? "Exercise mode (user-curated exercise list)"
    : "Equipment-based mode";
  return `=== USER CONTEXT ===\nGym exercise selection mode: ${modeLabel}\n${!isExerciseMode ? `\nAvailable equipment: ${equipmentList}\n` : ""}Exercise library: ${ctx.exerciseLibrary.length} exercises available.`;
}

function buildConversePrompt(params: SmartBuilderChatParams): string {
  return `${buildContextBlock(params.userContext)}\n\n=== CONVERSATION HISTORY ===\n${renderHistory(params.conversationHistory)}`;
}

function buildGeneratePrompt(params: SmartBuilderChatParams): string {
  return `${buildContextBlock(params.userContext)}\n\n=== CONVERSATION HISTORY ===\n${renderHistory(params.conversationHistory)}\n\n=== AVAILABLE EXERCISES ===\nFormat: [code] id | name | equipment | primary muscles | trackingMode\nUse the exact "id" value in canonicalExerciseId fields, NOT the [E#] code.\n${renderExerciseIndex(params.userContext.exerciseLibrary)}\n\nGenerate the complete program JSON now.`;
}

function buildRefinePrompt(params: SmartBuilderChatParams): string {
  return `${buildContextBlock(params.userContext)}\n\n=== CONVERSATION HISTORY ===\n${renderHistory(params.conversationHistory)}\n\n=== CURRENT PROGRAM ===\n${JSON.stringify(params.currentProgram ?? null, null, 2)}\n\n=== AVAILABLE EXERCISES ===\n${renderExerciseIndex(params.userContext.exerciseLibrary)}\n\nApply the requested edits now.`;
}

function buildRetryPrompt(invalidIds: string[], library: ExerciseInfo[]): string {
  return `=== VALIDATION FAILED — RETRY REQUIRED ===\n\nYour previous response contained invalid exercise IDs that do not exist in the available exercise library:\n${invalidIds.map((id) => `  - "${id}" (NOT FOUND)`).join("\n")}\n\nYou MUST only use exercise IDs from the list below.\n\n=== VALID EXERCISES ===\n${renderExerciseIndex(library)}\n\nRe-generate your response using ONLY valid exercise IDs from the list above.`;
}

// ── Validation helpers (ported from prompts/smartBuilderChat.ts) ───────────────

type SmartBuilderData = z.infer<typeof SmartBuilderResponseSchema>;

function validateExerciseIds(
  validIds: Set<string>,
  response: SmartBuilderData,
): string[] {
  const invalidIds: string[] = [];

  if (response.type === "program") {
    for (const day of response.program.schedule) {
      for (const slot of day.exercises) {
        if (!validIds.has(slot.canonicalExerciseId)) {
          invalidIds.push(slot.canonicalExerciseId);
        }
      }
    }
  }

  if (response.type === "edits") {
    for (const edit of response.edits) {
      if (edit.op === "replace_exercise" && !validIds.has(edit.newExerciseId)) {
        invalidIds.push(edit.newExerciseId);
      }
      if (
        edit.op === "add_exercise" &&
        !validIds.has(edit.canonicalExerciseId)
      ) {
        invalidIds.push(edit.canonicalExerciseId);
      }
    }
  }

  return [...new Set(invalidIds)];
}

function expectedExerciseType(
  trackingMode: "reps" | "timed" | "cardio" | undefined,
): "lifting" | "timed" | "cardio" {
  if (trackingMode === "timed") return "timed";
  if (trackingMode === "cardio") return "cardio";
  return "lifting";
}

function validateExerciseTypes(
  library: ExerciseInfo[],
  response: SmartBuilderData,
): string[] {
  const byId = new Map(library.map((e) => [e.id, e]));
  const mismatches: string[] = [];

  if (response.type === "program") {
    for (const day of response.program.schedule) {
      for (const slot of day.exercises) {
        const exercise = byId.get(slot.canonicalExerciseId);
        if (!exercise) continue;
        const expected = expectedExerciseType(exercise.trackingMode);
        if ((slot.exerciseType ?? "lifting") !== expected) {
          mismatches.push(`${slot.canonicalExerciseId}: expected ${expected}`);
        }
      }
    }
  }

  if (response.type === "edits") {
    for (const edit of response.edits) {
      const exerciseId =
        edit.op === "replace_exercise"
          ? edit.newExerciseId
          : edit.op === "add_exercise"
            ? edit.canonicalExerciseId
            : undefined;
      if (!exerciseId) continue;
      const exercise = byId.get(exerciseId);
      if (!exercise) continue;
      const expected = expectedExerciseType(exercise.trackingMode);
      const slotType = edit.op === "add_exercise" ? (edit.exerciseType ?? "lifting") : undefined;
      if (slotType !== undefined && slotType !== expected) {
        mismatches.push(`${exerciseId}: expected ${expected}`);
      }
    }
  }

  return [...new Set(mismatches)];
}

// ── Service function ──────────────────────────────────────────────────────────

export async function smartBuilderChat(
  params: SmartBuilderChatParams,
): Promise<Result<SmartBuilderChatResult>> {
  const { action, userContext, currentProgram } = params;

  if (action === "refine" && currentProgram === undefined) {
    return err("INTERNAL_ERROR", "currentProgram is required for the refine action");
  }

  const client = getGeminiClient();
  if (!client) {
    return err("INTERNAL_ERROR", "AI service is not configured (missing GOOGLE_CLOUD_PROJECT)");
  }

  const model = getGeminiProModel();

  let systemInstruction: string;
  let initialUserPrompt: string;

  if (action === "converse") {
    systemInstruction = SMART_BUILDER_CONVERSE_SYSTEM;
    initialUserPrompt = buildConversePrompt(params);
  } else if (action === "generate") {
    systemInstruction = SMART_BUILDER_GENERATE_SYSTEM;
    initialUserPrompt = buildGeneratePrompt(params);
  } else {
    systemInstruction = SMART_BUILDER_REFINE_SYSTEM;
    initialUserPrompt = buildRefinePrompt(params);
  }

  const validIds = new Set(userContext.exerciseLibrary.map((e) => e.id));
  const MAX_RETRIES = 2;

  const messages: { role: "user"; parts: { text: string }[] }[] = [
    { role: "user", parts: [{ text: initialUserPrompt }] },
  ];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response: Awaited<ReturnType<typeof client.models.generateContent>>;
    try {
      response = await client.models.generateContent({
        model,
        contents: messages,
        config: {
          thinkingConfig: getGeminiThinkingConfig(),
          systemInstruction,
          responseMimeType: "application/json",
        },
      });
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          attempt,
          component: "smartBuilderChat",
        },
        "Gemini call failed",
      );
      return err("INTERNAL_ERROR", "AI service is temporarily unavailable. Please try again.");
    }

    void recordTokenUsage({
      userId: params.userId,
      feature: "smart_builder_chat",
      model,
      usageMetadata: response.usageMetadata,
    });

    const text = response.text ?? "";
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      logger.error(
        { raw: text.slice(0, 500), attempt, component: "smartBuilderChat" },
        "AI returned invalid JSON",
      );
      return err("INTERNAL_ERROR", "The AI returned an unexpected response. Please try again.");
    }

    const validated = SmartBuilderResponseSchema.safeParse(json);
    if (!validated.success) {
      logger.error(
        { error: validated.error.flatten(), raw: text.slice(0, 500), attempt, component: "smartBuilderChat" },
        "AI response failed schema validation",
      );
      return err("INTERNAL_ERROR", "The AI returned a malformed response. Please try again.");
    }

    // ── Hallucination guard: validate exercise IDs ──────────────────────────
    const invalidIds = validateExerciseIds(validIds, validated.data);
    if (invalidIds.length > 0) {
      logger.warn(
        { attempt, invalidIds, component: "smartBuilderChat" },
        `smartBuilderChat: attempt ${attempt + 1} had ${invalidIds.length} invalid exercise IDs`,
      );

      if (attempt < MAX_RETRIES) {
        messages.push({ role: "user", parts: [{ text: `[AI response]: ${text}` }] });
        messages.push({ role: "user", parts: [{ text: buildRetryPrompt(invalidIds, userContext.exerciseLibrary) }] });
        continue;
      }

      // Retries exhausted — encode HALLUCINATION_EXHAUSTED in the message so the
      // route can detect it and surface the special error shape the client parses.
      return err("INTERNAL_ERROR", `${HALLUCINATION_EXHAUSTED}: AI could not generate a valid program after multiple attempts.`);
    }

    // ── Exercise type validation ─────────────────────────────────────────────
    const typeMismatches = validateExerciseTypes(userContext.exerciseLibrary, validated.data);
    if (typeMismatches.length > 0) {
      logger.warn(
        { attempt, typeMismatches, component: "smartBuilderChat" },
        `smartBuilderChat: attempt ${attempt + 1} had ${typeMismatches.length} exercise type mismatches`,
      );

      if (attempt < MAX_RETRIES) {
        messages.push({ role: "user", parts: [{ text: `[AI response]: ${text}` }] });
        messages.push({
          role: "user",
          parts: [
            {
              text:
                `These exerciseType values do not match the exercise library trackingMode: ${typeMismatches.join(", ")}. ` +
                "Return corrected JSON using trackingMode reps -> lifting, timed -> timed, cardio -> cardio.",
            },
          ],
        });
        continue;
      }

      return err("INTERNAL_ERROR", "AI generated a program with incompatible exercise types. Please try again.");
    }

    // ── SlotId uniqueness guard ──────────────────────────────────────────────
    if (validated.data.type === "program") {
      const slotIds = validated.data.program.schedule.flatMap((d) =>
        d.exercises.map((e) => e.slotId),
      );
      const uniqueSlotIds = new Set(slotIds);
      if (uniqueSlotIds.size !== slotIds.length) {
        logger.error({ component: "smartBuilderChat" }, "Duplicate slotIds in generated program");
        return err("INTERNAL_ERROR", "AI generated a program with duplicate slot IDs. Please try again.");
      }
    }

    return ok(validated.data);
  }

  // Should never reach here, but satisfies TypeScript.
  return err("INTERNAL_ERROR", `${HALLUCINATION_EXHAUSTED}: AI could not generate a valid program after multiple attempts.`);
}
