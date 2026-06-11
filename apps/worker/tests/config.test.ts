import { afterEach, describe, expect, it } from "vitest";
import { loadWorkerConfig } from "../src/config";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("worker config", () => {
  it("loads fee buffer env vars", () => {
    process.env.FEE_BUFFER_PER_CONTRACT = "0.02";
    process.env.FEE_BUFFER_PERCENT_OF_NOTIONAL = "0.015";

    const config = loadWorkerConfig();

    expect(config.detection.feeSettings.feeBufferPerContract).toBe(0.02);
    expect(config.detection.feeSettings.feeBufferPercentOfNotional).toBe(0.015);
  });

  it("defaults to excluding MVE markets and a 500-market candidate pool", () => {
    delete process.env.INCLUDE_MVE_MARKETS;
    delete process.env.KALSHI_CANDIDATE_MARKET_LIMIT;

    const config = loadWorkerConfig();

    expect(config.includeMveMarkets).toBe(false);
    expect(config.kalshiCandidateMarketLimit).toBe(500);
  });

  it("can include MVE markets explicitly", () => {
    process.env.INCLUDE_MVE_MARKETS = "true";
    process.env.KALSHI_CANDIDATE_MARKET_LIMIT = "750";

    const config = loadWorkerConfig();

    expect(config.includeMveMarkets).toBe(true);
    expect(config.kalshiCandidateMarketLimit).toBe(750);
  });
});
