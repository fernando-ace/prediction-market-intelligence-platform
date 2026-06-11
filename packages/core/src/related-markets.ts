import { estimateLegFee } from "./fees";
import { type KalshiMarket, roundPrice } from "./kalshi";
import { isKalshiMveMarket } from "./market-activity";
import { activeValidationFlags } from "./validation";
import type {
  DetectionConfig,
  EligibilityResult,
  MarketLike,
  MultiOutcomeRejectionCode,
  MultiOutcomeSignal,
  NormalizedOrderbook,
  OrderbookValidationFlags,
  RelatedMarketGroup
} from "./types";

export interface RelatedGroupingOptions {
  includeMveMarkets?: boolean;
}

export interface MultiOutcomeMarketSnapshot {
  market: MarketLike;
  orderbook: NormalizedOrderbook | null;
  validationFlags?: Partial<OrderbookValidationFlags>;
}

export interface MultiOutcomeDetectionResult extends MultiOutcomeSignal {
  latestSnapshotTime: Date | null;
  closeTimeSpreadSeconds: number | null;
  validationFlags: Record<string, boolean>;
}

const CLOSE_TIME_TOLERANCE_SECONDS = 60;
const FRESH_SNAPSHOT_SECONDS = 300;
const MIN_GROUP_CONFIDENCE = 0.8;

const WINNER_TERMS = /\b(win|wins|winner|advance|advances|elected|nominee|champion)\b/i;
const EVENT_TERMS = /\b(match|game|matchup|contest|race|election|tournament|series|final|semifinal|quarterfinal)\b/i;
const BAD_GROUP_TERMS =
  /\b(hit|hits|strikeout|strikeouts|home run|home runs|total bases|points|rebounds|assists|yards|goals|saves|shots|over|under|above|below|at least|\d+\+|spread|margin|parlay|combo|multi-leg|threshold|fewer|more than|less than|total|mentions?|say|says|said|tele-rally)\b/i;

export function groupKalshiRelatedMarkets(
  markets: MarketLike[],
  options: RelatedGroupingOptions = {}
): RelatedMarketGroup[] {
  const includeMveMarkets = options.includeMveMarkets ?? false;
  const candidates = markets
    .filter((market) => market.platform === undefined || market.platform === "kalshi")
    .filter((market) => includeMveMarkets || !isMveMarketLike(market));

  const groups = new Map<string, { reason: "event_ticker" | "ticker_prefix"; markets: MarketLike[] }>();

  for (const market of candidates) {
    const eventTicker = normalizeKey(market.eventTicker);
    if (eventTicker) {
      const groupKey = eventTicker;
      upsertCandidate(groups, groupKey, "event_ticker", market);
    }
  }

  for (const market of candidates) {
    if (normalizeKey(market.eventTicker)) {
      continue;
    }
    const prefix = deriveRelatedGroupKeyFromTicker(market.ticker);
    if (prefix) {
      upsertCandidate(groups, prefix, "ticker_prefix", market);
    }
  }

  return [...groups.entries()]
    .map(([groupKey, group]) => buildGroup(groupKey, group.reason, group.markets))
    .filter((group) => group.markets.length > 1)
    .sort((a, b) => a.groupKey.localeCompare(b.groupKey));
}

export function isLikelyHeadToHeadWinnerGroup(markets: MarketLike[]): EligibilityResult {
  const sorted = sortMarkets(markets);
  const warnings: string[] = [];

  if (sorted.length !== 2) {
    return reject("invalid_group_type", `Ineligible: expected exactly 2 outcomes, found ${sorted.length}.`, warnings);
  }

  if (sorted.some((market) => !["open", "active"].includes(market.status.toLowerCase()))) {
    return reject("invalid_group_type", "Ineligible: every market must be open or active.", warnings);
  }

  const spread = closeTimeSpreadSeconds(sorted);
  if (spread === null) {
    return reject("mismatched_close_time", "Ineligible: every market needs a close time.", warnings);
  }

  if (spread > CLOSE_TIME_TOLERANCE_SECONDS) {
    return reject("mismatched_close_time", `Ineligible: close times differ by ${spread} seconds.`, warnings);
  }

  const titlesAndRules = sorted.map((market) => `${market.title ?? ""} ${market.resolutionRules ?? ""}`.trim());
  if (titlesAndRules.some((text) => BAD_GROUP_TERMS.test(text))) {
    return reject("threshold_or_prop_market", "Ineligible: title or rules look like a prop, stat, threshold, spread, or combo market.", warnings);
  }

  if (!titlesAndRules.every((text) => WINNER_TERMS.test(text) && EVENT_TERMS.test(text))) {
    return reject("group_not_exhaustive", "Ineligible: titles do not clearly describe two head-to-head winner outcomes.", warnings);
  }

  if (!sameEventTicker(sorted)) {
    warnings.push("Markets do not share an event_ticker; fallback grouping is lower confidence.");
    return {
      eligible: true,
      confidenceScore: 0.8,
      reason: "Eligible: two open winner markets with matching close times passed conservative fallback checks.",
      warnings
    };
  }

  return {
    eligible: true,
    confidenceScore: 0.95,
    reason: "Eligible: two open markets share event_ticker, matching close time, and winner-style titles.",
    warnings
  };
}

