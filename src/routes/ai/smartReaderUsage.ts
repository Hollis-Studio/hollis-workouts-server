/**
 * @ai-context GET /ai/smart-reader-usage — current month Smart Reader usage for the caller.
 *
 * Response shape: { used: number, limit: number, remaining: number }
 *   - used:      number of Smart Reader calls made this calendar month (non-entitled path).
 *   - limit:     SMART_READER_FREE_USES env var (default 5).
 *   - remaining: Math.max(0, limit - used).
 *
 * Entitled users (hollisIntelligence) always receive { used: 0, limit, remaining: limit }
 * because the counter is never incremented for them.
 *
 * The app team should call this endpoint to render the Smart Reader usage UI
 * and to decide whether to show the paywall before the 429 fires.
 *
 * deps: lib/AppError, middleware/errorHandler, middleware/entitlement,
 *       services/ai/smartReaderUsage, utils/response, lib/env
 * consumers: src/routes/ai/index.ts
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { AppError } from "../../lib/AppError.js";
import { asyncWrapper } from "../../middleware/errorHandler.js";
import { checkHollisIntelligence } from "../../middleware/entitlement.js";
import { env } from "../../lib/env.js";
import { sendSuccess } from "../../utils/response.js";
import { getSmartReaderUsage } from "../../services/ai/smartReaderUsage.js";

export const smartReaderUsageRouter = Router();

smartReaderUsageRouter.get(
  "/",
  asyncWrapper(async (req: Request, res: Response): Promise<void> => {
    if (!req.userId) throw AppError.unauthorized();

    const entitled = await checkHollisIntelligence(req.userId);
    if (entitled) {
      const limit = env.SMART_READER_FREE_USES;
      return sendSuccess(res, { used: 0, limit, remaining: limit });
    }

    const result = await getSmartReaderUsage(req.userId);
    if (!result.ok) {
      throw AppError.internal(result.error.message);
    }
    sendSuccess(res, result.data);
  }),
);
