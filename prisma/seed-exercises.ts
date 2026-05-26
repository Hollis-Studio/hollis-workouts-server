/**
 * seed-exercises.ts — Upserts canonical exercises into the `canonical_exercises` table.
 *
 * Data source:
 *   hollis-workouts/scripts/data/exercises.json
 *   (the same JSON the Firebase seed script uses — Firestore and Postgres use identical data)
 *
 * Usage (from hollis-workouts-server root, with DB running):
 *   npx tsx prisma/seed-exercises.ts
 *
 * The script reads the exercises.json file relative to this file's location,
 * validates each entry with the inline Zod schema (matching the Prisma model),
 * and upserts in batches of 100.
 *
 * isActive defaults to true when absent in the JSON (matches the Zod default).
 * createdAt defaults to 2025-01-01T00:00:00Z when absent.
 * metadata defaults to {} when absent.
 * requiredEquipment defaults to [] when absent.
 * trackingMode is optional.
 *
 * Run from the server repo root — prisma/generated/prisma must be generated first:
 *   npm run prisma:generate
 */

import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync } from "fs";
import { z } from "zod";
import { PrismaClient } from "./generated/prisma/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Zod schema — mirrors the CanonicalExercise Prisma model.
// Kept inline to avoid any path-alias resolution issues when run with tsx.
// ---------------------------------------------------------------------------

const CanonicalExerciseSeedSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  category: z.string().min(1),
  subcategory: z.string().min(1).optional(),
  primaryMuscleGroups: z.array(z.string()).min(1),
  secondaryMuscleGroups: z.array(z.string()).default([]),
  equipmentType: z.string().min(1),
  requiredEquipment: z.array(z.string()).default([]),
  isBodyweight: z.boolean(),
  isUnilateral: z.boolean(),
  defaultRestTimerSec: z.number().int().min(0),
  defaultWeightMode: z.string().min(1),
  illustrationUrl: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  minimumIncrementKg: z.number().min(0),
  source: z.string().min(1),
  isActive: z.boolean().default(true),
  trackingMode: z.string().optional(),
  createdAt: z.coerce.date().default(() => new Date("2025-01-01T00:00:00Z")),
});

type ExerciseSeedEntry = z.infer<typeof CanonicalExerciseSeedSchema>;

// ---------------------------------------------------------------------------
// Locate exercises.json — path relative to this file in the repo tree.
// Canonical location: hollis-workouts/scripts/data/exercises.json
// Server repo is at: hollis-workouts-server/ (sibling directory)
// Relative path from prisma/seed-exercises.ts to the data file:
//   ../../hollis-workouts/scripts/data/exercises.json
// ---------------------------------------------------------------------------

const DATA_PATH = join(
  __dirname,
  "..",
  "..",
  "hollis-workouts",
  "scripts",
  "data",
  "exercises.json",
);

// Module-scoped so the outer .catch() can disconnect on a fatal error — an
// open pool otherwise keeps the process alive until the pg idle timeout,
// hanging a deploy/seed pipeline.
const prisma = new PrismaClient();

async function main(): Promise<void> {
  console.log(`Reading exercises from: ${DATA_PATH}`);
  const raw = JSON.parse(readFileSync(DATA_PATH, "utf-8")) as unknown[];
  console.log(`Read ${raw.length} raw entries`);

  // Validate
  const valid: ExerciseSeedEntry[] = [];
  let errors = 0;
  for (let i = 0; i < raw.length; i++) {
    const result = CanonicalExerciseSeedSchema.safeParse(raw[i]);
    if (result.success) {
      valid.push(result.data);
    } else {
      console.error(`Validation failed at index ${i}:`, result.error.issues);
      errors++;
    }
  }

  if (errors > 0) {
    console.error(`${errors} validation error(s). Aborting.`);
    await prisma.$disconnect();
    process.exit(1);
  }

  console.log(`All ${valid.length} entries validated — upserting...`);

  const BATCH_SIZE = 100;
  let upserted = 0;

  for (let i = 0; i < valid.length; i += BATCH_SIZE) {
    const chunk = valid.slice(i, i + BATCH_SIZE);
    await Promise.all(
      chunk.map((entry) =>
        prisma.canonicalExercise.upsert({
          where: { id: entry.id },
          create: {
            id: entry.id,
            name: entry.name,
            description: entry.description,
            category: entry.category,
            subcategory: entry.subcategory ?? null,
            primaryMuscleGroups: entry.primaryMuscleGroups,
            secondaryMuscleGroups: entry.secondaryMuscleGroups,
            equipmentType: entry.equipmentType,
            requiredEquipment: entry.requiredEquipment,
            isBodyweight: entry.isBodyweight,
            isUnilateral: entry.isUnilateral,
            defaultRestTimerSec: entry.defaultRestTimerSec,
            defaultWeightMode: entry.defaultWeightMode,
            illustrationUrl: entry.illustrationUrl,
            metadata: entry.metadata,
            minimumIncrementKg: entry.minimumIncrementKg,
            source: entry.source,
            isActive: entry.isActive,
            trackingMode: entry.trackingMode ?? null,
            createdAt: entry.createdAt,
          },
          update: {
            name: entry.name,
            description: entry.description,
            category: entry.category,
            subcategory: entry.subcategory ?? null,
            primaryMuscleGroups: entry.primaryMuscleGroups,
            secondaryMuscleGroups: entry.secondaryMuscleGroups,
            equipmentType: entry.equipmentType,
            requiredEquipment: entry.requiredEquipment,
            isBodyweight: entry.isBodyweight,
            isUnilateral: entry.isUnilateral,
            defaultRestTimerSec: entry.defaultRestTimerSec,
            defaultWeightMode: entry.defaultWeightMode,
            illustrationUrl: entry.illustrationUrl,
            metadata: entry.metadata,
            minimumIncrementKg: entry.minimumIncrementKg,
            source: entry.source,
            isActive: entry.isActive,
            trackingMode: entry.trackingMode ?? null,
          },
        }),
      ),
    );
    upserted += chunk.length;
    console.log(`  ${upserted}/${valid.length} upserted`);
  }

  console.log(`Done — ${upserted} canonical exercises upserted into canonical_exercises.`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("Fatal:", err);
  await prisma.$disconnect().catch(() => {
    /* best-effort — already failing */
  });
  process.exit(1);
});
