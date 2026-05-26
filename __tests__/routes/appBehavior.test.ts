/**
 * App-level behavior tests (createApp factory) — added in the Round 1 audit.
 *
 * Covers the cross-cutting middleware wired in src/app.ts:
 *   - 404 catch-all returns the JSON { ok:false, err:NOT_FOUND } envelope
 *     (not Express's default HTML)
 *   - Security headers present on every response
 *   - X-Request-Id echoed (and honored from an inbound header)
 *   - Health endpoints bypass auth (and rate limiting)
 *   - x-powered-by is suppressed
 */

import { describe, it, expect, beforeAll } from "vitest";
import type { Express } from "express";
import type { SuperTest, Test } from "supertest";
import { buildApp, authedAgent, anonAgent } from "../helpers/setup.js";

let app: Express;
let auth: SuperTest<Test>;
let anon: SuperTest<Test>;

beforeAll(async () => {
  app = await buildApp();
  auth = await authedAgent(app);
  anon = await anonAgent(app);
});

describe("404 catch-all", () => {
  it("returns the JSON error envelope for an unmatched top-level route", async () => {
    const res = await anon.get("/no-such-route");
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.err.code).toBe("NOT_FOUND");
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });

  it("returns the JSON error envelope for an unmatched /v1 route", async () => {
    const res = await auth.get("/v1/not-a-resource");
    expect(res.status).toBe(404);
    expect(res.body.err.code).toBe("NOT_FOUND");
  });
});

describe("security headers", () => {
  it("sets hardening headers on responses", async () => {
    const res = await anon.get("/healthz");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["strict-transport-security"]).toContain("max-age=");
  });

  it("suppresses x-powered-by", async () => {
    const res = await anon.get("/healthz");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});

describe("request id", () => {
  it("echoes a generated X-Request-Id when none is supplied", async () => {
    const res = await anon.get("/healthz");
    expect(res.headers["x-request-id"]).toBeDefined();
    expect(res.headers["x-request-id"].length).toBeGreaterThan(0);
  });

  it("honors an inbound X-Request-Id", async () => {
    const res = await anon.get("/healthz").set("X-Request-Id", "trace-abc-123");
    expect(res.headers["x-request-id"]).toBe("trace-abc-123");
  });
});

describe("health endpoints bypass auth", () => {
  it("GET /healthz returns 200 without an Authorization header", async () => {
    const res = await anon.get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
