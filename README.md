# Hollis Workouts Server

REST API backend for the Hollis Workouts mobile app. Replaces Firebase Firestore as the data persistence layer. Built with Express 5 + Prisma 7 + Postgres, deployed on ECS Fargate.

## Architecture

- **Auth**: All authorization delegated to [Hollis Identity Service](../hollis-identity/). This server does not store credentials or issue tokens — it only validates JWTs issued by Identity.
- **Data**: 12 user-scoped collections (gyms, programs, sessions, baselines, etc.) + read-only canonical exercise catalog.
- **Mobile client**: [Hollis-Workouts](../Hollis-Workouts/) (React Native / Expo).

## Shared Dependencies

Uses `@hollis/contracts` and `@hollis/auth-client` from the sibling [hollis-shared](https://github.com/idlandes04/hollis-shared) monorepo via `file:` refs. Local dev expects `hollis-shared/` checked out next to `workouts-server/` (e.g. both under `~/Documents/SRC/`). Docker builds clone hollis-shared at the pinned `HOLLIS_SHARED_REF` build arg as part of the build.

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

See `.env.example` for all required variables.

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start dev server with hot reload (tsx watch) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run start` | Start compiled production server |
| `npm run typecheck` | Type-check without emitting |
| `npm run prisma:generate` | Regenerate Prisma client |
| `npm run prisma:migrate` | Run pending migrations (dev) |

## Build Status

Bootstrap: W5a/W5b complete. CRUD routes: TODO(W5c). Exercise catalog seeding: TODO(W5d).
