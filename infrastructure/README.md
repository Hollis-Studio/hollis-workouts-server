# Infrastructure

> **Status:** Infrastructure-as-Code has not yet been written for this service.
> The notes below describe what is configured and what still needs to be done, based on the actual files in the repo.

## What exists today

### ECS task definition (`ops/ecs-task-def.json`)

A **placeholder** task definition is checked in. It is not yet deployed and contains placeholder values that must be filled in before use.

| Field | Value |
|---|---|
| Task family | `hollis-workouts-server` |
| Launch type | AWS Fargate |
| Network mode | `awsvpc` |
| CPU / memory | 256 CPU units / 512 MiB |
| Container name | `workouts-server` |
| Container port | **3002** (TCP) |
| Log driver | `awslogs` → CloudWatch log group `/ecs/hollis-workouts-server`, region `us-east-1`, prefix `ecs` |
| Image | <!-- UNVERIFIED: placeholder `PLACEHOLDER_ECR_IMAGE_URI` — real ECR repository URI not yet provisioned --> |

**Environment variables injected at runtime:**

| Variable | Source |
|---|---|
| `NODE_ENV` | Hardcoded `production` in task definition |
| `PORT` | Hardcoded `3002` in task definition |
| `AUDIENCE` | Hardcoded `hollis-workouts` in task definition |
| `DATABASE_URL` | AWS SSM Parameter Store secret <!-- UNVERIFIED: SSM ARN not yet provisioned → still `PLACEHOLDER_SSM_ARN` --> |
| `IDENTITY_JWT_SECRET` | AWS SSM Parameter Store secret <!-- UNVERIFIED: SSM ARN not yet provisioned → still `PLACEHOLDER_SSM_ARN` --> |
| `IDENTITY_SERVICE_URL` | AWS SSM Parameter Store secret <!-- UNVERIFIED: SSM ARN not yet provisioned → still `PLACEHOLDER_SSM_ARN` --> |

Additional variables validated by the server at startup (see `src/lib/env.ts`) but **not** yet present in the task definition:

- `LOG_LEVEL` — defaults to `"info"` if absent
- `LOG_DB_QUERIES` — optional, enables verbose Prisma query logging when `"true"`

### Dockerfile (multi-stage build)

A production Dockerfile lives at the repo root. It uses four stages:

| Stage | Base image | Purpose |
|---|---|---|
| `hollis-shared` | `node:20-alpine` | Clones and builds the `hollis-shared` monorepo (provides `@hollis/contracts` and `@hollis/auth-client`) |
| `deps` | `node:20-alpine` | Installs production-only dependencies (`npm ci --omit=dev`) |
| `build` | `node:20-alpine` | Compiles TypeScript (`tsc`), generates Prisma client |
| `runner` | `node:20-alpine` | Lean production image; copies `dist/`, `node_modules/`, `prisma/`, and the built `hollis-shared` tree |

The `hollis-shared` branch/tag is controlled by the `HOLLIS_SHARED_REF` build arg (defaults to `main`).

The final image exposes port **3002** and runs `node dist/index.js`.

### Database

- **PostgreSQL** via [Prisma 7](https://www.prisma.io/) with the `@prisma/adapter-pg` driver adapter.
- Prisma uses a `pg.Pool` directly; SSL (`rejectUnauthorized: false`) is enabled when `NODE_ENV=production`.
- 13 Prisma models (12 user-scoped synced collections + `CanonicalExercise` global catalog) — see `prisma/schema.prisma` for the full schema.
- <!-- UNVERIFIED: The actual PostgreSQL instance (RDS, Aurora, or otherwise) has not been provisioned; no connection details are available in the codebase. -->

## What does NOT exist yet

- **IaC (Terraform / CDK):** No Terraform modules or CDK stacks are present in this repo. The `infrastructure/` directory is currently empty except for this file. <!-- UNVERIFIED: A sibling infra repo may exist (the task definition comment references `hollis-health-app/server/ops/ecs-task-def.json`) but has not been confirmed. -->
- **CI/CD pipeline:** No GitHub Actions workflows, `buildspec.yml`, or other CI/CD configs exist in this repo. Build and deploy automation must be added.
- **ECS cluster, VPC, ALB, security groups:** Not provisioned; no configuration exists in this repo.
- **ECR repository:** Not provisioned; image URI is a placeholder.
- **SSM parameters:** Not provisioned; all `valueFrom` fields in the task definition are placeholders.

## Outstanding TODOs (from codebase)

- `TODO(W5e)`: Replace `ops/ecs-task-def.json` with real values mirroring `hollis-health-app` infrastructure; add Terraform modules.
- `TODO(W5d)`: Seed `CanonicalExercise` catalog from Firestore exercises export.
- `TODO(W5f)`: Add admin write endpoint if catalog needs server-side updates.
