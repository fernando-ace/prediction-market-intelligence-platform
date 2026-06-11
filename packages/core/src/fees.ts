import type { FeeSettings } from "./types";

export const defaultFeeSettings: FeeSettings = {
  feeBufferPerContract: 0.01
};

export function estimateComplementFees(
  settings: FeeSettings = defaultFeeSettings,
  notionalPerContract = 1
): number {
  return settings.feeBufferPerContract + notionalPerContract * (settings.feeBufferPercentOfNotional ?? 0);
}

export function estimateLegFee(contracts: number, settings: FeeSettings = defaultFeeSettings): number {
  const perContract = estimateComplementFees(settings) / 2;
  return perContract * contracts;
}
