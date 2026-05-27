variable "aws_account_id" {
  description = "AWS account that this stack is allowed to target."
  type        = string
  default     = "344345273019"
}

variable "aws_region" {
  description = "AWS region for the Workouts service."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Deployment environment name."
  type        = string
  default     = "prod"
}

variable "project" {
  description = "Project/service name used in resource names."
  type        = string
  default     = "hollis-workouts-server"
}

variable "image_tag" {
  description = "Container image tag deployed by ECS."
  type        = string
  default     = "latest"
}

variable "certificate_arn" {
  description = "ACM certificate ARN for the HTTPS listener already attached to hollis-prod-alb."
  type        = string
  # Must be supplied at apply time — the ARN is not known until the cert is issued.
  # Example: arn:aws:acm:us-east-1:344345273019:certificate/<uuid>
}

variable "workouts_domain_name" {
  description = "Host-based routing rule on the shared ALB (e.g. workouts-api.hollis.health)."
  type        = string
  default     = "workouts-api.hollis.health"
}

variable "alb_name" {
  description = "Name of the existing shared ALB to attach to."
  type        = string
  default     = "hollis-prod-alb"
}

variable "ecs_cluster_name" {
  description = "Name of the existing shared ECS cluster."
  type        = string
  default     = "hollis-prod-cluster"
}

variable "rds_identifier" {
  description = "Identifier of the existing shared RDS instance."
  type        = string
  default     = "hollis-prod-postgres"
}

variable "rds_security_group_id" {
  description = "Security group ID already attached to hollis-prod-postgres. An additive ingress rule is appended — the SG itself is never managed by this stack."
  type        = string
  default     = "sg-072f4e44c43356914"
}

variable "vpc_id" {
  description = "VPC ID that contains the shared ALB, ECS cluster, and RDS instance."
  type        = string
  default     = "vpc-0abe755c07479d64a"
}

variable "private_subnet_ids" {
  description = "List of private subnet IDs in the shared VPC for ECS task placement."
  type        = list(string)
  # Kickback: real subnet IDs are not in the provided inventory; supply at apply time.
  # Example: ["subnet-aaaa1111", "subnet-bbbb2222"]
  default = []
}

variable "desired_count" {
  description = "Number of ECS tasks."
  type        = number
  default     = 2
}

variable "cpu" {
  description = "Fargate task CPU units."
  type        = number
  default     = 256
}

variable "memory" {
  description = "Fargate task memory MiB."
  type        = number
  default     = 512
}

variable "log_level" {
  description = "LOG_LEVEL injected into the container (debug|info|warn|error)."
  type        = string
  default     = "info"
}

variable "identity_service_url" {
  description = "Base URL of the Hollis Identity Service (stored in Secrets Manager; set via tfvars or env)."
  type        = string
  default     = "https://identity.hollis.health"
}

# ---------------------------------------------------------------------------
# Dedicated-database gate
# ---------------------------------------------------------------------------
# When false (default), the workouts service shares hollis-prod-postgres and
# only a new database logical object + additive SG rule are created.
# Set to true to provision a net-new aws_db_instance for workouts.
# ---------------------------------------------------------------------------
variable "create_dedicated_db" {
  description = "Set to true to provision a dedicated RDS instance instead of sharing hollis-prod-postgres."
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------
# HS256 shared secret — MUST match Hollis Identity's signing secret
# ---------------------------------------------------------------------------
variable "identity_jwt_secret" {
  description = "Shared HMAC-SHA256 secret used by Hollis Identity to sign JWTs and by this server to verify them. MUST be identical on both sides. Min 32 characters. Never commit the real value — pass via TF_VAR_identity_jwt_secret or a gitignored .tfvars file."
  type        = string
  sensitive   = true
  # No default — operator MUST supply the value. A mismatch here means every
  # request returns 401. See infrastructure/README.md for the apply runbook.
}

# ---------------------------------------------------------------------------
# Vertex AI / Gemini — non-secret model config
# ---------------------------------------------------------------------------
variable "google_cloud_location" {
  description = "Google Cloud location for Vertex AI API calls (e.g. 'global', 'us-central1')."
  type        = string
  default     = "global"
}

variable "gemini_flash_model" {
  description = "Gemini Flash model ID injected as GEMINI_FLASH_MODEL. Must match src/lib/env.ts default."
  type        = string
  default     = "gemini-3.1-flash-lite"
}

variable "gemini_pro_model" {
  description = "Gemini Pro model ID injected as GEMINI_PRO_MODEL. Must match src/lib/env.ts default."
  type        = string
  default     = "gemini-3.1-pro-preview"
}

variable "gemini_embedding_model" {
  description = "Gemini embedding model ID injected as GEMINI_EMBEDDING_MODEL. Must match src/lib/env.ts default."
  type        = string
  default     = "gemini-embedding-001"
}
