import { normalizeKalshiOrderbook, roundPrice } from "../kalshi";
import type {
  MarketLike,
  NormalizedMarket,
  NormalizedOrderbook,
  NormalizedOrderBookSnapshot,
  OrderbookValidationFlags,
  PriceLevel
} from "../types";

export interface NormalizedOrderbookBuildOptions {
  capturedAt?: Date;
  fallbackContracts?: number;
}

export interface NormalizedBinaryDetectorInput {
  market: MarketLike;
  orderbook: NormalizedOrderbook;
}

export interface NormalizedMarketSnapshotInput {
  market: MarketLike;
  orderbook: NormalizedOrderbook | null;
  validationFlags?: Partial<OrderbookValidationFlags>;
}

export function buildNormalizedBinaryDetectorInput(
  market: NormalizedMarket,
  snapshots: NormalizedOrderBookSnapshot[] = [],
  options: NormalizedOrderbookBuildOptions = {}
): NormalizedBinaryDetectorInput {
  return {
    market: normalizedMarketToMarketLike(market),
    orderbook: normalizedSnapshotsToOrderbook(market.marketId, snapshots, options) ?? normalizedMarketToOrderbook(market, options)
  };
}

export function buildNormalizedMarketSnapshotInput(
  market: NormalizedMarket,
  snapshots: NormalizedOrderBookSnapshot[] = [],
  options: NormalizedOrderbookBuildOptions & { validationFlags?: Partial<OrderbookValidationFlags> } = {}
): NormalizedMarketSnapshotInput {
  return {
    market: normalizedMarketToMarketLike(market),
    orderbook: normalizedSnapshotsToOrderbook(market.marketId, snapshots, options) ?? normalizedMarketToOrderbook(market, options),
    validationFlags: options.validationFlags
  };
}

export function normalizedMarketToMarketLike(market: NormalizedMarket): MarketLike {
  const raw = readRecord(market.raw);
  return {
    id: market.marketId,
    platform: market.platform,
    ticker: market.marketId,
    eventTicker: readString(raw?.event_ticker) ?? readString(raw?.eventTicker) ?? null,
    title: market.title,
    resolutionRules: [readString(raw?.rules_primary), readString(raw?.rules_secondary)].filter(Boolean).join("\n") || null,
    status: normalizedStatusToDetectorStatus(market.status),
    closeTime: parseDate(market.closeTime)
  };
}

export function normalizedSnapshotsToOrderbook(
  marketId: string,
  snapshots: NormalizedOrderBookSnapshot[],
  options: NormalizedOrderbookBuildOptions = {}
): NormalizedOrderbook | null {
  const marketSnapshots = snapshots.filter((snapshot) => snapshot.marketId === marketId);
  const rawSnapshot = marketSnapshots.find((snapshot) => snapshot.platform === "kalshi" && snapshot.raw !== undefined);
  if (rawSnapshot) {
    return normalizeKalshiOrderbook(marketId, rawSnapshot.raw, parseDate(rawSnapshot.capturedAt) ?? options.capturedAt ?? new Date());
  }

  if (marketSnapshots.length === 0) {
    return null;
  }

  const capturedAt =
    options.capturedAt ??
    latestCapturedAt(marketSnapshots.map((snapshot) => parseDate(snapshot.capturedAt)).filter((value): value is Date => value !== null)) ??
    new Date();
  const fallbackContracts = options.fallbackContracts ?? 0;
  const yesSnapshot = marketSnapshots.find((snapshot) => snapshot.outcomeId !== "no");
  const noSnapshot = marketSnapshots.find((snapshot) => snapshot.outcomeId === "no");
  const bestYesBid = finitePrice(yesSnapshot?.bestBid);
  const bestYesAsk = finitePrice(yesSnapshot?.bestAsk);
  const bestNoBid = finitePrice(noSnapshot?.bestBid);
  const bestNoAsk = finitePrice(noSnapshot?.bestAsk);

  return {
    platform: marketSnapshots[0]?.platform ?? "kalshi",
    marketTicker: marketId,
    capturedAt,
    bestYesBid,
    bestYesAsk,
    bestNoBid,
    bestNoAsk,
    spread: bestYesBid === null || bestYesAsk === null ? null : roundPrice(bestYesAsk - bestYesBid),
    yesBids: priceLevel(bestYesBid, fallbackContracts),
    noBids: priceLevel(bestNoBid, fallbackContracts),
    yesAsks: priceLevel(bestYesAsk, fallbackContracts),
    noAsks: priceLevel(bestNoAsk, fallbackContracts),
    rawJson: { source: "normalized_snapshots", snapshots: marketSnapshots }
  };
}

export function normalizedMarketToOrderbook(
  market: NormalizedMarket,
  options: NormalizedOrderbookBuildOptions = {}
): NormalizedOrderbook {
  const yes = market.outcomes.find((outcome) => outcome.outcomeId.toLowerCase() === "yes");
  const no = market.outcomes.find((outcome) => outcome.outcomeId.toLowerCase() === "no");
  const yesContracts = readContracts(yes?.liquidity, yes?.volume, options.fallbackContracts);
  const noContracts = readContracts(no?.liquidity, no?.volume, options.fallbackContracts);
  const bestYesBid = finitePrice(yes?.yesBid);
  const bestYesAsk = finitePrice(yes?.yesAsk);
  const bestNoBid = finitePrice(no?.yesBid ?? no?.noBid);
  const bestNoAsk = finitePrice(no?.yesAsk ?? no?.noAsk);

  return {
    platform: market.platform,
    marketTicker: market.marketId,
    capturedAt: options.capturedAt ?? new Date(),
    bestYesBid,
    bestYesAsk,
    bestNoBid,
    bestNoAsk,
    spread: bestYesBid === null || bestYesAsk === null ? null : roundPrice(bestYesAsk - bestYesBid),
    yesBids: priceLevel(bestYesBid, yesContracts),
    noBids: priceLevel(bestNoBid, noContracts),
    yesAsks: priceLevel(bestYesAsk, yesContracts),
    noAsks: priceLevel(bestNoAsk, noContracts),
    rawJson: { source: "normalized_market", market }
  };
}

function normalizedStatusToDetectorStatus(status: NormalizedMarket["status"]): string {
  switch (status) {
    case "active":
      return "open";
    case "closed":
    case "settled":
      return status;
    default:
      return "unknown";
  }
}

function parseDate(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function latestCapturedAt(values: Date[]): Date | null {
  if (values.length === 0) {
    return null;
  }
  return new Date(Math.max(...values.map((value) => value.getTime())));
}

function readContracts(...values: Array<number | undefined>): number {
  const value = values.find((candidate) => Number.isFinite(candidate) && candidate !== undefined && candidate > 0);
  return value ?? 0;
}

function finitePrice(value: number | undefined): number | null {
  return Number.isFinite(value) && value !== undefined ? roundPrice(value) : null;
}

function priceLevel(price: number | null, contracts: number): PriceLevel[] {
  return price === null || contracts <= 0 ? [] : [{ price, contracts }];
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
