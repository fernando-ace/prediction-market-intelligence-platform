import type { OrderbookValidationFlags, SignalStatus } from "./types";

export interface SampleSignalInput {
  status: SignalStatus;
  reason?: string;
  validationFlags?: Partial<OrderbookValidationFlags>;
}

export interface SampleSummaryInput {
  marketsChecked: number;
  snapshotsCollected: number;
  signals: SampleSignalInput[];
  paperTradesCreated: number;
  workerErrors: string[];
  validationFlags: Array<Partial<OrderbookValidationFlags>>;
}

export interface SampleSummary {
  marketsChecked: number;
  snapshotsCollected: number;
  snapshotsWithMissingYesBids: number;
  snapshotsWithMissingNoBids: number;
  snapshotsWithEmptyOrderbooks: number;
  snapshotsWithInvalidPrices: number;
  signalsCreatedTotal: number;
  signalsAccepted: number;
  signalsRejected: number;
  signalsRejectedForEmptyOrderbook: number;
  signalsRejectedForMissingLiquidity: number;
  signalsRejectedForLowEdge: number;
  signalsRejectedForStaleSnapshot: number;
  paperTradesCreated: number;
  workerErrors: number;
  workerErrorMessages: string[];
}

export function summarizeValidationSample(input: SampleSummaryInput): SampleSummary {
  const rejectedSignals = input.signals.filter((signal) => signal.status === "rejected");

  return {
    marketsChecked: input.marketsChecked,
    snapshotsCollected: input.snapshotsCollected,
    snapshotsWithMissingYesBids: input.validationFlags.filter((flags) => flags.missing_yes_book).length,
    snapshotsWithMissingNoBids: input.validationFlags.filter((flags) => flags.missing_no_book).length,
    snapshotsWithEmptyOrderbooks: input.validationFlags.filter((flags) => flags.empty_orderbook).length,
    snapshotsWithInvalidPrices: input.validationFlags.filter((flags) => flags.crossed_or_invalid_prices).length,
    signalsCreatedTotal: input.signals.length,
    signalsAccepted: input.signals.filter((signal) => signal.status === "accepted").length,
    signalsRejected: rejectedSignals.length,
    signalsRejectedForEmptyOrderbook: rejectedSignals.filter(isEmptyOrderbookRejection).length,
    signalsRejectedForMissingLiquidity: rejectedSignals.filter(isMissingLiquidityRejection).length,
    signalsRejectedForLowEdge: rejectedSignals.filter(isLowEdgeRejection).length,
    signalsRejectedForStaleSnapshot: rejectedSignals.filter(isStaleSnapshotRejection).length,
    paperTradesCreated: input.paperTradesCreated,
    workerErrors: input.workerErrors.length,
    workerErrorMessages: input.workerErrors
  };
}

function isEmptyOrderbookRejection(signal: SampleSignalInput): boolean {
  const reason = (signal.reason ?? "").toLowerCase();
  return Boolean(signal.validationFlags?.empty_orderbook || reason.includes("orderbook is empty"));
}

function isMissingLiquidityRejection(signal: SampleSignalInput): boolean {
  const reason = (signal.reason ?? "").toLowerCase();
  const flags = signal.validationFlags;
  return Boolean(
    !isEmptyOrderbookRejection(signal) &&
      (flags?.low_liquidity ||
      flags?.missing_yes_book ||
      flags?.missing_no_book ||
      reason.includes("liquidity") ||
        reason.includes("no available ask"))
  );
}

function isLowEdgeRejection(signal: SampleSignalInput): boolean {
  return (signal.reason ?? "").toLowerCase().includes("net edge") && (signal.reason ?? "").toLowerCase().includes("below minimum");
}

function isStaleSnapshotRejection(signal: SampleSignalInput): boolean {
  return Boolean(signal.validationFlags?.stale_snapshot || (signal.reason ?? "").toLowerCase().includes("stale"));
}
