#!/usr/bin/env bash
# ops/render-task-def.sh
#
# SOURCE OF TRUTH: infrastructure/ecs.tf (Terraform). This script is the
# non-Terraform fallback path — used only when registering a task definition
# directly via the AWS CLI without running `terraform apply`.
#
# Substitutes ${PLACEHOLDER} variables in ops/ecs-task-def.json using values
# from environment variables, writing the result to ops/ecs-task-def.rendered.json
# (which is .gitignore'd — it may contain real ARNs/account IDs).
#
# Required env vars:
#   EXECUTION_ROLE_ARN                     — ECS task execution role ARN
#   TASK_ROLE_ARN                          — ECS task role ARN (runtime AWS permissions)
#   ECR_IMAGE_URI                          — Full ECR image URI including tag/digest
#   AWS_REGION                             — e.g. us-east-1
#
#   # Secrets Manager ARNs (one per secret):
#   SSM_ARN_DATABASE_URL                   — Secrets Manager ARN for DATABASE_URL
#   SSM_ARN_DATABASE_SSL_CA                — Secrets Manager ARN for RDS CA bundle PEM
#   SSM_ARN_IDENTITY_JWT_SECRET            — Secrets Manager ARN for IDENTITY_JWT_SECRET
#   SSM_ARN_IDENTITY_SERVICE_URL           — Secrets Manager ARN for IDENTITY_SERVICE_URL
#   SSM_ARN_SENTRY_DSN                     — Secrets Manager ARN for SENTRY_DSN
#   SSM_ARN_REVENUECAT_REST_API_KEY        — Secrets Manager ARN for REVENUECAT_REST_API_KEY
#   SSM_ARN_GOOGLE_CLOUD_PROJECT           — Secrets Manager ARN for GOOGLE_CLOUD_PROJECT
#   SSM_ARN_GOOGLE_APPLICATION_CREDENTIALS_JSON — Secrets Manager ARN for the GCP SA key JSON
#
# Usage:
#   source .env.deploy   # or export vars manually
#   ./ops/render-task-def.sh
#   aws ecs register-task-definition --cli-input-json file://ops/ecs-task-def.rendered.json
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="${SCRIPT_DIR}/ecs-task-def.json"
OUTPUT="${SCRIPT_DIR}/ecs-task-def.rendered.json"

# Validate required vars are set
REQUIRED_VARS=(
  EXECUTION_ROLE_ARN
  TASK_ROLE_ARN
  ECR_IMAGE_URI
  AWS_REGION
  SSM_ARN_DATABASE_URL
  SSM_ARN_DATABASE_SSL_CA
  SSM_ARN_IDENTITY_JWT_SECRET
  SSM_ARN_IDENTITY_SERVICE_URL
  SSM_ARN_SENTRY_DSN
  SSM_ARN_REVENUECAT_REST_API_KEY
  SSM_ARN_GOOGLE_CLOUD_PROJECT
  SSM_ARN_GOOGLE_APPLICATION_CREDENTIALS_JSON
)

missing=()
for var in "${REQUIRED_VARS[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    missing+=("$var")
  fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "ERROR: The following required environment variables are not set:" >&2
  for v in "${missing[@]}"; do
    echo "  - $v" >&2
  done
  exit 1
fi

# Export all required vars so envsubst can see them.
export EXECUTION_ROLE_ARN TASK_ROLE_ARN ECR_IMAGE_URI AWS_REGION \
  SSM_ARN_DATABASE_URL SSM_ARN_DATABASE_SSL_CA \
  SSM_ARN_IDENTITY_JWT_SECRET SSM_ARN_IDENTITY_SERVICE_URL \
  SSM_ARN_SENTRY_DSN SSM_ARN_REVENUECAT_REST_API_KEY \
  SSM_ARN_GOOGLE_CLOUD_PROJECT SSM_ARN_GOOGLE_APPLICATION_CREDENTIALS_JSON

# Use jq to strip _comment fields (not valid in ECS API), then envsubst for
# variable substitution.
if command -v jq &>/dev/null; then
  jq 'del(.. | objects | ._comment?) | del(._comment)' "${TEMPLATE}" \
    | envsubst > "${OUTPUT}"
else
  # Fallback: envsubst without jq comment stripping (ECS API ignores unknown keys)
  envsubst < "${TEMPLATE}" > "${OUTPUT}"
fi

echo "Rendered task definition written to: ${OUTPUT}"
echo "To register: aws ecs register-task-definition --cli-input-json file://${OUTPUT}"
