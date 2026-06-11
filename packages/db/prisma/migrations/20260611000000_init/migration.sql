CREATE TABLE "Market" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "externalMarketId" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "resolutionRules" TEXT,
    "category" TEXT,
    "status" TEXT NOT NULL,
    "closeTime" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Market_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrderbookSnapshot" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "bestYesBid" DECIMAL(10,6),
    "bestYesAsk" DECIMAL(10,6),
    "bestNoBid" DECIMAL(10,6),
    "bestNoAsk" DECIMAL(10,6),
    "spread" DECIMAL(10,6),
    "rawJson" JSONB NOT NULL,

    CONSTRAINT "OrderbookSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Signal" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL,
    "grossEdge" DECIMAL(10,6),
    "estimatedFees" DECIMAL(10,6) NOT NULL,
    "netEdge" DECIMAL(10,6),
    "maxContracts" DECIMAL(18,6) NOT NULL,
    "confidenceScore" DECIMAL(10,6) NOT NULL,
    "liquidityScore" DECIMAL(18,6) NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "rawJson" JSONB NOT NULL,

    CONSTRAINT "Signal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaperTrade" (
    "id" TEXT NOT NULL,
    "signalId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executionDelaySeconds" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "expectedNetEdge" DECIMAL(18,6),
    "realizedNetEdge" DECIMAL(18,6),
    "notes" TEXT,

    CONSTRAINT "PaperTrade_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaperFill" (
    "id" TEXT NOT NULL,
    "paperTradeId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "price" DECIMAL(10,6) NOT NULL,
    "contracts" DECIMAL(18,6) NOT NULL,
    "fees" DECIMAL(18,6) NOT NULL,
    "filledAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaperFill_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaperPosition" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "contracts" DECIMAL(18,6) NOT NULL,
    "averagePrice" DECIMAL(10,6) NOT NULL,
    "estimatedFees" DECIMAL(18,6) NOT NULL,
    "simulatedPnl" DECIMAL(18,6),
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaperPosition_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PortfolioSnapshot" (
    "id" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cashBalance" DECIMAL(18,6) NOT NULL,
    "totalPositionCost" DECIMAL(18,6) NOT NULL,
    "realizedPnl" DECIMAL(18,6) NOT NULL,
    "unrealizedPnl" DECIMAL(18,6) NOT NULL,
    "simulatedPnl" DECIMAL(18,6) NOT NULL,
    "rawJson" JSONB NOT NULL,

    CONSTRAINT "PortfolioSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RunLog" (
    "id" TEXT NOT NULL,
    "runType" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "marketsFetched" INTEGER NOT NULL DEFAULT 0,
    "snapshotsStored" INTEGER NOT NULL DEFAULT 0,
    "signalsCreated" INTEGER NOT NULL DEFAULT 0,
    "paperTradesCreated" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "error" TEXT,
    "rawJson" JSONB,

    CONSTRAINT "RunLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Market_platform_externalMarketId_key" ON "Market"("platform", "externalMarketId");
CREATE INDEX "Market_platform_status_idx" ON "Market"("platform", "status");
CREATE INDEX "Market_closeTime_idx" ON "Market"("closeTime");
CREATE INDEX "OrderbookSnapshot_marketId_capturedAt_idx" ON "OrderbookSnapshot"("marketId", "capturedAt");
CREATE INDEX "OrderbookSnapshot_platform_capturedAt_idx" ON "OrderbookSnapshot"("platform", "capturedAt");
CREATE INDEX "Signal_marketId_detectedAt_idx" ON "Signal"("marketId", "detectedAt");
CREATE INDEX "Signal_platform_strategy_status_idx" ON "Signal"("platform", "strategy", "status");
CREATE INDEX "PaperTrade_signalId_idx" ON "PaperTrade"("signalId");
CREATE INDEX "PaperTrade_marketId_createdAt_idx" ON "PaperTrade"("marketId", "createdAt");
CREATE INDEX "PaperTrade_status_idx" ON "PaperTrade"("status");
CREATE INDEX "PaperFill_paperTradeId_idx" ON "PaperFill"("paperTradeId");
CREATE INDEX "PaperFill_filledAt_idx" ON "PaperFill"("filledAt");
CREATE INDEX "PaperPosition_marketId_outcome_idx" ON "PaperPosition"("marketId", "outcome");
CREATE INDEX "PaperPosition_status_idx" ON "PaperPosition"("status");
CREATE INDEX "PortfolioSnapshot_capturedAt_idx" ON "PortfolioSnapshot"("capturedAt");
CREATE INDEX "RunLog_runType_startedAt_idx" ON "RunLog"("runType", "startedAt");
CREATE INDEX "RunLog_status_idx" ON "RunLog"("status");

ALTER TABLE "OrderbookSnapshot" ADD CONSTRAINT "OrderbookSnapshot_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaperTrade" ADD CONSTRAINT "PaperTrade_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaperTrade" ADD CONSTRAINT "PaperTrade_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaperFill" ADD CONSTRAINT "PaperFill_paperTradeId_fkey" FOREIGN KEY ("paperTradeId") REFERENCES "PaperTrade"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaperPosition" ADD CONSTRAINT "PaperPosition_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE CASCADE ON UPDATE CASCADE;
