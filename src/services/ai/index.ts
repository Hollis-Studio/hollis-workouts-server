/**
 * @ai-context AI services barrel — individual service files live at services/ai/<feature>.ts.
 *
 * Implemented services:
 *   recognizeEquipment.ts    — multimodal image + Gemini Flash (Smart Reader)
 *   smartReaderUsage.ts      — monthly free-use counter for Smart Reader
 *   tokenUsage.ts            — fire-and-forget AI token telemetry
 *   matchExercises.ts        — exercise name → canonical ID, Gemini Flash
 *   exerciseSearchSemanticScores.ts — Vertex AI embeddings + cosine similarity
 *   logWorkoutAudio.ts       — audio transcription, Gemini Flash multimodal
 *   generateProgram.ts       — full program generation, Gemini Pro
 *   smartBuilderChat.ts      — multi-turn builder wizard, Gemini Pro
 *   gymSetupChat.ts          — gym setup wizard, Gemini Pro
 *   tagExerciseMuscles.ts    — muscle group tagging, Gemini Flash
 *
 * deps: (none — barrel only) | consumers: src/routes/ai/*
 */

// Intentionally empty — services are imported directly by route files.
export {};
