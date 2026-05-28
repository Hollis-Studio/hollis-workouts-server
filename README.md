# Hollis Workouts Server

REST API backend for the Hollis Workouts mobile app. Replaces Firebase Firestore as the data persistence layer. Built with Express 5 + Prisma 7 + Postgres, deployed on ECS Fargate.

## Tech Stack

| Layer                | Version                            |
| -------------------- | ---------------------------------- |
| Node.js              | 20 (Docker base: `node:20-alpine`) |
| Express              | 5.2.1                              |
| Prisma client        | 7.6.0                              |
| `@prisma/adapter-pg` | 7.8.0                              |
| TypeScript           | 5.9.2                              |
| Zod                  | 4.3.6                              |
| Pino                 | 10                                 |

Prisma uses the `PrismaPg` driver adapter (native `pg` Pool) — not the default connector — to support connection pooling on Fargate.

## Architecture

- **Auth**: All authorization delegated to [Hollis Identity Service](../hollis-identity/). This server does not store credentials or issue tokens — it only validates JWTs issued by Identity.
- **Data**: 12 user-scoped models (gyms, programs, sessions, baselines, etc.) + read-only canonical exercise catalog (`CanonicalExercise`).
- **Mobile client**: [Hollis-Workouts](../Hollis-Workouts/) (React Native / Expo).

## Shared Dependencies

Uses `@hollis-studio/contracts` and `@hollis-studio/auth-client` from GitHub Packages. Local development should authenticate npm to the Hollis Studio package registry before installing dependencies.

Distribution rationale and the alternatives considered are documented in [hollis-shared/docs/2026-05-13-shared-deps-distribution.md](https://github.com/idlandes04/hollis-shared/blob/main/docs/2026-05-13-shared-deps-distribution.md).

## Quick Start

```bash
# Assumes hollis-shared is checked out at ../hollis-shared
cp .env.example .env
# Edit .env with your DATABASE_URL and IDENTITY_JWT_SECRET
npm install
npm run prisma:generate
npm run prisma:migrate   # requires a running Postgres instance
npm run dev
```

## Environment Variables

| Variable               | Required | Default                       | Description                                     |
| ---------------------- | -------- | ----------------------------- | ----------------------------------------------- |
| `DATABASE_URL`         | yes      | —                             | PostgreSQL connection string                    |
| `IDENTITY_JWT_SECRET`  | yes      | —                             | Shared HS256 secret for JWT verification        |
| `IDENTITY_SERVICE_URL` | yes      | `http://localhost:3001`       | URL of the Hollis Identity Service              |
| `AUDIENCE`             | no       | `hollis-workouts`             | Expected `aud` claim in incoming JWTs           |
| `PORT`                 | no       | `3002`                        | HTTP port the server listens on                 |
| `NODE_ENV`             | no       | `development`                 | `development` \| `test` \| `production`         |
| `LOG_LEVEL`            | no       | `info` (prod) / `debug` (dev) | `debug` \| `info` \| `warn` \| `error`          |
| `LOG_DB_QUERIES`       | no       | `false`                       | Set `true` to log Prisma queries at debug level |

See `.env.example` for a copy-paste template. Production secrets are injected from AWS Secrets Manager under `hollis-prod/workouts/*`.

## API Surface

### Health (unauthenticated)

| Method | Path       | Description                                                  |
| ------ | ---------- | ------------------------------------------------------------ |
| `GET`  | `/healthz` | Liveness probe — always 200 if process is running            |
| `GET`  | `/readyz`  | Readiness probe — checks DB connectivity, 503 if unreachable |

### Resource routes (`/v1/*`, require JWT)

All routes below require a valid Identity Service JWT (`Authorization: Bearer <token>`).
All CRUD handlers are fully implemented (user-scoped, IDOR-safe, cursor-paginated).

| Prefix                             | Resource                               |
| ---------------------------------- | -------------------------------------- |
| `/v1/gyms`                         | Gym profiles                           |
| `/v1/programs`                     | Training programs                      |
| `/v1/sessions`                     | Training session logs                  |
| `/v1/progression-baselines`        | Strength progression baselines         |
| `/v1/cardio-baselines`             | Cardio baselines                       |
| `/v1/gym-exercise-instances`       | Per-gym equipment/exercise config      |
| `/v1/user-exercises`               | User-created exercises                 |
| `/v1/exercise-aliases`             | Exercise name aliases                  |
| `/v1/weeks`                        | Weekly summary documents               |
| `/v1/ai-audit-log`                 | AI suggestion audit log                |
| `/v1/injuries`                     | Injury records                         |
| `/v1/conversation-rolling-summary` | Singleton rolling summary per user     |
| `/v1/exercises`                    | Canonical exercise catalog (read-only) |

## Middleware

| Middleware       | Scope         | Notes                                                                 |
| ---------------- | ------------- | --------------------------------------------------------------------- |
| `express.json`   | Global        | 2 MB body limit                                                       |
| `apiRateLimiter` | Global        | 100 req/min per IP; skipped in test env                               |
| `requireAuth`    | `/v1/*`       | Verifies Identity Service JWT, sets `req.userId`                      |
| `errorHandler`   | Global (last) | Maps `AppError`, Prisma errors, malformed JSON, 413 to JSON responses |

## Scripts

| Script                          | Description                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| `npm run dev`                   | Start dev server with hot reload (tsx watch)                                           |
| `npm run build`                 | Compile TypeScript to `dist/`                                                          |
| `npm run start`                 | Start compiled production server                                                       |
| `npm run typecheck`             | Type-check without emitting                                                            |
| `npm run prisma:generate`       | Regenerate Prisma client                                                               |
| `npm run prisma:migrate`        | Create + apply a migration (dev only)                                                  |
| `npm run prisma:migrate:deploy` | Apply existing migrations (production-safe)                                            |
| `npm run prisma:seed`           | Seed the canonical exercise catalog (needs the sibling `hollis-workouts` repo present) |

## Deployment

Deployed on AWS ECS Fargate behind `https://workouts-api.hollis.health`. Verified 2026-05-27: ECS service `hollis-workouts-server` on `hollis-prod-cluster`, desired/running `2/2`, healthy ALB targets on port `3002`, `/healthz` 200, `/readyz` 200 with Postgres connected. Logs ship to CloudWatch at `/ecs/hollis-workouts-server` in `us-east-1`; container images live in ECR repository `hollis-workouts-server`; secrets are injected from AWS Secrets Manager.

## Build Status

| Milestone                                                             | Status                                                                                              |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| W5a/W5b: Bootstrap (Express, Prisma, auth, health checks, middleware) | Complete                                                                                            |
| W5c: CRUD route handlers for all 13 resources + read-only catalog     | Complete                                                                                            |
| W5d: Canonical exercise catalog seeding                               | Seed script ready (`prisma:seed`)                                                                   |
| W5e: Production ECS deployment                                        | Complete — ECS service healthy as of 2026-05-27                                                     |
| Initial Prisma migration                                              | Applied/operational in deployed Postgres path; keep migration history current before future deploys |
