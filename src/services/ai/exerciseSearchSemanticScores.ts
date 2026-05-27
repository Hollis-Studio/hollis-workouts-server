/**
 * @ai-context AI service — compute semantic similarity scores for exercise search.
 *
 * Ports functions/src/exerciseSearch/semanticScores.ts.
 * Model: gemini-embedding-001 (Vertex AI embedContent).
 * Entitlement: none (all authenticated users).
 *
 * Improvements over the Cloud Function:
 *   - Parallelizes document embeddings with Promise.all (CF was sequential, timing out at 120s).
 *   - Uses ExerciseEmbeddingCache in Postgres (key: canonicalExerciseId + modelVersion,
 *     invalidated via SHA-256 sourceTextHash) to avoid re-embedding static exercises.
 *   - The query embedding is never cached (user input varies every call).
 *
 * deps: lib/gemini, lib/prisma, lib/logger | consumers: src/routes/ai/exerciseSearchSemanticScores.ts
 */

import crypto from "crypto";
import { createId } from "@paralleldrive/cuid2";
import type { Result } from "@hollis-studio/contracts";
import { ok, err } from "@hollis-studio/contracts";
import { getGeminiClient, getGeminiEmbeddingModel } from "../../lib/gemini.js";
import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const EMBEDDING_DIMENSIONS = 3072;
const RETRIEVAL_QUERY = "RETRIEVAL_QUERY";
const RETRIEVAL_DOCUMENT = "RETRIEVAL_DOCUMENT";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ExerciseSearchItem {
  id: string;
  name: string;
  searchText?: string;
}

export interface SemanticScoresResult {
  scoresByExerciseId: Record<string, number>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;

  let dotProduct = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let i = 0; i < left.length; i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    dotProduct += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }

  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dotProduct / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function sha256hex(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

async function embedText(
  text: string,
  taskType: string,
): Promise<number[]> {
  const client = getGeminiClient();
  if (!client) {
    throw new Error("AI service is not configured (missing GOOGLE_CLOUD_PROJECT)");
  }

  const model = getGeminiEmbeddingModel();
  const response = await client.models.embedContent({
    model,
    contents: [text],
    config: {
      taskType,
      outputDimensionality: EMBEDDING_DIMENSIONS,
    },
  });

  const values = response.embeddings?.[0]?.values;
  if (!values || values.length === 0) {
    throw new Error("Vertex AI returned an empty embedding");
  }

  return values;
}

/**
 * Fetches a cached embedding from Postgres, or embeds via Vertex AI and
 * writes the result to cache. Only called for document embeddings (static
 * exercise library) — query embeddings are never cached.
 */
async function getOrEmbedDocument(
  canonicalExerciseId: string,
  sourceText: string,
  modelVersion: string,
): Promise<number[]> {
  const sourceTextHash = sha256hex(sourceText);

  // Cache hit: same exercise, same model, same source text hash
  const cached = await prisma.exerciseEmbeddingCache.findFirst({
    where: { canonicalExerciseId, modelVersion },
    select: { embedding: true, sourceTextHash: true },
  });

  if (cached && cached.sourceTextHash === sourceTextHash) {
    return cached.embedding;
  }

  // Cache miss or stale hash: re-embed and upsert
  const embedding = await embedText(sourceText, RETRIEVAL_DOCUMENT);

  try {
    await prisma.exerciseEmbeddingCache.upsert({
      where: { canonicalExerciseId_modelVersion: { canonicalExerciseId, modelVersion } },
      create: {
        id: createId(),
        canonicalExerciseId,
        modelVersion,
        sourceTextHash,
        embedding,
        createdAt: new Date(),
      },
      update: {
        sourceTextHash,
        embedding,
        createdAt: new Date(),
      },
    });
  } catch (cacheError) {
    // Swallow cache write failures — the embedding result is still valid.
    logger.warn(
      {
        canonicalExerciseId,
        error: cacheError instanceof Error ? cacheError.message : String(cacheError),
        component: "exerciseSearchSemanticScores",
      },
      "Failed to write embedding cache entry",
    );
  }

  return embedding;
}

// ── Service function ──────────────────────────────────────────────────────────

export async function exerciseSearchSemanticScores(
  query: string,
  exercises: ExerciseSearchItem[],
): Promise<Result<SemanticScoresResult>> {
  const client = getGeminiClient();
  if (!client) {
    return err("INTERNAL_ERROR", "AI service is not configured (missing GOOGLE_CLOUD_PROJECT)");
  }

  const modelVersion = getGeminiEmbeddingModel();

  let queryEmbedding: number[];
  try {
    queryEmbedding = await embedText(query, RETRIEVAL_QUERY);
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error), component: "exerciseSearchSemanticScores" },
      "Failed to embed query",
    );
    return err("INTERNAL_ERROR", "Could not compute exercise semantic scores. Please try again.");
  }

  // Parallelize all document embeddings (with caching).
  let documentEmbeddings: number[][];
  try {
    documentEmbeddings = await Promise.all(
      exercises.map((exercise) => {
        const sourceText = exercise.searchText ?? exercise.name;
        return getOrEmbedDocument(exercise.id, sourceText, modelVersion);
      }),
    );
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error), component: "exerciseSearchSemanticScores" },
      "Failed to embed exercise documents",
    );
    return err("INTERNAL_ERROR", "Could not compute exercise semantic scores. Please try again.");
  }

  const scoresByExerciseId: Record<string, number> = {};
  for (let i = 0; i < exercises.length; i++) {
    const exercise = exercises[i];
    const docEmbedding = documentEmbeddings[i];
    if (!exercise || !docEmbedding) continue;

    const rawScore = cosineSimilarity(queryEmbedding, docEmbedding);
    scoresByExerciseId[exercise.id] = Math.max(0, Math.min(1, rawScore));
  }

  return ok({ scoresByExerciseId });
}
