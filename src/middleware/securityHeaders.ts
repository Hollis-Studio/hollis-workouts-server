/**
 * @ai-context Security response headers for Workouts Server.
 *
 * Dependency-free equivalent of the subset of `helmet` that matters for a
 * mobile-facing JSON API behind an ALB (TLS terminated at the ALB). We do not
 * pull in `helmet` because this server serves no HTML/browser surface — the few
 * headers that are meaningful are cheaper to set directly and easy to test.
 *
 * Headers set:
 *   - X-Content-Type-Options: nosniff      — block MIME sniffing
 *   - X-Frame-Options: DENY                — no framing (defense in depth)
 *   - Referrer-Policy: no-referrer         — never leak URLs
 *   - X-DNS-Prefetch-Control: off          — no speculative DNS
 *   - Strict-Transport-Security            — force HTTPS for 2y incl. subdomains
 *   - X-Permitted-Cross-Domain-Policies: none
 *
 * deps: express | consumers: src/app.ts
 */

import type { NextFunction, Request, Response } from "express";

const HSTS = "max-age=63072000; includeSubDomains";

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  res.setHeader("Strict-Transport-Security", HSTS);
  next();
}
