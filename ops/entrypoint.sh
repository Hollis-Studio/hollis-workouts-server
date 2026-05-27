#!/bin/sh
# ops/entrypoint.sh — Container entrypoint for Hollis Workouts Server
#
# Runs `prisma migrate deploy` before starting the server so schema migrations
# are applied atomically on each ECS task start.
#
# SKIP_MIGRATE=1 skips the migration step entirely (useful for read-only
# ECS tasks, smoke-test containers, or emergency rollbacks where you do NOT
# want the server to attempt a migration).
#
# Vertex AI ADC on Fargate:
#   If GOOGLE_APPLICATION_CREDENTIALS_JSON is set, the service-account key JSON
#   is written to /tmp/gcp-sa.json and GOOGLE_APPLICATION_CREDENTIALS is
#   exported so the Google Cloud SDK picks it up automatically.
#   The block is guarded — local/dev containers that lack this var still boot.
#
# Usage (Docker):
#   ENTRYPOINT ["./ops/entrypoint.sh"]
#   # No CMD needed — script always ends with `exec node dist/index.js`
#
# Usage (override for testing):
#   SKIP_MIGRATE=1 ./ops/entrypoint.sh
#
set -e

# ---------------------------------------------------------------------------
# Vertex AI ADC bootstrap (only when GOOGLE_APPLICATION_CREDENTIALS_JSON is set)
# ---------------------------------------------------------------------------
if [ -n "${GOOGLE_APPLICATION_CREDENTIALS_JSON}" ]; then
  echo "[entrypoint] Writing GCP service-account key to /tmp/gcp-sa.json ..."
  printf '%s' "${GOOGLE_APPLICATION_CREDENTIALS_JSON}" > /tmp/gcp-sa.json
  export GOOGLE_APPLICATION_CREDENTIALS=/tmp/gcp-sa.json
  echo "[entrypoint] GOOGLE_APPLICATION_CREDENTIALS=/tmp/gcp-sa.json"
fi

# ---------------------------------------------------------------------------
# Prisma migrations
# ---------------------------------------------------------------------------
if [ "${SKIP_MIGRATE}" = "1" ]; then
  echo "[entrypoint] SKIP_MIGRATE=1 — skipping prisma migrate deploy"
else
  echo "[entrypoint] Running prisma migrate deploy..."
  npx prisma migrate deploy
  echo "[entrypoint] Migrations complete."
fi

echo "[entrypoint] Starting server..."
exec node dist/index.js
