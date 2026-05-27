# Infrastructure — Hollis Workouts Server

> **Status:** Terraform IaC is written and validated. Resources are not yet applied to prod.
> See the [Apply Runbook](#apply-runbook) below before running `terraform apply`.

---

## Stack Overview

| Layer | Technology |
|---|---|
| Runtime | AWS ECS Fargate, us-east-1 |
| Container registry | Amazon ECR (`hollis-workouts-server`) |
| Load balancing | Shared ALB (`hollis-prod-alb`) — additive listener rule only |
| Secrets | AWS Secrets Manager (`hollis-prod/workouts/*`) |
| Logs | CloudWatch Logs (`/ecs/hollis-workouts-server`, 90-day retention) |
| Database | Shared RDS Postgres (`hollis-prod-postgres`) — additive SG rule only |
| IaC | Terraform ≥ 1.5.7, AWS provider `~> 5.0` |

---

## Additive Guarantee

**This stack does not modify any resource owned by Hollis Health.** Every
existing Health resource (ALB, ECS cluster, RDS instance, VPC, subnets) is
referenced as a read-only `data` source. The only mutations to shared
infrastructure are:

1. **One additive RDS security-group ingress rule** (`aws_security_group_rule.rds_from_workouts_ecs`) — appends a single `5432/tcp` ingress rule to the existing `sg-072f4e44c43356914`. Terraform never takes ownership of the SG or its pre-existing rules; removing this stack removes only this one rule.

2. **One additive ALB listener rule** (`aws_lb_listener_rule.workouts_host`) — attaches to the existing HTTPS (443) listener at priority **200** with a `host_header` condition for `workouts-api.hollis.health`. Terraform never owns the listener itself or any other rules on it.

Everything else (ECR repo, ECS service, task definition, IAM roles, security groups, Secrets Manager secrets, CloudWatch log group) is net-new and Workouts-specific.

---

## Terraform Files

| File | Purpose |
|---|---|
| `versions.tf` | Provider pin (AWS `~> 5.0`), Terraform version floor (`>= 1.5.7`) |
| `variables.tf` | All input variables with descriptions, types, defaults, and sensitivity flags |
| `main.tf` | ECR repo, CloudWatch log group, all Secrets Manager secrets + placeholder versions |
| `network.tf` | VPC data source, ECS security group, additive RDS SG rule |
| `database.tf` | RDS data source; opt-in dedicated RDS instance (`create_dedicated_db = true`) |
| `ecs.tf` | IAM execution/task roles, ALB target group, ALB listener rule, ECS task definition, ECS service |
| `outputs.tf` | ECR URL, TG ARN, service name, secret ARNs (sensitive), ALB rule ARN |

---

## Variables Reference

### Required (no default — must be supplied at apply time)

| Variable | Description |
|---|---|
| `certificate_arn` | ACM certificate ARN for `workouts-api.hollis.health`. Confirm the existing `*.hollis.health` wildcard cert covers this domain, or issue a new cert. |
| `private_subnet_ids` | List of private subnet IDs in `vpc-0abe755c07479d64a` for ECS task placement. Run: `aws ec2 describe-subnets --filters Name=vpc-id,Values=vpc-0abe755c07479d64a Name=tag:Tier,Values=private` |
| `identity_jwt_secret` | **MUST be the SAME value Hollis Identity signs HS256 tokens with.** Sensitive. Pass via `TF_VAR_identity_jwt_secret` or a gitignored `.tfvars` file. Min 32 characters. |

### Secret values set out-of-band (Terraform creates the secret resource; values set via console or AWS CLI before first deploy)

| Secret path | Env var | Notes |
|---|---|---|
| `hollis-prod/workouts/database-url` | `DATABASE_URL` | `postgresql://<user>:<pass>@<rds-host>:5432/hollis_workouts?sslmode=require&connection_limit=20` — create the `hollis_workouts` DB and user on `hollis-prod-postgres` first |
| `hollis-prod/workouts/database-ssl-ca` | `DATABASE_SSL_CA` | PEM contents of the RDS global CA bundle. Download from `https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem` |
| `hollis-prod/workouts/google-application-credentials-json` | `GOOGLE_APPLICATION_CREDENTIALS_JSON` | Full contents of the GCP service-account key JSON file. The SA needs `roles/aiplatform.user`. `ops/entrypoint.sh` writes this to `/tmp/gcp-sa.json` and exports `GOOGLE_APPLICATION_CREDENTIALS` on boot. |
| `hollis-prod/workouts/sentry-dsn` | `SENTRY_DSN` | Sentry DSN (`https://...@....ingest.sentry.io/...`). Optional — Sentry is a no-op when absent. |
| `hollis-prod/workouts/revenuecat-rest-api-key` | `REVENUECAT_REST_API_KEY` | RevenueCat secret API key (`sk_...`). Optional — entitlement check is bypassed when absent. |
| `hollis-prod/workouts/google-cloud-project` | `GOOGLE_CLOUD_PROJECT` | GCP project ID (e.g. `hollis-prod`). Optional — AI routes return a clear error at runtime when absent. |

### Optional overrides (have sensible defaults)

| Variable | Default | Description |
|---|---|---|
| `google_cloud_location` | `global` | Vertex AI API location |
| `gemini_flash_model` | `gemini-3.1-flash-lite` | Injected as `GEMINI_FLASH_MODEL` |
| `gemini_pro_model` | `gemini-3.1-pro-preview` | Injected as `GEMINI_PRO_MODEL` |
| `gemini_embedding_model` | `gemini-embedding-001` | Injected as `GEMINI_EMBEDDING_MODEL` |
| `image_tag` | `latest` | ECR image tag deployed by ECS |
| `desired_count` | `2` | Number of Fargate tasks |
| `cpu` / `memory` | `256` / `512` | Fargate task sizing |
| `log_level` | `info` | Container `LOG_LEVEL` |

---

## Apply Runbook

Follow these steps in order. Steps 1–5 are prerequisites; step 6 is the actual apply.

### 1. Build and push the container image

```bash
# Authenticate to ECR (first run — after `terraform apply` creates the repo)
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin \
    344345273019.dkr.ecr.us-east-1.amazonaws.com

# Build (requires a .npmrc with GitHub Packages token — see Dockerfile header)
docker build \
  --secret id=npmrc,src=$HOME/.config/hollis/npmrc-with-token \
  -t 344345273019.dkr.ecr.us-east-1.amazonaws.com/hollis-workouts-server:latest .

docker push 344345273019.dkr.ecr.us-east-1.amazonaws.com/hollis-workouts-server:latest
```

> Note: the ECR repo itself is created by `terraform apply`. On the very first
> run you must `terraform apply -target=aws_ecr_repository.workouts` first, then
> build and push, then run the full apply so the task definition references a
> real image.

### 2. Create the database and user on the shared RDS instance

```sql
-- Connect to hollis-prod-postgres as the admin user, then:
CREATE DATABASE hollis_workouts;
CREATE USER hollis_workouts_app WITH PASSWORD '<strong-random-password>';
GRANT ALL PRIVILEGES ON DATABASE hollis_workouts TO hollis_workouts_app;
-- Prisma also needs schema-level grants (run after first migration):
-- GRANT ALL ON SCHEMA public TO hollis_workouts_app;
```

### 3. Set secret values in Secrets Manager

After `terraform apply` creates the secret resources (with placeholder values),
update each one before the ECS service starts:

```bash
# DATABASE_URL
aws secretsmanager put-secret-value \
  --secret-id hollis-prod/workouts/database-url \
  --secret-string "postgresql://hollis_workouts_app:<pass>@<rds-host>:5432/hollis_workouts?sslmode=require&connection_limit=20"

# DATABASE_SSL_CA (RDS global CA bundle)
aws secretsmanager put-secret-value \
  --secret-id hollis-prod/workouts/database-ssl-ca \
  --secret-string "$(curl -s https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem)"

# GOOGLE_APPLICATION_CREDENTIALS_JSON (GCP SA key)
aws secretsmanager put-secret-value \
  --secret-id hollis-prod/workouts/google-application-credentials-json \
  --secret-string "$(cat /path/to/gcp-sa-key.json)"

# GOOGLE_CLOUD_PROJECT
aws secretsmanager put-secret-value \
  --secret-id hollis-prod/workouts/google-cloud-project \
  --secret-string "hollis-prod"

# SENTRY_DSN (optional)
aws secretsmanager put-secret-value \
  --secret-id hollis-prod/workouts/sentry-dsn \
  --secret-string "https://...@....ingest.sentry.io/..."

# REVENUECAT_REST_API_KEY (optional)
aws secretsmanager put-secret-value \
  --secret-id hollis-prod/workouts/revenuecat-rest-api-key \
  --secret-string "sk_..."
```

### 4. Confirm ALB priority 200 is free

```bash
aws elbv2 describe-rules \
  --listener-arn <https-listener-arn> \
  --query 'Rules[*].Priority' \
  --output json
```

If priority 200 is taken, change `priority = 200` in `ecs.tf` before applying.

### 5. Supply required variables

```bash
# Create a gitignored tfvars file (or export as TF_VAR_* env vars):
cat > terraform.tfvars <<EOF
certificate_arn     = "arn:aws:acm:us-east-1:344345273019:certificate/<uuid>"
private_subnet_ids  = ["subnet-aaaa1111", "subnet-bbbb2222"]
identity_jwt_secret = "<shared-hs256-secret-identical-to-hollis-identity>"
EOF
```

### 6. Apply

```bash
cd infrastructure
terraform init    # first time only, or after provider changes
terraform plan    # review the diff
terraform apply
```

### 7. Add DNS record

After the service is healthy, create a CNAME (or alias) record:

```
workouts-api.hollis.health → hollis-prod-alb DNS name
```

---

## Non-Terraform Fallback (ops/ path)

`ops/ecs-task-def.json` + `ops/render-task-def.sh` let you register a task
definition directly via the AWS CLI without Terraform. Terraform is the source
of truth; use this path only for emergency re-registers or local testing.

See comments in both files for required env vars.
