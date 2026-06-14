import { describe, expect, it } from "vitest";
import { computeForwardReturn, type ForwardReturnResearchRow } from "@prediction-market-scanner/core";
import { formatForwardReturnReport, parseForwardReturnsOptions } from "../src/researchForwardReturns";

describe("research forward returns CLI options", () => {
  it("defaults to all signal statuses", () => {
    expect(parseForwardReturnsOptions([], {}).status).toBe("all");
  });

  it("parses status from a named argument", () => {
    expect(parseForwardReturnsOptions(["--status", "accepted"], {}).status).toBe("accepted");
    expect(parseForwardReturnsOptions(["--status=rejected"], {}).status).toBe("rejected");
  });

  it("parses status from the environment", () => {
    expect(parseForwardReturnsOptions([], { RESEARCH_SIGNAL_STATUS: "rejected" }).status).toBe("rejected");
  });

  it("rejects invalid status values", () => {
    expect(() => parseForwardReturnsOptions(["--status", "pending"], {})).toThrow(
      "Invalid status from named flag: expected accepted, rejected, or all"
    );
  });

  it("parses rejection reason from the long flag, alias, and environment", () => {
    expect(parseForwardReturnsOptions(["--rejection-reason", "low edge"], {}).rejectionReason).toBe("low edge");
    expect(parseForwardReturnsOptions(["--reason=empty orderbook"], {}).rejectionReason).toBe("empty orderbook");
    expect(parseForwardReturnsOptions([], { RESEARCH_REJECTION_REASON: "stale snapshot" }).rejectionReason).toBe("stale snapshot");
  });

  it("parses status and rejection reason from positional arguments forwarded by the root npm script", () => {
    const options = parseForwardReturnsOptions(["500", "720", "240", "newest", "rejected", "low edge"], {});

    expect(options.status).toBe("rejected");
    expect(options.rejectionReason).toBe("low edge");
  });

  it("parses bucket-by from the named flag and environment", () => {
    expect(parseForwardReturnsOptions(["--bucket-by", "entryCost"], {}).bucketBy).toBe("entryCost");
    expect(parseForwardReturnsOptions(["--bucket-by=estimatedEdge"], {}).bucketBy).toBe("estimatedEdge");
    expect(parseForwardReturnsOptions([], { RESEARCH_FORWARD_RETURNS_BUCKET_BY: "spread" }).bucketBy).toBe("spread");
    expect(parseForwardReturnsOptions(["--bucket-by", "nearMiss"], {}).bucketBy).toBe("nearMiss");
  });

  it("rejects invalid bucket dimensions", () => {
    expect(() => parseForwardReturnsOptions(["--bucket-by", "ticker"], {})).toThrow(
      "Invalid bucket-by from named flag: expected entryCost, estimatedEdge, netEdge, spread, strategy, reason, or nearMiss"
    );
  });

  it("prints bucket analysis for fake forward-return rows", () => {
    const report = formatForwardReturnReport(
      reportInput({
        bucketBy: "entryCost",
        rows: [
          { ...row("A", "15m", 0.94, 0.96), bucketLabels: { entryCost: "< 0.95" } },
          { ...row("B", "15m", 1.01, 0.99), bucketLabels: { entryCost: "1.00-1.02" } }
        ]
      })
    );

    expect(report).toContain("Bucket analysis:");
    expect(report).toContain("Bucket by: entryCost");
    expect(report).toContain("< 0.95");
    expect(report).toContain("1.00-1.02");
  });

  it("prints unavailable bucket fields and preserves the default report when bucket-by is omitted", () => {
    const withoutBucket = formatForwardReturnReport(reportInput({ bucketBy: null, rows: [row("A", "15m", 0.94, 0.96)] }));
    expect(withoutBucket).not.toContain("Bucket analysis:");

    const unavailable = formatForwardReturnReport(reportInput({ bucketBy: "spread", rows: [row("A", "15m", 0.94, 0.96)] }));
    expect(unavailable).toContain("Bucket field unavailable for selected signals: spread");
  });

  it("prints near-miss bucket analysis and diagnostics", () => {
    const report = formatForwardReturnReport({
      ...reportInput({
        bucketBy: "nearMiss",
        rows: [
          { ...row("A", "15m", 0.94, 0.93), bucketLabels: { nearMiss: "within 0.005" } },
          { ...row("B", "15m", 0.94, 0.9), bucketLabels: { nearMiss: "farther than 0.020" } }
        ]
      }),
      nearMissDiagnostics: {
        thresholdSource: "production config loadWorkerConfig().detection.minNetEdge",
        minNetEdge: 0.005,
        sourceKind: "production config",
        usableNetEdgeSignals: 2,
        selectedLowEdgeSignals: 2
      }
    });

    expect(report).toContain("Bucket by: nearMiss");
    expect(report).toContain("Near-miss diagnostics:");
    expect(report).toContain("Min net edge threshold used: 0.005000");
    expect(report).toContain("Selected low_edge signals with usable netEdge values: 2 of 2");
    expect(report).toContain("within 0.005");
    expect(report).toContain("farther than 0.020");
  });
});

function reportInput(values: {
  bucketBy: ReturnType<typeof parseForwardReturnsOptions>["bucketBy"];
  rows: ForwardReturnResearchRow[];
}): Parameters<typeof formatForwardReturnReport>[0] {
  return {
    options: {
      limit: 100,
      lookbackHours: 720,
      minAgeMinutes: 240,
      order: "newest",
      status: "rejected",
      rejectionReason: "low_edge",
      bucketBy: values.bucketBy
    },
    signalDetectedAtCutoff: new Date("2026-06-13T00:00:00.000Z"),
    signalsEvaluated: 1,
    signalSelectionSummary: {
      acceptedCount: 0,
      rejectedCount: 1,
      topRejectionReasons: [{ reason: "low_edge", count: 1 }]
    },
    coverageDiagnostics: {
      selectedSignals: 1,
      oldestSelectedSignalAt: new Date("2026-06-12T20:00:00.000Z"),
      newestSelectedSignalAt: new Date("2026-06-12T20:00:00.000Z"),
      newestAvailableSnapshotAt: new Date("2026-06-13T00:00:00.000Z"),
      olderThanWindowCounts: [
        { window: "15m", minutes: 15, count: 1 },
        { window: "30m", minutes: 30, count: 1 },
        { window: "60m", minutes: 60, count: 1 },
        { window: "240m", minutes: 240, count: 1 }
      ],
      signalsWithLaterSnapshotCount: 1,
      signalsWithoutLaterSnapshotCount: 0,
      missingMarketIdentifierCount: 0
    },
    nearMissDiagnostics: null,
    missingExitReasons: [],
    rows: values.rows
  };
}

function row(signalId: string, window: ForwardReturnResearchRow["window"], entryPrice: number, exitPrice: number): ForwardReturnResearchRow {
  return {
    signalId,
    strategy: "binary_complement_arb",
    window,
    entryPrice,
    exitPrice,
    missingEntry: false,
    missingExit: false,
    ...computeForwardReturn(entryPrice, exitPrice)
  };
}
