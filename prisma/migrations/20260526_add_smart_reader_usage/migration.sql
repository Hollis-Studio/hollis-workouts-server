-- Migration: add_smart_reader_usage
-- Adds the SmartReaderUsage table for server-enforced monthly free-use counters
-- on the Smart Reader (equipment recognition) AI feature.
-- Non-entitled users are limited to SMART_READER_FREE_USES (default 5) calls per month.
-- Entitled users (hollisIntelligence RevenueCat entitlement) bypass this table entirely.

-- CreateTable
CREATE TABLE "smart_reader_usage" (
    "userId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "smart_reader_usage_pkey" PRIMARY KEY ("userId","month")
);

-- CreateIndex
CREATE INDEX "smart_reader_usage_userId_idx" ON "smart_reader_usage"("userId");
