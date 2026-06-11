import { estimateComplementFees } from "./fees";
import { roundPrice } from "./kalshi";
import type { DetectedSignal, DetectionConfig, MarketLike, NormalizedOrderbook } from "./types";

export function detectBinaryComplementArb(
  orderbook: NormalizedOrderbook,
  market: MarketLike,
  config: DetectionConfig,
  detectedAt: Date = orderbook.capturedAt
): DetectedSignal {
  const yesAsk = orderbook.bestYesAsk;
  const noAsk = orderbook.bestNoAsk;
  const maxContracts = Math.min(totalContracts(orderbook.yesAsks), totalContracts(orderbook.noAsks));
  const liquidityScore = maxContracts;
  const estimatedFees = estimateComplementFees(config.feeSettings);
  const grossEdge = yesAsk === null || noAsk === null ? null : roundPrice(1 - yesAsk - noAsk);
  const netEdge = grossEdge === null ? null : roundPrice(grossEdge - estimatedFees);

  const rejection = getRejectionReason({
    market,
    detectedAt,
    grossEdge,
    netEdge,
    maxContracts,
    minNetEdge: config.minNetEdge,
    minLiquidityContracts: config.minLiquidityContracts,
    isEmptyOrderbook: orderbook.yesBids.length === 0 && orderbook.noBids.length === 0,
    hasYesAsk: yesAsk !== null,
    hasNoAsk: noAsk !== null
  });

  return {
    strategy: "binary_complement_arb",
    detectedAt,
    grossEdge,
    estimatedFees,
    netEdge,
    maxContracts,
    confidenceScore: rejection ? 0 : scoreConfidence(netEdge ?? 0, maxContracts, config.minLiquidityContracts),
    liquidityScore,
    status: rejection ? "rejected" : "accepted",
    reason: rejection ?? `Accepted: estimated net edge ${formatEdge(netEdge)} with ${maxContracts} available contracts.`,
    rawJson: {
      yesAsk,
      noAsk,
      grossEdge,
      estimatedFees,
      netEdge,
      maxContracts,
      minNetEdge: config.minNetEdge,
      minLiquidityContracts: config.minLiquidityContracts
    }
  };
}

function getRejectionReason(input: {
  market: MarketLike;
  detectedAt: Date;
  grossEdge: number | null;
  netEdge: number | null;
  maxContracts: number;
  minNetEdge: number;
  minLiquidityContracts: number;
  isEmptyOrderbook: boolean;
  hasYesAsk: boolean;
  hasNoAsk: boolean;
}): string | null {
  if (!["open", "active"].includes(input.market.status.toLowerCase())) {
    return `Rejected: market status is ${input.market.status}.`;
  }

  if (input.market.closeTime && input.market.closeTime <= input.detectedAt) {
    return "Rejected: market is closed or expired.";
  }

  if (input.isEmptyOrderbook) {
    return "Rejected: orderbook is empty; missing YES and NO liquidity.";
  }

  if (!input.hasYesAsk || !input.hasNoAsk) {
    return "Rejected: one side of the market has no available ask.";
  }

  if (input.grossEdge === null || !Number.isFinite(input.grossEdge)) {
    return "Rejected: gross edge is missing.";
  }

  if (input.maxContracts < input.minLiquidityContracts) {
    return `Rejected: liquidity ${input.maxContracts} is below minimum ${input.minLiquidityContracts}.`;
  }

  if (input.netEdge === null || input.netEdge < input.minNetEdge) {
    return `Rejected: estimated net edge ${formatEdge(input.netEdge)} is below minimum ${formatEdge(input.minNetEdge)}.`;
  }

  return null;
}

function totalContracts(levels: { contracts: number }[]): number {
  return levels.reduce((sum, level) => sum + level.contracts, 0);
}

function scoreConfidence(netEdge: number, maxContracts: number, minLiquidityContracts: number): number {
  const edgeScore = Math.min(1, Math.max(0, netEdge / 0.05));
  const liquidityScore = Math.min(1, maxContracts / Math.max(1, minLiquidityContracts * 10));
  return roundPrice((edgeScore + liquidityScore) / 2);
}

function formatEdge(value: number | null): string {
  return value === null ? "missing" : value.toFixed(4);
}
