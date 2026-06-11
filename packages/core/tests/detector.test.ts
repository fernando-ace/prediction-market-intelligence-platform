import { describe, expect, it } from "vitest";
import { detectBinaryComplementArb } from "../src/detector";
import { normalizeKalshiOrderbook } from "../src/kalshi";
import type { DetectionConfig, MarketLike } from "../src/types";

const openMarket: MarketLike = {
  status: "open",
  closeTime: new Date("2099-01-01T00:00:00Z")
};

const config: DetectionConfig = {
  minNetEdge: 0.005,
  minLiquidityContracts: 1,
  feeSettings: { feeBufferPerContract: 0.01 }
};

describe("binary complement arbitrage detector", () => {
  it("accepts a signal when estimated net edge is high enough", () => {
    const book = normalizeKalshiOrderbook("TEST", {
      orderbook: {
        yes: [[25, 10]],
        no: [[80, 10]]
      }
    });

    const signal = detectBinaryComplementArb(book, openMarket, config);

    expect(signal.status).toBe("accepted");
    expect(signal.grossEdge).toBe(0.05);
    expect(signal.estimatedFees).toBe(0.01);
    expect(signal.netEdge).toBe(0.04);
    expect(signal.reason).toContain("Accepted");
  });

  it("rejects a signal when edge is too small after fees", () => {
    const book = normalizeKalshiOrderbook("TEST", {
      orderbook: {
        yes: [[49, 10]],
        no: [[50, 10]]
      }
    });

    const signal = detectBinaryComplementArb(book, openMarket, config);

    expect(signal.status).toBe("rejected");
    expect(signal.reason).toContain("below minimum");
  });

  it("rejects a signal when liquidity is missing", () => {
    const book = normalizeKalshiOrderbook("TEST", {
      orderbook: {
        yes: [[25, 10]],
        no: []
      }
    });

    const signal = detectBinaryComplementArb(book, openMarket, config);

    expect(signal.status).toBe("rejected");
    expect(signal.reason).toContain("no available ask");
  });

  it("rejects an empty orderbook with an explicit missing liquidity reason", () => {
    const book = normalizeKalshiOrderbook("TEST", {
      orderbook_fp: {
        yes_dollars: [],
        no_dollars: []
      }
    });

    const signal = detectBinaryComplementArb(book, openMarket, config);

    expect(signal.status).toBe("rejected");
    expect(signal.reason).toContain("orderbook is empty");
    expect(signal.reason).toContain("missing YES and NO liquidity");
  });

  it("rejects a closed or expired market", () => {
    const book = normalizeKalshiOrderbook("TEST", {
      orderbook: {
        yes: [[25, 10]],
        no: [[80, 10]]
      }
    });

    const signal = detectBinaryComplementArb(
      book,
      { status: "closed", closeTime: new Date("2024-01-01T00:00:00Z") },
      config
    );

    expect(signal.status).toBe("rejected");
    expect(signal.reason).toContain("status is closed");
  });

  it("rejects an open market when close time has passed", () => {
    const detectedAt = new Date("2026-01-01T00:00:00Z");
    const book = normalizeKalshiOrderbook("TEST", {
      orderbook: {
        yes: [[25, 10]],
        no: [[80, 10]]
      }
    }, detectedAt);

    const signal = detectBinaryComplementArb(
      book,
      { status: "open", closeTime: new Date("2025-12-31T23:59:59Z") },
      config,
      detectedAt
    );

    expect(signal.status).toBe("rejected");
    expect(signal.reason).toContain("closed or expired");
  });

  it("rejects when paired ask-side liquidity is below the minimum", () => {
    const book = normalizeKalshiOrderbook("TEST", {
      orderbook: {
        yes: [[25, 0.5]],
        no: [[80, 0.5]]
      }
    });

    const signal = detectBinaryComplementArb(book, openMarket, {
      ...config,
      minLiquidityContracts: 1
    });

    expect(signal.status).toBe("rejected");
    expect(signal.reason).toContain("liquidity");
  });
});
