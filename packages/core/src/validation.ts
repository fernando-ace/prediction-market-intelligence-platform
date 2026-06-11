import { roundPrice } from "./kalshi";
import type {
  NormalizedOrderbook,
  OrderbookValidationFlag,
  OrderbookValidationFlags,
  OrderbookValidationResult,
  PriceLevel
} from "./types";

export const validationFlagNames: OrderbookValidationFlag[] = [
  "missing_yes_book",
  "missing_no_book",
  "empty_orderbook",
  "crossed_or_invalid_prices",
  "negative_spread",
  "stale_snapshot",
  "low_liquidity",
  "parse_warning"
];

export interface OrderbookValidationOptions {
  minLiquidityContracts: number;
  staleAfterSeconds?: number;
  now?: Date;
}

export function validateOrderbookSnapshot(
  orderbook: NormalizedOrderbook,
  options: OrderbookValidationOptions
): OrderbookValidationResult {
  const rawArrays = getKalshiRawBidArrays(orderbook.rawJson);
  const liquidityUsedByDetector = Math.min(totalContracts(orderbook.yesAsks), totalContracts(orderbook.noAsks));
  const warnings: string[] = [];
  const flags = emptyFlags();
  const now = options.now ?? new Date();
  const staleAfterSeconds = options.staleAfterSeconds ?? 300;

  flags.missing_yes_book = rawArrays.yes.length === 0;
  flags.missing_no_book = rawArrays.no.length === 0;
  flags.empty_orderbook = rawArrays.yes.length === 0 && rawArrays.no.length === 0;
  flags.low_liquidity = liquidityUsedByDetector < options.minLiquidityContracts;
  flags.stale_snapshot = now.getTime() - orderbook.capturedAt.getTime() > staleAfterSeconds * 1000;
  flags.negative_spread = orderbook.spread !== null && orderbook.spread < 0;

  const invalidRawLevels = [...rawArrays.yes, ...rawArrays.no].filter((level) => !isValidRawLevel(level));
  if (invalidRawLevels.length > 0) {
    flags.parse_warning = true;
    warnings.push(`${invalidRawLevels.length} raw price level(s) could not be parsed.`);
  }

  if (rawArrays.yes.length > 0 && orderbook.yesBids.length === 0) {
    flags.parse_warning = true;
    warnings.push("YES book exists but no valid YES bids were parsed.");
  }

  if (rawArrays.no.length > 0 && orderbook.noBids.length === 0) {
    flags.parse_warning = true;
    warnings.push("NO book exists but no valid NO bids were parsed.");
  }

  if (hasInvalidNormalizedPrice(orderbook) || isCrossed(orderbook)) {
    flags.crossed_or_invalid_prices = true;
  }

  return {
    flags,
    liquidityUsedByDetector: roundPrice(liquidityUsedByDetector),
    warnings,
    rawYesDollars: rawArrays.yes,
    rawNoDollars: rawArrays.no
  };
}

export function getKalshiRawBidArrays(rawJson: unknown): { yes: unknown[]; no: unknown[] } {
  if (!rawJson || typeof rawJson !== "object") {
    return { yes: [], no: [] };
  }

  const root = rawJson as Record<string, unknown>;
  const orderbook = readRecord(root.orderbook);
  const orderbookFp = readRecord(root.orderbook_fp);

  return {
    yes: firstArray([orderbookFp?.yes_dollars, orderbook?.yes_dollars, orderbook?.yes, root.yes, root.yes_dollars]),
    no: firstArray([orderbookFp?.no_dollars, orderbook?.no_dollars, orderbook?.no, root.no, root.no_dollars])
  };
}

export function activeValidationFlags(flags: Partial<OrderbookValidationFlags> | null | undefined): OrderbookValidationFlag[] {
  return validationFlagNames.filter((name) => Boolean(flags?.[name]));
}

function emptyFlags(): OrderbookValidationFlags {
  return {
    missing_yes_book: false,
    missing_no_book: false,
    empty_orderbook: false,
    crossed_or_invalid_prices: false,
    negative_spread: false,
    stale_snapshot: false,
    low_liquidity: false,
    parse_warning: false
  };
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function firstArray(values: unknown[]): unknown[] {
  const value = values.find(Array.isArray);
  return Array.isArray(value) ? value : [];
}

function isValidRawLevel(value: unknown): boolean {
  if (!Array.isArray(value) || value.length < 2) {
    return false;
  }

  const rawPrice = Number(value[0]);
  const rawContracts = Number(value[1]);
  const price = rawPrice > 1 ? rawPrice / 100 : rawPrice;
  return Number.isFinite(price) && price >= 0 && price <= 1 && Number.isFinite(rawContracts) && rawContracts > 0;
}

function hasInvalidNormalizedPrice(orderbook: NormalizedOrderbook): boolean {
  const prices = [orderbook.bestYesBid, orderbook.bestYesAsk, orderbook.bestNoBid, orderbook.bestNoAsk].filter(
    (price): price is number => price !== null
  );
  return prices.some((price) => !Number.isFinite(price) || price < 0 || price > 1);
}

function isCrossed(orderbook: NormalizedOrderbook): boolean {
  const yesCrossed =
    orderbook.bestYesBid !== null && orderbook.bestYesAsk !== null && orderbook.bestYesBid > orderbook.bestYesAsk;
  const noCrossed =
    orderbook.bestNoBid !== null && orderbook.bestNoAsk !== null && orderbook.bestNoBid > orderbook.bestNoAsk;
  return yesCrossed || noCrossed;
}

function totalContracts(levels: PriceLevel[]): number {
  return levels.reduce((sum, level) => sum + level.contracts, 0);
}
