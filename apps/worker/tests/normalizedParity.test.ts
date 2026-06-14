import { describe, expect, it } from "vitest";
import {
  buildNormalizedParityReport,
  formatNormalizedParityDebugCounts,
  formatNormalizedParityReport,
  NormalizedParityOptionsError,
  parseNormalizedParityOptions,
  selectSignalSamples
} from "../src/normalizedParity";
import type { SignalComparisonEntry, SignalOutputComparisonResult } from "@prediction-market-scanner/core";

describe("normalized parity helpers", () => {
  it("parses named cli flags", () => {
    const options = parseNormalizedParityOptions(["--limit", "10", "--lookback-hours=6", "--verbose", "--debug-counts"], {});

    expect(options).toEqual({
      limit: 10,
      lookbackHours: 6,
      verbose: true,
      debugCounts: true
    });
  });

  it("parses positional arguments as limit and lookback hours", () => {
    const options = parseNormalizedParityOptions(["25", "720"], {});

    expect(options).toEqual({
      limit: 25,
      lookbackHours: 720,
      verbose: false,
      debugCounts: false
    });
  });

  it("parses environment variables", () => {
    const options = parseNormalizedParityOptions([], {
      PARITY_LIMIT: "30",
      PARITY_LOOKBACK_HOURS: "48",
      PARITY_VERBOSE: "true",
      PARITY_DEBUG_COUNTS: "true"
    });

    expect(options).toEqual({
      limit: 30,
      lookbackHours: 48,
      verbose: true,
      debugCounts: true
    });
  });

  it("parses cli options over environment defaults", () => {
    const options = parseNormalizedParityOptions(["--limit", "10", "--lookback-hours=6", "--verbose"], {
      PARITY_LIMIT: "25",
      PARITY_LOOKBACK_HOURS: "24",
      PARITY_VERBOSE: "false",
      PARITY_DEBUG_COUNTS: "true"
    });

    expect(options).toEqual({
      limit: 10,
      lookbackHours: 6,
      verbose: true,
      debugCounts: true
    });
  });

  it("parses positional arguments over environment defaults", () => {
    const options = parseNormalizedParityOptions(["20", "96"], {
      PARITY_LIMIT: "25",
      PARITY_LOOKBACK_HOURS: "-1"
    });

    expect(options.limit).toBe(20);
    expect(options.lookbackHours).toBe(96);
  });

  it("fails clearly for invalid numeric options", () => {
    expect(() => parseNormalizedParityOptions(["--limit", "0"], {})).toThrow(NormalizedParityOptionsError);
    expect(() => parseNormalizedParityOptions(["--lookback-hours", "soon"], {})).toThrow(
      "Invalid lookback-hours from named flag: expected a positive number, received soon."
    );
  });

  it("formats debug counts", () => {
    expect(
      formatNormalizedParityDebugCounts({
        totalMarkets: 2,
        totalOrderbookSnapshots: 5,
        newestMarketTimestamp: new Date("2026-06-13T12:00:00.000Z"),
        newestOrderbookSnapshotTimestamp: null,
        snapshotsInsideLookback: 3
      })
    ).toBe(
      [
        "Normalized Signal Parity Debug Counts",
        "Total Market rows: 2",
        "Total OrderbookSnapshot rows: 5",
        "Newest Market updated/created timestamp: 2026-06-13T12:00:00.000Z",
        "Newest OrderbookSnapshot timestamp: none",
        "Snapshots inside selected lookback window: 3"
      ].join("\n")
    );
  });

  it("builds parity report totals from comparison results", () => {
    const report = buildNormalizedParityReport({
      lookbackHours: 12,
      marketsEvaluated: 4,
      snapshotsEvaluated: 3,
      comparison: comparisonResult({
        existingCount: 4,
        normalizedCount: 5,
        matchedCount: 3,
        missingFromNormalized: [entry("KXMISSING")],
        extraFromNormalized: [entry("KXEXTRA1"), entry("KXEXTRA2")]
      }),
      sampleSize: 1
    });

    expect(report).toEqual(
      expect.objectContaining({
        lookbackHours: 12,
        marketsEvaluated: 4,
        snapshotsEvaluated: 3,
        existingDetectorSignals: 4,
        normalizedEvaluatorSignals: 5,
        matchedSignals: 3,
        missingFromNormalized: 1,
        extraFromNormalized: 2,
        missingSamples: [entry("KXMISSING")],
        extraSamples: [entry("KXEXTRA1")]
      })
    );
  });

  it("formats summary and verbose samples", () => {
    const report = buildNormalizedParityReport({
      lookbackHours: 24,
      marketsEvaluated: 2,
      snapshotsEvaluated: 2,
      comparison: comparisonResult({
        existingCount: 2,
        normalizedCount: 1,
        matchedCount: 1,
        missingFromNormalized: [entry("KXMISSING", 0.01, "Rejected: fixture.")],
        extraFromNormalized: []
      })
    });

    expect(formatNormalizedParityReport(report, { verbose: true })).toContain("Missing from normalized: 1");
    expect(formatNormalizedParityReport(report, { verbose: true })).toContain(
      "market=KXMISSING | type=binary_complement_arb | edge=0.010000 | reason=Rejected: fixture."
    );
    expect(formatNormalizedParityReport(report, { verbose: true })).toContain("Extra from normalized sample:\n  none");
  });

  it("selects a bounded sample", () => {
    expect(selectSignalSamples([entry("A"), entry("B"), entry("C")], 2)).toEqual([entry("A"), entry("B")]);
  });
});

function comparisonResult(overrides: Partial<SignalOutputComparisonResult>): SignalOutputComparisonResult {
  return {
    existingCount: 0,
    normalizedCount: 0,
    matchedCount: 0,
    missingFromNormalized: [],
    extraFromNormalized: [],
    notes: [],
    ...overrides
  };
}

function entry(marketId: string, estimatedEdge = 0.02, reason = "fixture"): SignalComparisonEntry {
  return {
    platform: "kalshi",
    marketId,
    signalType: "binary_complement_arb",
    estimatedEdge,
    reason
  };
}
