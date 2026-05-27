locals {
  # Canonical name prefix used across all resources in this stack.
  # Matches the task-def family "hollis-workouts-server" and the CloudWatch
  # log group "/ecs/hollis-workouts-server" committed in ops/ecs-task-def.json.
  name    = "hollis-workouts-server"
  db_name = "hollis_workouts"

  tags = {
    ManagedBy   = "terraform"
    Project     = var.project
    Environment = var.environment
    Suite       = "hollis"
  }
}

# ---------------------------------------------------------------------------
# Caller identity — used in outputs to confirm the correct account is targeted.
# ---------------------------------------------------------------------------
data "aws_caller_identity" "current" {}

# ---------------------------------------------------------------------------
# ECR repository (new — workouts-specific)
# ---------------------------------------------------------------------------
resource "aws_ecr_repository" "workouts" {
  name                 = local.name
  image_tag_mutability = "MUTABLE"
  force_delete         = var.environment != "prod"

  image_scanning_configuration {
    scan_on_push = true
  }
}

# ---------------------------------------------------------------------------
# CloudWatch log group (new — workouts-specific)
# Matches the hard-coded group in ops/ecs-task-def.json.
# ---------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "workouts" {
  name              = "/ecs/${local.name}"
  retention_in_days = var.environment == "prod" ? 90 : 30
}

# ---------------------------------------------------------------------------
# Secrets Manager — three discrete secrets at the hollis-prod/workouts/ prefix
# so they can be referenced individually in the ECS task secrets[] array.
# ---------------------------------------------------------------------------
resource "aws_secretsmanager_secret" "database_url" {
  name        = "hollis-prod/workouts/database-url"
  description = "DATABASE_URL for hollis_workouts on hollis-prod-postgres."
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id = aws_secretsmanager_secret.database_url.id
  # Placeholder value — replace with the real connection string in the console
  # or via a subsequent `terraform apply -var 'database_url=...'` after the
  # hollis_workouts database and credentials are created out-of-band on the
  # shared RDS instance.
  secret_string = "PLACEHOLDER — set to: postgresql://<user>:<pass>@${data.aws_db_instance.shared.address}:${data.aws_db_instance.shared.port}/${local.db_name}?sslmode=require&connection_limit=20"
}

resource "aws_secretsmanager_secret" "identity_jwt_secret" {
  name        = "hollis-prod/workouts/identity-jwt-secret"
  description = "IDENTITY_JWT_SECRET for verifying JWTs issued by Hollis Identity."
}

resource "aws_secretsmanager_secret_version" "identity_jwt_secret" {
  secret_id = aws_secretsmanager_secret.identity_jwt_secret.id
  # IMPORTANT: This MUST be the SAME secret that Hollis Identity uses to sign
  # HS256 tokens (var.identity_jwt_secret). A randomly generated value here
  # would cause every JWT verification to fail. Set it out-of-band before the
  # first deploy using: terraform apply -var 'identity_jwt_secret=<shared-secret>'
  # or via a .tfvars file that is NOT committed to the repo.
  secret_string = var.identity_jwt_secret
}

resource "aws_secretsmanager_secret" "identity_service_url" {
  name        = "hollis-prod/workouts/identity-service-url"
  description = "IDENTITY_SERVICE_URL for the Hollis Identity Service."
}

resource "aws_secretsmanager_secret_version" "identity_service_url" {
  secret_id     = aws_secretsmanager_secret.identity_service_url.id
  secret_string = var.identity_service_url
}

resource "aws_secretsmanager_secret" "database_ssl_ca" {
  name        = "hollis-prod/workouts/database-ssl-ca"
  description = "PEM-encoded RDS CA bundle for DATABASE_SSL_CA (enables rejectUnauthorized in production)."
}

resource "aws_secretsmanager_secret_version" "database_ssl_ca" {
  secret_id = aws_secretsmanager_secret.database_ssl_ca.id
  # Download from: https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
  # Set via console or a one-time `aws secretsmanager put-secret-value` before first deploy.
  secret_string = "PLACEHOLDER — replace with PEM contents of the RDS global CA bundle"
}

# ---------------------------------------------------------------------------
# Secrets Manager — AI / observability / entitlement secrets
# All values are PLACEHOLDERs that MUST be set out-of-band before the first
# `terraform apply`. The secret resource is created by Terraform; the value
# is set manually (console / aws secretsmanager put-secret-value) so that the
# real credentials are never stored in state or version control.
# ---------------------------------------------------------------------------

resource "aws_secretsmanager_secret" "sentry_dsn" {
  name        = "hollis-prod/workouts/sentry-dsn"
  description = "SENTRY_DSN for Workouts Server error tracking. Optional — Sentry is disabled when this is absent."
}

resource "aws_secretsmanager_secret_version" "sentry_dsn" {
  secret_id = aws_secretsmanager_secret.sentry_dsn.id
  # PLACEHOLDER — set out-of-band before deploy.
  # Obtain from: Sentry project settings → DSN
  # Format: https://<key>@<org>.ingest.sentry.io/<project-id>
  secret_string = "PLACEHOLDER — set to the Sentry DSN for the hollis-workouts-server project"
}

resource "aws_secretsmanager_secret" "revenuecat_rest_api_key" {
  name        = "hollis-prod/workouts/revenuecat-rest-api-key"
  description = "REVENUECAT_REST_API_KEY for Workouts Server entitlement checks. Optional — RevenueCat check is bypassed when absent."
}

resource "aws_secretsmanager_secret_version" "revenuecat_rest_api_key" {
  secret_id = aws_secretsmanager_secret.revenuecat_rest_api_key.id
  # PLACEHOLDER — set out-of-band before deploy.
  # Obtain from: RevenueCat dashboard → API Keys → Secret keys
  secret_string = "PLACEHOLDER — set to the RevenueCat secret REST API key (sk_...)"
}

resource "aws_secretsmanager_secret" "google_cloud_project" {
  name        = "hollis-prod/workouts/google-cloud-project"
  description = "GOOGLE_CLOUD_PROJECT GCP project ID for Vertex AI / Gemini."
}

resource "aws_secretsmanager_secret_version" "google_cloud_project" {
  secret_id = aws_secretsmanager_secret.google_cloud_project.id
  # PLACEHOLDER — set out-of-band before deploy.
  # Set to the GCP project ID (e.g. "hollis-prod") that hosts the Vertex AI API.
  secret_string = "PLACEHOLDER — set to the GCP project ID (e.g. hollis-prod)"
}

resource "aws_secretsmanager_secret" "google_application_credentials_json" {
  name        = "hollis-prod/workouts/google-application-credentials-json"
  description = "GOOGLE_APPLICATION_CREDENTIALS_JSON — full service-account key JSON for Vertex AI ADC on Fargate. ops/entrypoint.sh writes this to /tmp/gcp-sa.json and sets GOOGLE_APPLICATION_CREDENTIALS."
}

resource "aws_secretsmanager_secret_version" "google_application_credentials_json" {
  secret_id = aws_secretsmanager_secret.google_application_credentials_json.id
  # PLACEHOLDER — set out-of-band before deploy.
  # Obtain from GCP console: IAM → Service Accounts → <sa> → Keys → Add Key → JSON.
  # The service account needs roles/aiplatform.user on the project.
  # Store the ENTIRE JSON file contents as the secret value (single-line or pretty-printed).
  secret_string = "PLACEHOLDER — set to the full contents of the GCP service-account key JSON file"
}