export function detectMultiOutcomeArb(
  group: RelatedMarketGroup,
  snapshots: MultiOutcomeMarketSnapshot[],
  config: DetectionConfig,
  detectedAt: Date = new Date()
): MultiOutcomeDetectionResult {
  const snapshotByTicker = new Map(snapshots.map((snapshot) => [snapshot.market.ticker, snapshot]));
  const orderedSnapshots = group.markets.map((market) => snapshotByTicker.get(market.ticker));
  const presentOrderbooks = orderedSnapshots.flatMap((snapshot) => (snapshot?.orderbook ? [snapshot.orderbook] : []));
  const latestSnapshotTime = latestCapturedAt(presentOrderbooks);
  const validationFlags = mergeValidationFlags(orderedSnapshots.map((snapshot) => snapshot?.validationFlags));
  const totalYesAskCost = orderedSnapshots.every((snapshot) => snapshot?.orderbook?.bestYesAsk !== null && snapshot?.orderbook?.bestYesAsk !== undefined)
    ? roundPrice(
        orderedSnapshots.reduce((sum, snapshot) => sum + (snapshot?.orderbook?.bestYesAsk ?? 0), 0)
      )
    : null;
  const grossEdge = totalYesAskCost === null ? null : roundPrice(1 - totalYesAskCost);
  const estimatedFees = roundPrice(estimateLegFee(1, config.feeSettings) * group.markets.length);
  const netEdge = grossEdge === null ? null : roundPrice(grossEdge - estimatedFees);
  const maxContracts = orderedSnapshots.every((snapshot) => snapshot?.orderbook)
    ? Math.min(...orderedSnapshots.map((snapshot) => totalContracts(snapshot?.orderbook?.yesAsks ?? [])))
    : 0;
  const rejectionCode = getMultiOutcomeRejection({
    group,
    detectedAt,
    orderedSnapshots,
    validationFlags,
    totalYesAskCost,
    netEdge,
    maxContracts,
    minNetEdge: config.minNetEdge,
    minLiquidityContracts: config.minLiquidityContracts
  });
  const confidenceScore = rejectionCode ? 0 : scoreMultiOutcomeConfidence(netEdge ?? 0, maxContracts, config.minLiquidityContracts, group.confidenceScore);
  const reason = rejectionCode
    ? rejectionReason(rejectionCode, { netEdge, minNetEdge: config.minNetEdge, maxContracts, minLiquidityContracts: config.minLiquidityContracts })
    : `Accepted: multi-outcome YES cost ${formatEdge(totalYesAskCost)} leaves estimated net edge ${formatEdge(netEdge)}.`;

  return {
    strategy: "multi_outcome_arb",
    detectedAt,
    grossEdge,
    estimatedFees,
    netEdge,
    totalYesAskCost,
    maxContracts: roundPrice(maxContracts),
    confidenceScore,
    liquidityScore: roundPrice(maxContracts),
    status: rejectionCode ? "rejected" : "accepted",
    reason,
    rejectionCode,
    latestSnapshotTime,
    closeTimeSpreadSeconds: group.closeTimeSpreadSeconds,
    validationFlags,
    rawJson: {
      groupKey: group.groupKey,
      eventTicker: group.eventTicker,
      groupMarketTickers: group.marketTickers,
      groupMarketTitles: group.marketTitles,
      groupEligibility: group.eligible ? "eligible" : "ineligible",
      groupConfidence: group.confidenceScore,
      groupReason: group.eligibilityReason,
      totalYesAskCost,
      grossEdge,
      estimatedFees,
      netEdge,
      status: rejectionCode ? "rejected" : "accepted",
      reason,
      rejectionCode,
      marketCount: group.markets.length,
      closeTimeSpreadSeconds: group.closeTimeSpreadSeconds,
      latestSnapshotTime: latestSnapshotTime?.toISOString() ?? null,
      validationFlags,
      legs: orderedSnapshots.map((snapshot) => ({
        marketTicker: snapshot?.market.ticker ?? null,
        marketTitle: snapshot?.market.title ?? null,
        yesAsk: snapshot?.orderbook?.bestYesAsk ?? null,
        yesAskDepth: totalContracts(snapshot?.orderbook?.yesAsks ?? []),
        snapshotTime: snapshot?.orderbook?.capturedAt.toISOString() ?? null
      }))
    }
  };
}

