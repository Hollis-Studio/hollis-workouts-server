-- Add soft-delete tombstone column to hard-delete synced resources.
-- Additive + nullable: backward-compatible with currently-running server code.
-- Once the matching application code ships, DELETE sets deletedAt instead of
-- removing the row, and list endpoints surface tombstones so clients can evict
-- cross-device deletes from their local mirror.
ALTER TABLE "programs" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "sessions" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "progression_baselines" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "cardio_baselines" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "gym_exercise_instances" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "exercise_aliases" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "metric_basket_snapshots" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "plateau_coaching_artifacts" ADD COLUMN "deletedAt" TIMESTAMP(3);
