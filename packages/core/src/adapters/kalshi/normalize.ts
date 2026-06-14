import type { KalshiMarket } from "../../kalshi";
import { roundPrice } from "../../kalshi";
import type { NormalizedMarket, NormalizedMarketStatus, NormalizedOrderbook, NormalizedOrderBookSnapshot } from "../../types";

export function normalizeKalshiMarket(rawMarket: KalshiMarket): NormalizedMarket {
  return {
    platform: "kalshi",
    marketId: rawMarket.ticker,
    title: rawMarket.title ?? rawMarket.subtitle ?? rawMarket.ticker,
    category: readOptionalString(rawMarket.category),
    closeTime: readOptionalString(rawMarket.close_time),
    status: normalizeKalshiMarketStatus(rawMarket.status),
    outcomes: [
      {
        outcomeId: "yes",
        label: "YES",
        yesBid: readMarketPrice(rawMarket, ["yes_bid_dollars", "yes_bid"]),
        yesAsk: readMarketPrice(rawMarket, ["yes_ask_dollars", "yes_ask"]),
        lastPrice: readMarketPrice(rawMarket, ["last_price_dollars", "last_price"]),
        volume: readMarketNumber(rawMarket, ["volume_fp", "volume", "volume_24h_fp"]),
        liquidity: readMarketNumber(rawMarket, ["liquidity_dollars", "liquidity"])
      },
      {
        outcomeId: "no",
        label: "NO",
        yesBid: readMarketPrice(rawMarket, ["no_bid_dollars", "no_bid"]),
        yesAsk: readMarketPrice(rawMarket, ["no_ask_dollars", "no_ask"]),
        volume: readMarketNumber(rawMarket, ["volume_fp", "volume", "volume_24h_fp"]),
        liquidity: readMarketNumber(rawMarket, ["liquidity_dollars", "liquidity"])
      }
    ],
    raw: rawMarket
  };
}

export function normalizeKalshiOrderBookSnapshot(
  orderbook: NormalizedOrderbook,
  outcomeId?: "yes" | "no"
): NormalizedOrderBookSnapshot {
  const bestBid = outcomeId === "no" ? orderbook.bestNoBid : orderbook.bestYesBid;
  const bestAsk = outcomeId === "no" ? orderbook.bestNoAsk : orderbook.bestYesAsk;
  const spread = bestBid === null || bestAsk === null ? undefined : roundPrice(bestAsk - bestBid);
  const midpoint = bestBid === null || bestAsk === null ? undefined : roundPrice((bestBid + bestAsk) / 2);

  return {
    platform: "kalshi",
    marketId: orderbook.marketTicker,
    outcomeId,
    capturedAt: orderbook.capturedAt.toISOString(),
    bestBid: bestBid ?? undefined,
    bestAsk: bestAsk ?? undefined,
    spread,
    midpoint,
    raw: orderbook.rawJson
  };
}

function normalizeKalshiMarketStatus(status: unknown): NormalizedMarketStatus {
  if (typeof status !== "string") {
    return "unknown";
  }

  switch (status.toLowerCase()) {
    case "open":
    case "active":
      return "active";
    case "closed":
    case "close":
      return "closed";
    case "settled":
    case "resolved":
    case "finalized":
      return "settled";
    default:
      return "unknown";
  }
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readMarketPrice(market: KalshiMarket, keys: string[]): number | undefined {
  return readMarketNumber(market, keys, true);
}

function readMarketNumber(market: KalshiMarket, keys: string[], normalizeCents = false): number | undefined {
  for (const key of keys) {
    const value = market[key];
    const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
    if (Number.isFinite(parsed)) {
      return normalizeCents && parsed > 1 ? roundPrice(parsed / 100) : roundPrice(parsed);
    }
  }

  return undefined;
}
