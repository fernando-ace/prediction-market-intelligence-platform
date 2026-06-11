ALTER TABLE "RelatedMarketGroupMarket" ADD COLUMN "title" TEXT;
ALTER TABLE "RelatedMarketGroupMarket" ADD COLUMN "yesAsk" DECIMAL(10,6);
ALTER TABLE "RelatedMarketGroupMarket" ADD COLUMN "yesBid" DECIMAL(10,6);
ALTER TABLE "RelatedMarketGroupMarket" ADD COLUMN "noAsk" DECIMAL(10,6);
ALTER TABLE "RelatedMarketGroupMarket" ADD COLUMN "noBid" DECIMAL(10,6);
ALTER TABLE "RelatedMarketGroupMarket" ADD COLUMN "closeTime" TIMESTAMP(3);
