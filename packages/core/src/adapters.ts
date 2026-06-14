import type { NormalizedMarket, NormalizedOrderBookSnapshot } from "./types";

export interface MarketFetchOptions {
  limit?: number;
  cursor?: string;
  includeClosed?: boolean;
}

export interface MarketFetchResult {
  markets: NormalizedMarket[];
  nextCursor?: string;
}

export interface PredictionMarketAdapter {
  platform: "kalshi" | "polymarket";
  fetchMarkets(options?: MarketFetchOptions): Promise<MarketFetchResult>;
  fetchOrderBookSnapshot(
    marketId: string,
    outcomeId?: string
  ): Promise<NormalizedOrderBookSnapshot | NormalizedOrderBookSnapshot[]>;
}
