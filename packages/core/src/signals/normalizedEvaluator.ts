import { detectBinaryComplementArb } from "../detector";
import { detectMultiOutcomeArb, groupKalshiRelatedMarkets } from "../related-markets";
import type {
  DetectedSignal,
  DetectionConfig,
  MultiOutcomeSignal,
  NormalizedMarket,
  NormalizedOrderBookSnapshot,
  NormalizedSignal,
  OrderbookValidationFlags,
  SignalStrategy
} from "../types";
import { buildNormalizedBinaryDetectorInput, buildNormalizedMarketSnapshotInput, normalizedMarketToMarketLike } from "./normalizedInputs";

export type SupportedNormalizedSignalType = Extract<SignalStrategy, "binary_complement_arb" | "multi_outcome_arb">;

export interface EvaluateNormalizedSignalsArgs {
  markets: NormalizedMarket[];
  orderBookSnapshots?: NormalizedOrderBookSnapshot[];
  detectionConfig: DetectionConfig;
  detectedAt?: Date;
  includeMveMarkets?: boolean;
  fallbackContracts?: number;
  signalTypes?: SupportedNormalizedSignalType[];
  validationFlagsByMarketId?: Record<string, Partial<OrderbookValidationFlags> | undefined>;
}

export function evaluateNormalizedSignals(args: EvaluateNormalizedSignalsArgs): NormalizedSignal[] {
  const signalTypes = new Set(args.signalTypes ?? ["binary_complement_arb", "multi_outcome_arb"]);
  const snapshots = args.orderBookSnapshots ?? [];
  const signals: NormalizedSignal[] = [];

  if (signalTypes.has("binary_complement_arb")) {
    for (const market of args.markets) {
      const input = buildNormalizedBinaryDetectorInput(market, snapshotsForMarket(snapshots, market.marketId), {
        capturedAt: args.detectedAt,
        fallbackContracts: args.fallbackContracts
      });
      const signal = detectBinaryComplementArb(input.orderbook, input.market, args.detectionConfig, args.detectedAt ?? input.orderbook.capturedAt);
      signals.push(toNormalizedSignal(signal, market.marketId, market.platform));
    }
  }

  if (signalTypes.has("multi_outcome_arb")) {
    const marketLikes = args.markets.map(normalizedMarketToMarketLike);
    const groups = groupKalshiRelatedMarkets(marketLikes, { includeMveMarkets: args.includeMveMarkets });
    const marketById = new Map(args.markets.map((market) => [market.marketId, market]));

    for (const group of groups) {
      const groupSnapshots = group.markets.map((groupMarket) => {
        const market = groupMarket.ticker ? marketById.get(groupMarket.ticker) : undefined;
        if (!market) {
          return { market: groupMarket, orderbook: null, validationFlags: undefined };
        }
        return buildNormalizedMarketSnapshotInput(market, snapshotsForMarket(snapshots, market.marketId), {
          capturedAt: args.detectedAt,
          fallbackContracts: args.fallbackContracts,
          validationFlags: args.validationFlagsByMarketId?.[market.marketId]
        });
      });
      const signal = detectMultiOutcomeArb(group, groupSnapshots, args.detectionConfig, args.detectedAt);
      const representativeMarketId = group.marketTickers[0] ?? group.groupKey;
      signals.push(toNormalizedSignal(signal, representativeMarketId, group.platform, group.groupKey));
    }
  }

  return signals;
}

function snapshotsForMarket(snapshots: NormalizedOrderBookSnapshot[], marketId: string): NormalizedOrderBookSnapshot[] {
  return snapshots.filter((snapshot) => snapshot.marketId === marketId);
}

function toNormalizedSignal(
  signal: DetectedSignal | MultiOutcomeSignal,
  marketId: string,
  platform: NormalizedSignal["platform"],
  groupKey?: string
): NormalizedSignal {
  const signalType = signal.strategy;
  const detectedAt = signal.detectedAt.toISOString();
  return {
    signalId: [signalType, platform, groupKey ?? marketId, detectedAt].join(":"),
    platform,
    marketId,
    signalType,
    detectedAt,
    estimatedEdge: signal.netEdge ?? signal.grossEdge ?? undefined,
    liquidity: signal.maxContracts,
    reason: signal.reason,
    raw: {
      ...signal.rawJson,
      status: signal.status,
      strategy: signal.strategy,
      grossEdge: signal.grossEdge,
      estimatedFees: signal.estimatedFees,
      netEdge: signal.netEdge,
      maxContracts: signal.maxContracts,
      confidenceScore: signal.confidenceScore,
      liquidityScore: signal.liquidityScore
    }
  };
}