function getMultiOutcomeRejection(input: {
  group: RelatedMarketGroup;
  detectedAt: Date;
  orderedSnapshots: Array<MultiOutcomeMarketSnapshot | undefined>;
  validationFlags: Record<string, boolean>;
  totalYesAskCost: number | null;
  netEdge: number | null;
  maxContracts: number;
  minNetEdge: number;
  minLiquidityContracts: number;
}): MultiOutcomeRejectionCode | null {
  if (!input.group.eligible) {
    return input.group.eligibilityReason.toLowerCase().includes("prop") || input.group.eligibilityReason.toLowerCase().includes("threshold")
      ? "threshold_or_prop_market"
      : "invalid_group_type";
  }

  if (input.group.confidenceScore < MIN_GROUP_CONFIDENCE) {
    return "group_not_mutually_exclusive";
  }

  if (input.group.closeTimeSpreadSeconds === null || input.group.closeTimeSpreadSeconds > CLOSE_TIME_TOLERANCE_SECONDS) {
    return "mismatched_close_time";
  }

  if (input.orderedSnapshots.some((snapshot) => !snapshot?.orderbook)) {
    return "missing_snapshot";
  }

  if (input.orderedSnapshots.some((snapshot) => snapshot?.orderbook?.bestYesAsk === null)) {
    return "missing_yes_ask";
  }

  if (hasBlockingValidationFlag(input.validationFlags)) {
    return input.validationFlags.stale_snapshot ? "stale_snapshot" : "validation_flags";
  }

  if (input.orderedSnapshots.some((snapshot) => snapshot?.orderbook && input.detectedAt.getTime() - snapshot.orderbook.capturedAt.getTime() > FRESH_SNAPSHOT_SECONDS * 1000)) {
    return "stale_snapshot";
  }

  if (input.maxContracts < input.minLiquidityContracts) {
    return "low_liquidity";
  }

  if (input.totalYesAskCost === null) {
    return "missing_yes_ask";
  }

  if (input.netEdge === null || input.netEdge < input.minNetEdge) {
    return "low_edge";
  }

  return null;
}

function rejectionReason(
  code: MultiOutcomeRejectionCode,
  values: { netEdge: number | null; minNetEdge: number; maxContracts: number; minLiquidityContracts: number }
): string {
  switch (code) {
    case "group_not_exhaustive":
      return "Rejected: group is not clearly collectively exhaustive.";
    case "group_not_mutually_exclusive":
      return "Rejected: group is not confidently mutually exclusive.";
    case "missing_yes_ask":
      return "Rejected: one or more outcomes are missing a YES ask.";
    case "low_liquidity":
      return `Rejected: group YES liquidity ${values.maxContracts} is below minimum ${values.minLiquidityContracts}.`;
    case "stale_snapshot":
      return "Rejected: one or more snapshots are stale.";
    case "mismatched_close_time":
      return "Rejected: group markets have mismatched close times.";
    case "invalid_group_type":
      return "Rejected: group type is not eligible for multi-outcome analysis.";
    case "threshold_or_prop_market":
      return "Rejected: group looks like a threshold, prop, stat, spread, over/under, or combo market.";
    case "validation_flags":
      return "Rejected: one or more snapshots have active validation flags.";
    case "missing_snapshot":
      return "Rejected: one or more group markets are missing a latest snapshot.";
    case "low_edge":
      return `Rejected: estimated net edge ${formatEdge(values.netEdge)} is below minimum ${formatEdge(values.minNetEdge)}.`;
  }
}

