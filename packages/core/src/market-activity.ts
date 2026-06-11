import type { KalshiMarket } from "./kalshi";

export interface KalshiMarketActivity {
  activityScore: number;
  status: string;
  closeTime: Date | null;
  yesBidDollars: number | null;
  yesAskDollars: number | null;
  yesBidSize: number | null;
  yesAskSize: number | null;
  noBidDollars: number | null;
  noAskDollars: number | null;
  volume: number | null;
  volume24h: number | null;
  liquidity: number | null;
  openInterest: number | null;
  lastPrice: number | null;
  hasYesBidAskPair: boolean;
  hasNoBidAskPair: boolean;
  hasVisibleBidAsk: boolean;
  hasPositiveLiquidity: boolean;
  hasPositiveVolume24h: boolean;
  hasPositiveOpenInterest: boolean;
  hasActivity: boolean;
  isMve: boolean;
}

export interface SelectedKalshiMarket {
  market: KalshiMarket;
  activity: KalshiMarketActivity;
}

export interface SelectKalshiMarketsOptions {
  includeMveMarkets?: boolean;
}

export interface KalshiCandidateStats {
  candidateMarketsFetched: number;
  mveMarketsExcluded: number;
  marketsWithVisibleBidAsk: number;
  marketsWithPositiveLiquidity: number;
  marketsWithPositiveVolume24h: number;
  marketsWithPositiveOpenInterest: number;
}

const OPEN_STATUS_BONUS = 10;
const YES_PAIR_WEIGHT = 5000;
const NO_PAIR_WEIGHT = 5000;
const VISIBLE_QUOTE_WEIGHT = 1000;
const POSITIVE_SIZE_WEIGHT = 400;
const LIQUIDITY_WEIGHT = 200;
const VOLUME_24H_WEIGHT = 150;
const VOLUME_WEIGHT = 100;
const OPEN_INTEREST_WEIGHT = 75;
const LAST_PRICE_WEIGHT = 10;

export function scoreKalshiMarketActivity(market: KalshiMarket): KalshiMarketActivity {
  const status = readString(market.status) ?? "unknown";
  const closeTime = parseDate(market.close_time);
  const yesBidDollars = readFirstNumber(market, ["yes_bid_dollars", "yes_bid"]);
  const yesAskDollars = readFirstNumber(market, ["yes_ask_dollars", "yes_ask"]);
  const yesBidSize = readFirstNumber(market, ["yes_bid_size_fp", "yes_bid_size"]);
  const yesAskSize = readFirstNumber(market, ["yes_ask_size_fp", "yes_ask_size"]);
  const noBidDollars = readFirstNumber(market, ["no_bid_dollars", "no_bid"]);
  const noAskDollars = readFirstNumber(market, ["no_ask_dollars", "no_ask"]);
  const volume = readFirstNumber(market, ["volume_fp", "volume"]);
  const volume24h = readFirstNumber(market, ["volume_24h_fp", "volume_24h", "volume24h"]);
  const liquidity = readFirstNumber(market, ["liquidity_dollars", "liquidity"]);
  const openInterest = readFirstNumber(market, ["open_interest_fp", "open_interest", "openInterest"]);
  const lastPrice = readFirstNumber(market, ["last_price_dollars", "last_price", "lastPrice"]);

  const quoteValues = [yesBidDollars, yesAskDollars, noBidDollars, noAskDollars];
  const visibleQuoteCount = quoteValues.filter(isTradablePrice).length;
  const hasYesBidAskPair = isTradablePrice(yesBidDollars) && isTradablePrice(yesAskDollars);
  const hasNoBidAskPair = isTradablePrice(noBidDollars) && isTradablePrice(noAskDollars);
  const hasVisibleBidAsk = visibleQuoteCount > 0;
  const positiveSizeCount = [yesBidSize, yesAskSize].filter((value) => value !== null && value > 0).length;
  const hasPositiveLiquidity = Boolean(liquidity && liquidity > 0);
  const hasPositiveVolume24h = Boolean(volume24h && volume24h > 0);
  const hasPositiveOpenInterest = Boolean(openInterest && openInterest > 0);
  const isOpenOrActive = ["open", "active"].includes(status.toLowerCase());

  const activityScore =
    (hasYesBidAskPair ? YES_PAIR_WEIGHT : 0) +
    (hasNoBidAskPair ? NO_PAIR_WEIGHT : 0) +
    visibleQuoteCount * VISIBLE_QUOTE_WEIGHT +
    positiveSizeCount * POSITIVE_SIZE_WEIGHT +
    scoreMagnitude(liquidity, LIQUIDITY_WEIGHT) +
    scoreMagnitude(volume24h, VOLUME_24H_WEIGHT) +
    scoreMagnitude(volume, VOLUME_WEIGHT) +
    scoreMagnitude(openInterest, OPEN_INTEREST_WEIGHT) +
    scoreMagnitude(lastPrice, LAST_PRICE_WEIGHT) +
    (isOpenOrActive ? OPEN_STATUS_BONUS : 0);

  return {
    activityScore: roundScore(activityScore),
    status,
    closeTime,
    yesBidDollars,
    yesAskDollars,
    yesBidSize,
    yesAskSize,
    noBidDollars,
    noAskDollars,
    volume,
    volume24h,
    liquidity,
    openInterest,
    lastPrice,
    hasYesBidAskPair,
    hasNoBidAskPair,
    hasVisibleBidAsk,
    hasPositiveLiquidity,
    hasPositiveVolume24h,
    hasPositiveOpenInterest,
    hasActivity:
      hasVisibleBidAsk ||
      positiveSizeCount > 0 ||
      [volume, volume24h, liquidity, openInterest, lastPrice].some((value) => Boolean(value)),
    isMve: isKalshiMveMarket(market)
  };
}

