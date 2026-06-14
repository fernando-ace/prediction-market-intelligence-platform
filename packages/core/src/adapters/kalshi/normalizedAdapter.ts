import type {
  MarketFetchOptions,
  MarketFetchResult,
  PredictionMarketAdapter
} from "../../adapters";
import type { KalshiReadOnlyAdapter } from "../../kalshi";
import { normalizeKalshiMarket, normalizeKalshiOrderBookSnapshot } from "./normalize";

type ReadOnlyKalshiClient = Pick<KalshiReadOnlyAdapter, "fetchOpenMarkets" | "fetchOrderbook">;

export class NormalizedKalshiAdapter implements PredictionMarketAdapter {
  readonly platform = "kalshi" as const;

  constructor(private readonly kalshi: ReadOnlyKalshiClient) {}

  async fetchMarkets(options: MarketFetchOptions = {}): Promise<MarketFetchResult> {
    if (options.cursor) {
      throw new Error("NormalizedKalshiAdapter does not support caller-supplied cursors yet; nextCursor is undefined.");
    }

    const limit = normalizeLimit(options.limit);
    const result = await this.kalshi.fetchOpenMarkets(limit);
    if (!result.ok || !result.data) {
      throw new Error(result.error ?? "Kalshi market fetch failed.");
    }

    const markets = result.data
      .filter((market) => options.includeClosed || normalizeStatus(market.status) === "open")
      .slice(0, limit)
      .map(normalizeKalshiMarket);

    return {
      markets
      // The current KalshiReadOnlyAdapter consumes Kalshi pagination internally
      // and does not expose a resumable cursor, so nextCursor is intentionally
      // omitted until normalized pagination is introduced.
    };
  }

  async fetchOrderBookSnapshot(marketId: string, outcomeId?: string) {
    const result = await this.kalshi.fetchOrderbook(marketId);
    if (!result.ok || !result.data) {
      throw new Error(result.error ?? `Kalshi orderbook fetch failed for ${marketId}.`);
    }

    return normalizeKalshiOrderBookSnapshot(result.data, normalizeOutcomeId(outcomeId));
  }
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return 100;
  }

  if (!Number.isFinite(limit) || limit <= 0) {
    return 0;
  }

  return Math.floor(limit);
}

function normalizeOutcomeId(outcomeId: string | undefined): "yes" | "no" | undefined {
  if (outcomeId === undefined) {
    return undefined;
  }

  if (outcomeId === "yes" || outcomeId === "no") {
    return outcomeId;
  }

  throw new Error(`NormalizedKalshiAdapter only supports Kalshi outcome IDs "yes" and "no"; received "${outcomeId}".`);
}

function normalizeStatus(status: unknown): string {
  return typeof status === "string" ? status.toLowerCase() : "";
}
