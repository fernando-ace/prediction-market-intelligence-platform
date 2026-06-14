import { describe, expect, it } from "vitest";
import { compareSignalOutputs, evaluateNormalizedSignals } from "../src";
import type { DetectionConfig, NormalizedMarket, NormalizedSignal } from "../src";

const detectedAt = new Date("2026-06-13T12:00:00Z");
const closeTime = "2099-01-01T00:00:00Z";
const config: DetectionConfig = {
  minNetEdge: 0.005,
  minLiquidityContracts: 1,
  feeSettings: { feeBufferPerContract: 0.01 }
};

describe("normalized signal evaluator", () => {
  it("produces a binary complement signal from normalized market inputs", () => {
    const signals = evaluateNormalizedSignals({
      markets: [
        normalizedMarket("KXTEST", "Will the normalized binary signal pass?", {
          yesAsk: 0.25,
          yesBid: 0.2,
          noAsk: 0.7,
          noBid: 0.25
        })
      ],
      detectionConfig: config,
      detectedAt,
      signalTypes: ["binary_complement_arb"]
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toEqual(
      expect.objectContaining({
        platform: "kalshi",
        marketId: "KXTEST",
        signalType: "binary_complement_arb",
        estimatedEdge: 0.04
      })
    );
    expect(signals[0]?.raw).toEqual(expect.objectContaining({ status: "accepted", strategy: "binary_complement_arb" }));
  });

  it("produces a multi-outcome signal by reusing the current grouped detector", () => {
    const signals = evaluateNormalizedSignals({
      markets: [
        normalizedMarket("A", "Will Player A win the match?", { yesAsk: 0.48, yesBid: 0.4, eventTicker: "KXEVENT" }),
        normalizedMarket("B", "Will Player B win the match?", { yesAsk: 0.49, yesBid: 0.42, eventTicker: "KXEVENT" })
      ],
      detectionConfig: config,
      detectedAt,
      signalTypes: ["multi_outcome_arb"]
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toEqual(
      expect.objectContaining({
        platform: "kalshi",
        marketId: "A",
        signalType: "multi_outcome_arb",
        estimatedEdge: 0.02
      })
    );
    expect(signals[0]?.raw).toEqual(expect.objectContaining({ status: "accepted", strategy: "multi_outcome_arb" }));
  });
});

describe("signal output comparison", () => {
  it("reports exact matches when existing and normalized outputs align", () => {
    const normalized = signal("binary_complement_arb", "KXTEST", 0.04);
    const comparison = compareSignalOutputs(
      [{ platform: "kalshi", marketId: "KXTEST", strategy: "binary_complement_arb", netEdge: 0.04 }],
      [normalized]
    );

    expect(comparison.existingCount).toBe(1);
    expect(comparison.normalizedCount).toBe(1);
    expect(comparison.matchedCount).toBe(1);
    expect(comparison.missingFromNormalized).toEqual([]);
    expect(comparison.extraFromNormalized).toEqual([]);
  });

  it("reports missing and extra normalized signals clearly", () => {
    const comparison = compareSignalOutputs(
      [{ platform: "kalshi", marketId: "KXEXISTING", strategy: "binary_complement_arb", netEdge: 0.04 }],
      [signal("binary_complement_arb", "KXEXTRA", 0.04)]
    );

    expect(comparison.matchedCount).toBe(0);
    expect(comparison.missingFromNormalized).toEqual([
      expect.objectContaining({ marketId: "KXEXISTING", signalType: "binary_complement_arb", estimatedEdge: 0.04 })
    ]);
    expect(comparison.extraFromNormalized).toEqual([
      expect.objectContaining({ marketId: "KXEXTRA", signalType: "binary_complement_arb", estimatedEdge: 0.04 })
    ]);
    expect(comparison.notes[0]).toContain("Matched by signalType");
  });
});

function normalizedMarket(
  marketId: string,
  title: string,
  values: { yesAsk: number; yesBid: number; noAsk?: number; noBid?: number; eventTicker?: string }
): NormalizedMarket {
  return {
    platform: "kalshi",
    marketId,
    title,
    closeTime,
    status: "active",
    outcomes: [
      { outcomeId: "yes", label: "YES", yesBid: values.yesBid, yesAsk: values.yesAsk, liquidity: 10 },
      { outcomeId: "no", label: "NO", yesBid: values.noBid ?? 0.2, yesAsk: values.noAsk ?? 0.8, liquidity: 10 }
    ],
    raw: { event_ticker: values.eventTicker }
  };
}

function signal(signalType: NormalizedSignal["signalType"], marketId: string, estimatedEdge: number): NormalizedSignal {
  return {
    signalId: `${signalType}:${marketId}`,
    platform: "kalshi",
    marketId,
    signalType,
    detectedAt: detectedAt.toISOString(),
    estimatedEdge,
    reason: "fixture"
  };
}
