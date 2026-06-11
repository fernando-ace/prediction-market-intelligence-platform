ALTER TABLE "Market" ADD COLUMN "eventTicker" TEXT;

CREATE TABLE "RelatedMarketGroup" (
    "id" TEXT NOT NULL,
    "groupKey" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "eventTicker" TEXT,
    "marketCount" INTEGER NOT NULL,
    "marketTickers" JSONB NOT NULL,
    "marketTitles" JSONB NOT NULL,
    "closeTimes" JSONB NOT NULL,
    "closeTimeSpreadSeconds" INTEGER,
    "groupingReason" TEXT NOT NULL,
    "confidenceScore" DECIMAL(10,6) NOT NULL,
    "eligible" BOOLEAN NOT NULL,
    "eligibilityReason" TEXT NOT NULL,
    "warnings" JSONB,
    "latestSnapshotTime" TIMESTAMP(3),
    "totalYesAskCost" DECIMAL(10,6),
    "grossEdge" DECIMAL(10,6),
    "estimatedFees" DECIMAL(10,6),
    "netEdge" DECIMAL(10,6),
    "validationFlags" JSONB,
    "rawJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RelatedMarketGroup_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RelatedMarketGroupMarket" (
    "id" TEXT NOT NULL,
    "relatedGroupId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "marketTicker" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,

    CONSTRAINT "RelatedMarketGroupMarket_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Signal" ADD COLUMN "relatedGroupId" TEXT;
ALTER TABLE "PaperTrade" ADD COLUMN "relatedGroupId" TEXT;
ALTER TABLE "PaperFill" ADD COLUMN "marketId" TEXT;
ALTER TABLE "PaperFill" ADD COLUMN "marketTicker" TEXT;
ALTER TABLE "PaperFill" ADD COLUMN "legRole" TEXT;

CREATE UNIQUE INDEX "RelatedMarketGroup_platform_groupKey_key" ON "RelatedMarketGroup"("platform", "groupKey");
CREATE INDEX "RelatedMarketGroup_platform_eligible_idx" ON "RelatedMarketGroup"("platform", "eligible");
CREATE INDEX "RelatedMarketGroup_eventTicker_idx" ON "RelatedMarketGroup"("eventTicker");
CREATE UNIQUE INDEX "RelatedMarketGroupMarket_relatedGroupId_marketId_key" ON "RelatedMarketGroupMarket"("relatedGroupId", "marketId");
CREATE INDEX "RelatedMarketGroupMarket_marketId_idx" ON "RelatedMarketGroupMarket"("marketId");
CREATE INDEX "RelatedMarketGroupMarket_platform_marketTicker_idx" ON "RelatedMarketGroupMarket"("platform", "marketTicker");
CREATE INDEX "Market_platform_eventTicker_idx" ON "Market"("platform", "eventTicker");
CREATE INDEX "Signal_relatedGroupId_detectedAt_idx" ON "Signal"("relatedGroupId", "detectedAt");
CREATE INDEX "PaperTrade_relatedGroupId_createdAt_idx" ON "PaperTrade"("relatedGroupId", "createdAt");
CREATE INDEX "PaperFill_marketId_idx" ON "PaperFill"("marketId");

ALTER TABLE "RelatedMarketGroupMarket" ADD CONSTRAINT "RelatedMarketGroupMarket_relatedGroupId_fkey" FOREIGN KEY ("relatedGroupId") REFERENCES "RelatedMarketGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RelatedMarketGroupMarket" ADD CONSTRAINT "RelatedMarketGroupMarket_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_relatedGroupId_fkey" FOREIGN KEY ("relatedGroupId") REFERENCES "RelatedMarketGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PaperTrade" ADD CONSTRAINT "PaperTrade_relatedGroupId_fkey" FOREIGN KEY ("relatedGroupId") REFERENCES "RelatedMarketGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PaperFill" ADD CONSTRAINT "PaperFill_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE SET NULL ON UPDATE CASCADE;