export function selectActiveKalshiMarkets(
  markets: KalshiMarket[],
  maxMarkets: number,
  options: SelectKalshiMarketsOptions = {}
): SelectedKalshiMarket[] {
  if (maxMarkets <= 0) {
    return [];
  }

  const includeMveMarkets = options.includeMveMarkets ?? false;

  return markets
    .filter((market) => includeMveMarkets || !isKalshiMveMarket(market))
    .map((market) => ({ market, activity: scoreKalshiMarketActivity(market) }))
    .sort(compareSelectedMarkets)
    .slice(0, maxMarkets);
}

export function summarizeKalshiCandidateMarkets(
  markets: KalshiMarket[],
  options: SelectKalshiMarketsOptions = {}
): KalshiCandidateStats {
  const includeMveMarkets = options.includeMveMarkets ?? false;
  const activities = markets.map((market) => scoreKalshiMarketActivity(market));
  const includedActivities = activities.filter((activity) => includeMveMarkets || !activity.isMve);

  return {
    candidateMarketsFetched: markets.length,
    mveMarketsExcluded: includeMveMarkets ? 0 : activities.filter((activity) => activity.isMve).length,
    marketsWithVisibleBidAsk: includedActivities.filter((activity) => activity.hasVisibleBidAsk).length,
    marketsWithPositiveLiquidity: includedActivities.filter((activity) => activity.hasPositiveLiquidity).length,
    marketsWithPositiveVolume24h: includedActivities.filter((activity) => activity.hasPositiveVolume24h).length,
    marketsWithPositiveOpenInterest: includedActivities.filter((activity) => activity.hasPositiveOpenInterest).length
  };
}

export function isKalshiMveMarket(market: KalshiMarket): boolean {
  if (market.ticker.toUpperCase().startsWith("KXMVE")) {
    return true;
  }
  if (typeof market.mve_collection_ticker === "string" && market.mve_collection_ticker.trim()) {
    return true;
  }
  return Array.isArray(market.mve_selected_legs) && market.mve_selected_legs.length > 0;
}

function compareSelectedMarkets(a: SelectedKalshiMarket, b: SelectedKalshiMarket): number {
  const scoreDifference = b.activity.activityScore - a.activity.activityScore;
  if (scoreDifference !== 0) {
    return scoreDifference;
  }

  const closeA = a.activity.closeTime?.getTime() ?? Number.POSITIVE_INFINITY;
  const closeB = b.activity.closeTime?.getTime() ?? Number.POSITIVE_INFINITY;
  if (closeA !== closeB) {
    return closeA - closeB;
  }

  return a.market.ticker.localeCompare(b.market.ticker);
}

function scoreMagnitude(value: number | null, weight: number): number {
  return value !== null && value > 0 ? Math.log1p(value) * weight : 0;
}

function readFirstNumber(market: KalshiMarket, names: string[]): number | null {
  for (const name of names) {
    const value = readNumber(market[name]);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function readNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isTradablePrice(value: number | null): boolean {
  return value !== null && value > 0 && value < 1;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}
