/**
 * Vitest configuration for hollis-workouts-server.
 *
 * ESM-native project (type: "module") running under tsx.
 * Key decisions:
 *   - pool: "forks" — avoids the shared-module-state problem that "threads"
 *     has with vi.mock hoisting in ESM projects.  Each test file gets its own
 *     Node.js subprocess; module mocks are isolated per worker.
 *   - setupFiles — runs __tests__/helpers/setup.ts in every worker before
 *     test files load.  This registers vi.mock() for Prisma and auth so that
 *     any static import in route files gets the mocked version.
 *   - env — fake values satisfy lib/env.ts (Zod validation) without a real DB
 *     or Identity Service.  NODE_ENV=test causes rate limiters to no-op.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    include: ["__tests__/**/*.test.ts"],
    setupFiles: ["__tests__/helpers/setup.ts"],
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      IDENTITY_SERVICE_URL: "http://localhost:3001",
      IDENTITY_JWT_SECRET: "test-secret-at-least-32-characters-long",
      AUDIENCE: "hollis-workouts",
      PORT: "3002",
      LOG_LEVEL: "error",
    },
    testTimeout: 5000,
  },
});
