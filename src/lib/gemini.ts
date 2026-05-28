/**
 * @ai-context Lazily-initialized Vertex AI Gemini client for Workouts Server.
 *
 * Uses GEMINI_API_KEY when present, otherwise Application Default Credentials
 * (ADC) via the @google/genai SDK with vertexai: true. The client is NOT
 * instantiated at module load — call getGeminiClient() at the service call site.
 * This allows the server to boot without AI credentials and return a graceful
 * error at runtime rather than crashing on startup.
 *
 * Model name helpers mirror functions/src/utils/gemini.ts so service ports
 * read identically.
 *
 * deps: @google/genai, lib/env | consumers: src/services/ai/*
 */

import { GoogleGenAI, type GoogleGenAIOptions, type ThinkingConfig } from "@google/genai";
import { env } from "./env.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const GEMINI_HTTP_TIMEOUT_MS = 60_000;

// ── Lazy singleton ────────────────────────────────────────────────────────────

let _client: GoogleGenAI | null = null;

/**
 * Returns the lazily-initialized Vertex AI GoogleGenAI client.
 * Returns null when neither GEMINI_API_KEY nor GOOGLE_CLOUD_PROJECT is set,
 * allowing the server to boot without GCP credentials; service callers return
 * err("INTERNAL_ERROR") at call time.
 */
export function getGeminiClient(): GoogleGenAI | null {
  if (_client) return _client;

  const apiKey = env.GEMINI_API_KEY?.trim();
  if (apiKey) {
    _client = new GoogleGenAI({
      apiKey,
      httpOptions: { timeout: GEMINI_HTTP_TIMEOUT_MS },
    });
    return _client;
  }

  const project = env.GOOGLE_CLOUD_PROJECT;
  // Treat blank/whitespace-only values as unset so placeholder strings don't instantiate a broken client.
  if (!project || project.trim() === "") {
    return null;
  }

  const options: GoogleGenAIOptions = {
    vertexai: true,
    project,
    location: env.GOOGLE_CLOUD_LOCATION,
    httpOptions: { timeout: GEMINI_HTTP_TIMEOUT_MS },
  };

  _client = new GoogleGenAI(options);
  return _client;
}

// ── Model name helpers ────────────────────────────────────────────────────────

export function getGeminiFlashModel(): string {
  return env.GEMINI_FLASH_MODEL;
}

export function getGeminiProModel(): string {
  return env.GEMINI_PRO_MODEL;
}

export function getGeminiEmbeddingModel(): string {
  return env.GEMINI_EMBEDDING_MODEL;
}

export function getGeminiThinkingConfig(): ThinkingConfig {
  return { thinkingLevel: "HIGH" as ThinkingConfig["thinkingLevel"] };
}

// ── Test helpers ──────────────────────────────────────────────────────────────

export function resetGeminiClientForTests(): void {
  _client = null;
}
