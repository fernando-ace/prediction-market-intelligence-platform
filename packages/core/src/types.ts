export type Platform = "kalshi" | "polymarket";

export type NormalizedMarketStatus = "active" | "closed" | "settled" | "unknown";

export interface NormalizedMarket {
  platform: Platform;
  marketId: string;
  title: string;
  category?: string;
  closeTime?: string;
  status?: NormalizedMarketStatus;
  outcomes: NormalizedOutcome[];
  raw?: unknown;
}

export interface NormalizedOutcome {
  outcomeId: string;
  label: string;
  yesBid?: number;
  yesAsk?: number;
  noBid?: number;
  noAsk?: number;
  lastPrice?: number;
  volume?: number;
  liquidity?: number;
  raw?: unknown;
}

export interface NormalizedOrderBookSnapshot {
  platform: Platform;
  marketId: string;
  outcomeId?: string;
  capturedAt: string;
  bestBid?: number;
  bestAsk?: number;
  spread?: number;
  midpoint?: number;
  raw?: unknown;
}

export type SignalType =
  | "binary_complement_arb"
  | "multi_outcome_arb"
  | "cross_platform_spread"
  | "stale_price"
  | "wide_spread_market_making_candidate"
  | "related_market_inconsistency"
  | "near_resolution_yield";

export interface NormalizedSignal {
  signalId: string;
  platform: Platform;
  marketId: string;
  outcomeId?: string;
  signalType: SignalType;
  detectedAt: string;
  entryPrice?: number;
  estimatedEdge?: number;
  liquidity?: number;
  spread?: number;
  reason: string;
  raw?: unknown;
}

export type ForwardReturnWindow = "15m" | "30m" | "60m" | "240m";

export interface ForwardReturn {
  signalId: string;
  window: ForwardReturnWindow;
  checkedAt: string;
  entryPrice?: number;
  exitPrice?: number;
  returnAbs?: number;
  returnPct?: number;
  wasProfitable?: boolean;
}

export type SignalStatus = "accepted" | "rejected";

export type PaperTradeStatus = "pending" | "filled" | "partial" | "failed";

export type Outcome = "yes" | "no";

export type SignalStrategy = "binary_complement_arb" | "multi_outcome_arb";

export interface PriceLevel {
  price: number;
  contracts: number;
}

export interface NormalizedOrderbook {
  platform: Platform;
  marketTicker: string;
  capturedAt: Date;
  bestYesBid: number | null;
  bestYesAsk: number | null;
  bestNoBid: number | null;
  bestNoAsk: number | null;
  spread: number | null;
  yesBids: PriceLevel[];
  noBids: PriceLevel[];
  yesAsks: PriceLevel[];
  noAsks: PriceLevel[];
  rawJson: unknown;
}

export type OrderbookValidationFlag =
  | "missing_yes_book"
  | "missing_no_book"
  | "empty_orderbook"
  | "crossed_or_invalid_prices"
  | "negative_spread"
  | "stale_snapshot"
  | "low_liquidity"
  | "parse_warning";

export type OrderbookValidationFlags = Record<OrderbookValidationFlag, boolean>;

export interface OrderbookValidationResult {
  flags: OrderbookValidationFlags;
  liquidityUsedByDetector: number;
  warnings: string[];
  rawYesDollars: unknown[];
  rawNoDollars: unknown[];
}

export interface MarketLike {
  id?: string;
  platform?: Platform;
  ticker?: string;
  eventTicker?: string | null;
  title?: string;
  resolutionRules?: string | null;
  status: string;
  closeTime: Date | null;
}

export interface FeeSettings {
  feeBufferPerContract: number;
  feeBufferPercentOfNotional?: number;
}

export interface DetectionConfig {
  minNetEdge: number;
  minLiquidityContracts: number;
  feeSettings: FeeSettings;
}

export interface DetectedSignal {
  strategy: SignalStrategy;
  detectedAt: Date;
  grossEdge: number | null;
  estimatedFees: number;
  netEdge: number | null;
  maxContracts: number;
  confidenceScore: number;
  liquidityScore: number;
  status: SignalStatus;
  reason: string;
  rawJson: Record<string, unknown>;
}

export type RelatedGroupReason = "event_ticker" | "ticker_prefix";

export interface RelatedMarketGroup {
  groupKey: string;
  platform: Platform;
  eventTicker: string | null;
  markets: MarketLike[];
  marketTickers: string[];
  marketTitles: string[];
  closeTimes: Array<Date | null>;
  outcomeCount: number;
  groupingReason: RelatedGroupReason;
  confidenceScore: number;
  eligible: boolean;
  eligibilityReason: string;
  warnings: string[];
  closeTimeSpreadSeconds: number | null;
}

export interface EligibilityResult {
  eligible: boolean;
  confidenceScore: number;
  reason: string;
  warnings: string[];
  code?: string;
}

export type MultiOutcomeRejectionCode =
  | "group_not_exhaustive"
  | "group_not_mutually_exclusive"
  | "missing_yes_ask"
  | "low_liquidity"
  | "low_edge"
  | "stale_snapshot"
  | "mismatched_close_time"
  | "invalid_group_type"
  | "threshold_or_prop_market"
  | "validation_flags"
  | "missing_snapshot";

export interface MultiOutcomeSignal extends DetectedSignal {
  strategy: "multi_outcome_arb";
  totalYesAskCost: number | null;
  rejectionCode: MultiOutcomeRejectionCode | null;
}

export interface PaperSignalInput {
  detectedAt: Date;
  expectedNetEdge: number;
  maxContracts: number;
  yesAskAtSignal?: number | null;
  noAskAtSignal?: number | null;
}

export interface PaperFillResult {
  marketId?: string;
  marketTicker?: string;
  legRole?: string;
  side: "buy";
  outcome: Outcome;
  price: number;
  contracts: number;
  fees: number;
  filledAt: Date;
}

export interface PaperTradeSimulation {
  status: PaperTradeStatus;
  executionTime: Date;
  executionDelaySeconds: number;
  expectedNetEdge: number;
  realizedNetEdge: number | null;
  fills: PaperFillResult[];
  notes: string;
  legRisk: boolean;
  targetExecutionTime: Date;
  actualSnapshotExecutionTime: Date | null;
  yesAskAtSignal: number | null;
  noAskAtSignal: number | null;
  yesFillAveragePrice: number | null;
  noFillAveragePrice: number | null;
  yesContractsFilled: number;
  noContractsFilled: number;
  pairedContracts: number;
  unpairedContractsDiscarded: number;
  feeEstimate: number;
  failureReason: string | null;
  groupFillRisk?: boolean;
  fillPricesByMarket?: Array<{
    marketId?: string;
    marketTicker: string;
    averagePrice: number | null;
    contractsFilled: number;
  }>;
}