function buildGroup(groupKey: string, groupingReason: "event_ticker" | "ticker_prefix", markets: MarketLike[]): RelatedMarketGroup {
  const sortedMarkets = sortMarkets(markets);
  const eligibility = isLikelyHeadToHeadWinnerGroup(sortedMarkets);
  const spread = closeTimeSpreadSeconds(sortedMarkets);
  const eventTicker = sortedMarkets.map((market) => normalizeKey(market.eventTicker)).find(Boolean) ?? null;
  const baseConfidence = groupingReason === "event_ticker" ? 0.9 : 0.8;
  const confidenceScore = eligibility.eligible ? Math.min(eligibility.confidenceScore, baseConfidence + 0.05) : Math.min(eligibility.confidenceScore, baseConfidence);

  return {
    groupKey,
    platform: "kalshi",
    eventTicker,
    markets: sortedMarkets,
    marketTickers: sortedMarkets.map((market) => market.ticker ?? ""),
    marketTitles: sortedMarkets.map((market) => market.title ?? market.ticker ?? ""),
    closeTimes: sortedMarkets.map((market) => market.closeTime),
    outcomeCount: sortedMarkets.length,
    groupingReason,
    confidenceScore: roundPrice(confidenceScore),
    eligible: eligibility.eligible && confidenceScore >= MIN_GROUP_CONFIDENCE,
    eligibilityReason: eligibility.reason,
    warnings: eligibility.warnings,
    closeTimeSpreadSeconds: spread
  };
}

function reject(code: string, reason: string, warnings: string[]): EligibilityResult {
  return { eligible: false, confidenceScore: 0, reason, warnings, code };
}

function upsertCandidate(
  groups: Map<string, { reason: "event_ticker" | "ticker_prefix"; markets: MarketLike[] }>,
  groupKey: string,
  reason: "event_ticker" | "ticker_prefix",
  market: MarketLike
): void {
  const existing = groups.get(groupKey);
  if (existing) {
    existing.markets.push(market);
  } else {
    groups.set(groupKey, { reason, markets: [market] });
  }
}

function isMveMarketLike(market: MarketLike): boolean {
  return isKalshiMveMarket({
    ticker: market.ticker ?? "",
    event_ticker: market.eventTicker ?? undefined
  } as KalshiMarket);
}

function normalizeKey(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().toUpperCase() : null;
}

export function deriveRelatedGroupKeyFromTicker(ticker: string | undefined): string | null {
  if (!ticker) {
    return null;
  }
  const normalized = ticker.toUpperCase();
  const lastDash = normalized.lastIndexOf("-");
  if (lastDash <= 4) {
    return null;
  }
  return normalized.slice(0, lastDash);
}

function sortMarkets(markets: MarketLike[]): MarketLike[] {
  return [...markets].sort((a, b) => (a.ticker ?? "").localeCompare(b.ticker ?? ""));
}

function sameEventTicker(markets: MarketLike[]): boolean {
  const tickers = markets.map((market) => normalizeKey(market.eventTicker));
  return tickers.every(Boolean) && new Set(tickers).size === 1;
}

function closeTimeSpreadSeconds(markets: MarketLike[]): number | null {
  const times = markets.map((market) => market.closeTime?.getTime()).filter((value): value is number => typeof value === "number");
  if (times.length !== markets.length || times.length === 0) {
    return null;
  }
  return Math.round((Math.max(...times) - Math.min(...times)) / 1000);
}

function totalContracts(levels: { contracts: number }[]): number {
  return levels.reduce((sum, level) => sum + level.contracts, 0);
}

function latestCapturedAt(orderbooks: NormalizedOrderbook[]): Date | null {
  if (orderbooks.length === 0) {
    return null;
  }
  return new Date(Math.max(...orderbooks.map((orderbook) => orderbook.capturedAt.getTime())));
}

function mergeValidationFlags(flags: Array<Partial<OrderbookValidationFlags> | undefined>): Record<string, boolean> {
  const merged: Record<string, boolean> = {};
  for (const flagSet of flags) {
    for (const flag of activeValidationFlags(flagSet)) {
      merged[flag] = true;
    }
  }
  return merged;
}

function hasBlockingValidationFlag(flags: Record<string, boolean>): boolean {
  return Boolean(
    flags.empty_orderbook ||
      flags.crossed_or_invalid_prices ||
      flags.negative_spread ||
      flags.stale_snapshot ||
      flags.parse_warning
  );
}

function scoreMultiOutcomeConfidence(
  netEdge: number,
  maxContracts: number,
  minLiquidityContracts: number,
  groupConfidence: number
): number {
  const edgeScore = Math.min(1, Math.max(0, netEdge / 0.05));
  const liquidityScore = Math.min(1, maxContracts / Math.max(1, minLiquidityContracts * 10));
  return roundPrice((edgeScore + liquidityScore + groupConfidence) / 3);
}

function formatEdge(value: number | null): string {
  return value === null ? "missing" : value.toFixed(4);
}
