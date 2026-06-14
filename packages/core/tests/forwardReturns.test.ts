import { describe, expect, it } from "vitest";
import {
  buildForwardReturnCoverageDiagnostics,
  bucketForwardReturnValue,
  bucketNumericValue,
  calculateNearMissDistanceToThreshold,
  classifyNearMissBucket,
  classifyNearMissBucketFromNetEdge,
  classifyForwardReturnMissingExit,
  classifyForwardReturnRejectionReason,
  chooseEntryPrice,
  chooseExitPrice,
  computeForwardReturn,
  filterForwardReturnSignalsByStatusAndReason,
  selectForwardReturnSignals,
  summarizeForwardReturnSignalSelection,
  summarizeForwardReturnsByBucket,
  summarizeMissingExitReasons,
  summarizeForwardReturns,
  type ForwardReturnResearchRow,
  type ForwardReturnSnapshotInput
} from "../src";

describe("forward return helpers", () => {
  it("selects binary complement entry price from persisted signal raw ask prices", () => {
    expect(
      chooseEntryPrice({
        strategy: "binary_complement_arb",
        rawJson: { yesAsk: 0.42, noAsk: 0.51 }
      })
    ).toBe(0.93);
  });

  it("falls back to the nearest snapshot for binary complement entry price", () => {
    expect(
      chooseEntryPrice(
        { strategy: "binary_complement_arb", rawJson: {} },
        snapshot({ bestYesAsk: 0.44, bestNoAsk: 0.5 })
      )
    ).toBe(0.94);
  });

  it("selects multi-outcome entry price from total cost or leg ask prices", () => {
    expect(chooseEntryPrice({ strategy: "multi_outcome_arb", rawJson: { totalYesAskCost: 0.97 } })).toBe(0.97);
    expect(
      chooseEntryPrice({
        strategy: "multi_outcome_arb",
        rawJson: { legs: [{ yesAsk: 0.31 }, { yesAsk: 0.33 }, { yesAsk: 0.32 }] }
      })
    ).toBe(0.96);
  });

  it("selects conservative bid-side exit prices", () => {
    expect(
      chooseExitPrice(
        { strategy: "binary_complement_arb" },
        snapshot({ bestYesBid: 0.45, bestNoBid: 0.5 })
      )
    ).toBe(0.95);
    expect(
      chooseExitPrice(
        { strategy: "multi_outcome_arb" },
        [snapshot({ bestYesBid: 0.31 }), snapshot({ bestYesBid: 0.35 })]
      )
    ).toBe(0.66);
  });

  it("computes absolute, percent, and win/loss return fields", () => {
    expect(computeForwardReturn(0.9, 0.99)).toEqual({
      returnAbs: 0.09,
      returnPct: 0.1,
      wasProfitable: true
    });
    expect(computeForwardReturn(0.9, null)).toEqual({
      returnAbs: null,
      returnPct: null,
      wasProfitable: null
    });
  });

  it("summarizes by strategy and overall while tracking missing exits", () => {
    const rows: ForwardReturnResearchRow[] = [
      row("A", "binary_complement_arb", "15m", 0.9, 0.99),
      row("B", "binary_complement_arb", "15m", 1, 0.97),
      {
        ...row("C", "binary_complement_arb", "15m", 1, null),
        missingExit: true
      },
      row("D", "multi_outcome_arb", "60m", 0.95, 1)
    ];

    const summary = summarizeForwardReturns(rows);

    expect(summary.byStrategy).toEqual([
      expect.objectContaining({
        strategy: "binary_complement_arb",
        window: "15m",
        count: 2,
        avgReturnAbs: 0.03,
        avgReturnPct: 0.035,
        winRate: 0.5,
        missingExitCount: 1
      }),
      expect.objectContaining({
        strategy: "multi_outcome_arb",
        window: "60m",
        count: 1,
        avgReturnAbs: 0.05,
        avgReturnPct: 0.052632,
        winRate: 1,
        missingExitCount: 0
      })
    ]);
    expect(summary.overall).toContainEqual(
      expect.objectContaining({
        window: "15m",
        count: 2,
        missingExitCount: 1
      })
    );
  });

  it("assigns numeric values to configured forward-return buckets", () => {
    expect(
      bucketNumericValue(0.97, [
        { label: "< 0.95", max: 0.95 },
        { label: "0.95-0.98", min: 0.95, max: 0.98 }
      ])
    ).toBe("0.95-0.98");
    expect(bucketForwardReturnValue("entryCost", 0.94)).toBe("< 0.95");
    expect(bucketForwardReturnValue("estimatedEdge", -0.03)).toBe("-0.05--0.02");
    expect(bucketForwardReturnValue("spread", 0.07)).toBe("0.05-0.10");
  });

  it("calculates distance from the minimum net-edge acceptance threshold", () => {
    expect(calculateNearMissDistanceToThreshold(0.004, 0.005)).toBe(0.001);
    expect(calculateNearMissDistanceToThreshold(-0.015, 0.005)).toBe(0.02);
    expect(calculateNearMissDistanceToThreshold(0.006, 0.005)).toBe(0);
  });

  it("assigns near-miss buckets by distance from acceptance", () => {
    expect(classifyNearMissBucket(0.005)).toBe("within 0.005");
    expect(classifyNearMissBucket(0.006)).toBe("within 0.010");
    expect(classifyNearMissBucket(0.02)).toBe("within 0.020");
    expect(classifyNearMissBucket(0.021)).toBe("farther than 0.020");
    expect(classifyNearMissBucketFromNetEdge(0.004, 0.005)).toBe("within 0.005");
  });

  it("returns no near-miss bucket when netEdge or threshold is unavailable", () => {
    expect(calculateNearMissDistanceToThreshold(null, 0.005)).toBeNull();
    expect(calculateNearMissDistanceToThreshold(0.001, undefined)).toBeNull();
    expect(classifyNearMissBucketFromNetEdge("not-a-number", 0.005)).toBeNull();
  });

  it("reports bucket dimensions unavailable when rows have no bucket labels", () => {
    const summary = summarizeForwardReturnsByBucket([row("A", "binary_complement_arb", "15m", 0.9, 0.95)], "spread");

    expect(summary.available).toBe(false);
    expect(summary.rows).toEqual([]);
  });

  it("summarizes forward returns by bucket and window", () => {
    const rows: ForwardReturnResearchRow[] = [
      { ...row("A", "binary_complement_arb", "15m", 0.9, 0.99), bucketLabels: { entryCost: "< 0.95" } },
      { ...row("B", "binary_complement_arb", "15m", 0.94, 0.9), bucketLabels: { entryCost: "< 0.95" } },
      { ...row("C", "binary_complement_arb", "30m", 1.01, 1.02), bucketLabels: { entryCost: "1.00-1.02" } }
    ];

    const summary = summarizeForwardReturnsByBucket(rows, "entryCost");

    expect(summary.available).toBe(true);
    expect(summary.rows).toEqual([
      expect.objectContaining({
        bucket: "< 0.95",
        window: "15m",
        count: 2,
        avgReturnAbs: 0.025,
        winRate: 0.5
      }),
      expect.objectContaining({
        bucket: "1.00-1.02",
        window: "30m",
        count: 1,
        avgReturnAbs: 0.01,
        winRate: 1
      })
    ]);
  });

  it("summarizes near-miss buckets without changing existing bucket behavior", () => {
    const rows: ForwardReturnResearchRow[] = [
      {
        ...row("A", "binary_complement_arb", "15m", 0.9, 0.91),
        bucketLabels: { nearMiss: "within 0.005", entryCost: "< 0.95" }
      },
      {
        ...row("B", "binary_complement_arb", "15m", 0.9, 0.87),
        bucketLabels: { nearMiss: "within 0.010", entryCost: "< 0.95" }
      }
    ];

    expect(summarizeForwardReturnsByBucket(rows, "nearMiss").rows).toEqual([
      expect.objectContaining({ bucket: "within 0.005", window: "15m", count: 1, avgReturnAbs: 0.01 }),
      expect.objectContaining({ bucket: "within 0.010", window: "15m", count: 1, avgReturnAbs: -0.03 })
    ]);
    expect(summarizeForwardReturnsByBucket(rows, "entryCost").rows).toEqual([
      expect.objectContaining({ bucket: "< 0.95", window: "15m", count: 2 })
    ]);
  });

  it("filters signals by minimum age and orders oldest first by default research shape", () => {
    const selected = selectForwardReturnSignals(
      [
        signal("new", "2026-06-13T00:50:00.000Z"),
        signal("old", "2026-06-13T00:05:00.000Z"),
        signal("middle", "2026-06-13T00:30:00.000Z")
      ],
      {
        limit: 2,
        minAgeMinutes: 15,
        order: "oldest",
        referenceTime: "2026-06-13T01:00:00.000Z"
      }
    );

    expect(selected.map((item) => item.id)).toEqual(["old", "middle"]);
  });

  it("orders newest first after applying the same min-age cutoff", () => {
    const selected = selectForwardReturnSignals(
      [
        signal("new", "2026-06-13T00:50:00.000Z"),
        signal("old", "2026-06-13T00:05:00.000Z"),
        signal("middle", "2026-06-13T00:30:00.000Z")
      ],
      {
        limit: 2,
        minAgeMinutes: 15,
        order: "newest",
        referenceTime: "2026-06-13T01:00:00.000Z"
      }
    );

    expect(selected.map((item) => item.id)).toEqual(["middle", "old"]);
  });

  it("classifies missing exits by age, market coverage, and unsupported strategy shape", () => {
    const base = {
      signalDetectedAt: "2026-06-13T00:00:00.000Z",
      targetTime: "2026-06-13T00:15:00.000Z",
      newestSnapshotAt: "2026-06-13T00:30:00.000Z",
      marketRefs: [{ marketId: "market-1", ticker: "KXTEST" }],
      strategy: "binary_complement_arb",
      hasAnyFutureSnapshot: true,
      hasSnapshotAtOrAfterWindow: true
    };

    expect(classifyForwardReturnMissingExit({ ...base, marketRefs: [] })).toBe("missing_market_identifier");
    expect(classifyForwardReturnMissingExit({ ...base, strategy: "unknown_strategy" })).toBe("unsupported_strategy_shape");
    expect(
      classifyForwardReturnMissingExit({
        ...base,
        targetTime: "2026-06-13T00:45:00.000Z"
      })
    ).toBe("signal_too_recent");
    expect(classifyForwardReturnMissingExit({ ...base, hasAnyFutureSnapshot: false })).toBe("no_future_snapshot_for_market");
    expect(classifyForwardReturnMissingExit({ ...base, hasSnapshotAtOrAfterWindow: false })).toBe(
      "no_snapshot_at_or_after_window"
    );
  });

  it("builds coverage diagnostics for selected signal age and later snapshot coverage", () => {
    const diagnostics = buildForwardReturnCoverageDiagnostics({
      newestSnapshotAt: "2026-06-13T00:30:00.000Z",
      windows: [
        { window: "15m", minutes: 15 },
        { window: "30m", minutes: 30 },
        { window: "60m", minutes: 60 }
      ],
      signals: [
        {
          signalId: "old",
          detectedAt: "2026-06-13T00:00:00.000Z",
          marketRefs: [{ marketId: "market-1", ticker: "KXTEST" }],
          hasLaterSnapshot: true
        },
        {
          signalId: "recent",
          detectedAt: "2026-06-13T00:20:00.000Z",
          marketRefs: [],
          hasLaterSnapshot: false
        }
      ]
    });

    expect(diagnostics.oldestSelectedSignalAt?.toISOString()).toBe("2026-06-13T00:00:00.000Z");
    expect(diagnostics.newestSelectedSignalAt?.toISOString()).toBe("2026-06-13T00:20:00.000Z");
    expect(diagnostics.olderThanWindowCounts).toEqual([
      { window: "15m", minutes: 15, count: 1 },
      { window: "30m", minutes: 30, count: 1 },
      { window: "60m", minutes: 60, count: 0 }
    ]);
    expect(diagnostics.signalsWithLaterSnapshotCount).toBe(1);
    expect(diagnostics.signalsWithoutLaterSnapshotCount).toBe(1);
    expect(diagnostics.missingMarketIdentifierCount).toBe(1);
  });

  it("summarizes missing exit classifications by window and reason", () => {
    const rows: ForwardReturnResearchRow[] = [
      {
        ...row("A", "binary_complement_arb", "15m", 0.9, null),
        missingExit: true,
        missingExitReason: "signal_too_recent"
      },
      {
        ...row("B", "binary_complement_arb", "15m", 0.9, null),
        missingExit: true,
        missingExitReason: "signal_too_recent"
      },
      {
        ...row("C", "binary_complement_arb", "30m", 0.9, null),
        missingExit: true,
        missingExitReason: "no_future_snapshot_for_market"
      }
    ];

    expect(summarizeMissingExitReasons(rows)).toEqual([
      { window: "15m", reason: "signal_too_recent", count: 2 },
      { window: "30m", reason: "no_future_snapshot_for_market", count: 1 }
    ]);
  });

  it("preserves all statuses by default when filtering signal selection rows", () => {
    const signals = [
      selectionSignal("accepted-1", "accepted", "Accepted: estimated net edge 0.0100 with 10 available contracts."),
      selectionSignal("rejected-1", "rejected", "Rejected: estimated net edge 0.0010 is below minimum 0.0050.")
    ];

    expect(filterForwardReturnSignalsByStatusAndReason(signals, { status: "all" }).map((signal) => signal.id)).toEqual([
      "accepted-1",
      "rejected-1"
    ]);
  });

  it("filters accepted and rejected signal selection rows", () => {
    const signals = [
      selectionSignal("accepted-1", "accepted", "Accepted: estimated net edge 0.0100 with 10 available contracts."),
      selectionSignal("rejected-1", "rejected", "Rejected: orderbook is empty; missing YES and NO liquidity."),
      selectionSignal("rejected-2", "rejected", "Rejected: estimated net edge 0.0010 is below minimum 0.0050.")
    ];

    expect(filterForwardReturnSignalsByStatusAndReason(signals, { status: "accepted" }).map((signal) => signal.id)).toEqual([
      "accepted-1"
    ]);
    expect(filterForwardReturnSignalsByStatusAndReason(signals, { status: "rejected" }).map((signal) => signal.id)).toEqual([
      "rejected-1",
      "rejected-2"
    ]);
  });

  it("filters rejection reasons using persisted reason text and grouped rejection codes", () => {
    const signals = [
      selectionSignal("empty", "rejected", "Rejected: orderbook is empty; missing YES and NO liquidity."),
      selectionSignal("binary-low-edge", "rejected", "Rejected: estimated net edge 0.0010 is below minimum 0.0050."),
      selectionSignal("group-low-edge", "rejected", "Rejected: estimated net edge 0.0010 is below minimum 0.0050.", {
        rejectionCode: "low_edge"
      })
    ];

    expect(
      filterForwardReturnSignalsByStatusAndReason(signals, { status: "rejected", rejectionReason: "low edge" }).map(
        (signal) => signal.id
      )
    ).toEqual(["binary-low-edge", "group-low-edge"]);
    expect(
      filterForwardReturnSignalsByStatusAndReason(signals, { status: "rejected", rejectionReason: "empty orderbook" }).map(
        (signal) => signal.id
      )
    ).toEqual(["empty"]);
  });

  it("groups top rejection reasons from selected signals", () => {
    const summary = summarizeForwardReturnSignalSelection([
      selectionSignal("accepted", "accepted", "Accepted: estimated net edge 0.0100 with 10 available contracts."),
      selectionSignal("low-edge-1", "rejected", "Rejected: estimated net edge 0.0010 is below minimum 0.0050."),
      selectionSignal("low-edge-2", "rejected", "Rejected: estimated net edge 0.0020 is below minimum 0.0050."),
      selectionSignal("stale", "rejected", "Rejected: one or more snapshots are stale."),
      selectionSignal("group-liquidity", "rejected", "Rejected: group YES liquidity 1 is below minimum 5.", {
        rejectionCode: "low_liquidity"
      })
    ]);

    expect(summary.acceptedCount).toBe(1);
    expect(summary.rejectedCount).toBe(4);
    expect(summary.topRejectionReasons).toEqual([
      { reason: "low_edge", count: 2 },
      { reason: "low_liquidity", count: 1 },
      { reason: "stale_snapshot", count: 1 }
    ]);
  });

  it("classifies persisted rejection reasons into stable research buckets", () => {
    expect(
      classifyForwardReturnRejectionReason(
        selectionSignal("low-edge", "rejected", "Rejected: estimated net edge 0.0010 is below minimum 0.0050.")
      )
    ).toBe("low_edge");
    expect(
      classifyForwardReturnRejectionReason(selectionSignal("group", "rejected", "Rejected: low edge.", { rejectionCode: "low_edge" }))
    ).toBe("low_edge");
  });
});

function snapshot(values: Partial<ForwardReturnSnapshotInput>): ForwardReturnSnapshotInput {
  return values;
}

function row(
  signalId: string,
  strategy: string,
  window: ForwardReturnResearchRow["window"],
  entryPrice: number,
  exitPrice: number | null
): ForwardReturnResearchRow {
  const computed = computeForwardReturn(entryPrice, exitPrice);
  return {
    signalId,
    strategy,
    window,
    entryPrice,
    exitPrice,
    missingEntry: false,
    missingExit: exitPrice === null,
    ...computed
  };
}

function signal(id: string, detectedAt: string): { id: string; detectedAt: string } {
  return { id, detectedAt };
}

function selectionSignal(
  id: string,
  status: string,
  reason: string,
  rawJson: Record<string, unknown> = {}
): { id: string; status: string; reason: string; rawJson: Record<string, unknown> } {
  return { id, status, reason, rawJson };
}
