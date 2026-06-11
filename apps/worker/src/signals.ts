import type { DetectedSignal, OrderbookValidationFlags } from "@prediction-market-scanner/core";

export function shouldCreatePaperTrade(
  signal: Pick<DetectedSignal, "status">,
  validationFlags: Partial<OrderbookValidationFlags>
): boolean {
  return (
    signal.status === "accepted" &&
    !validationFlags.empty_orderbook &&
    !validationFlags.low_liquidity &&
    !validationFlags.stale_snapshot
  );
}

export function marketCandidateLimit(maxMarkets: number, configuredLimit = 500): number {
  return Math.max(maxMarkets, configuredLimit);
}
