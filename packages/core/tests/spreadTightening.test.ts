import { describe, expect, it } from "vitest";
import {
  buildSpreadTighteningRow,
  classifySpreadBucket,
  computeSpreadChange,
  findFirstSnapshotAtOrAfter,
  getSnapshotSpread,
  summarizeSpreadTightening,
  type SpreadTighteningResearchRow,
  type SpreadTighteningSnapshotInput
} from "../src";

describe("spread tightening helpers", () => {
  it("extracts a reliable stored spread before falling back to bid ask fields", () => {
    expect(getSnapshotSpread({ spread: "0.031", bestYesBid: 0.4, bestYesAsk: 0.5 })).toBe(0.031);
    expect(getSnapshotSpread({ bestYesBid: 0.41, bestYesAsk: 0.46 })).toBe(0.05);
    expect(getSnapshotSpread({ spread: -0.01, bestNoBid: 0.35, bestNoAsk: 0.42 })).toBe(0.07);
    expect(getSnapshotSpread({ bestYesBid: 0.5 })).toBeNull();
  });

  it("computes spread change, percent change, and tightened flag", () => {
    expect(computeSpreadChange(0.1, 0.06)).toEqual({
      spreadChange: -0.04,
      spreadChangePct: -0.4,
      tightened: true
    });
    expect(computeSpreadChange(0, 0.01)).toEqual({
      spreadChange: 0.01,
      spreadChangePct: null,
      tightened: false
    });
    expect(computeSpreadChange(0.1, null)).toEqual({
      spreadChange: null,
      spreadChangePct: null,
      tightened: null
    });
  });

  it("classifies configured entry spread buckets", () => {
    expect(classifySpreadBucket(0.019)).toBe("< 0.02");
    expect(classifySpreadBucket(0.02)).toBe("0.02-0.05");
    expect(classifySpreadBucket(0.05)).toBe("0.05-0.10");
    expect(classifySpreadBucket(0.1)).toBe("> 0.10");
    expect(classifySpreadBucket(null)).toBeNull();
  });

  it("summarizes overall, bucket, category, and ticker tightening", () => {
    const rows: SpreadTighteningResearchRow[] = [
      row("A", "Weather", "15m", 0.08, 0.04),
      row("B", "Weather", "15m", 0.08, 0.1),
      row("C", "Politics", "30m", 0.12, 0.08),
      { ...row("D", "Weather", "15m", 0.03, null), missingExit: true }
    ];

    const summary = summarizeSpreadTightening(rows);

    expect(summary.overall).toContainEqual(
      expect.objectContaining({
        window: "15m",
        count: 2,
        avgEntrySpread: 0.08,
        avgFutureSpread: 0.07,
        avgSpreadChange: -0.01,
        tightenRate: 0.5,
        missingExitCount: 1
      })
    );
    expect(summary.byBucket).toContainEqual(expect.objectContaining({ bucket: "0.05-0.10", window: "15m", count: 2 }));
    expect(summary.byCategory).toContainEqual(expect.objectContaining({ category: "Weather", window: "15m", count: 2 }));
    expect(summary.byTicker[0]).toEqual(expect.objectContaining({ ticker: "A", avgSpreadChange: -0.04 }));
  });

  it("builds rows with missing future snapshots excluded from averages", () => {
    const built = buildSpreadTighteningRow({
      marketId: "market-1",
      ticker: "KXTEST",
      detectedAt: "2026-06-13T00:00:00.000Z",
      window: "240m",
      entrySnapshot: snapshot("2026-06-13T00:00:00.000Z", 0.09),
      futureSnapshot: null
    });

    expect(built).toEqual(
      expect.objectContaining({
        entrySpread: 0.09,
        futureSpread: null,
        spreadChange: null,
        tightened: null,
        missingExit: true,
        bucket: "0.05-0.10"
      })
    );
  });

  it("finds the first future snapshot at or after a target time", () => {
    const snapshots = [
      snapshot("2026-06-13T00:30:00.000Z", 0.05),
      snapshot("2026-06-13T00:15:00.000Z", 0.07),
      snapshot("2026-06-13T00:45:00.000Z", 0.04)
    ];

    expect(findFirstSnapshotAtOrAfter(snapshots, "2026-06-13T00:20:00.000Z")?.capturedAt).toBe("2026-06-13T00:30:00.000Z");
    expect(findFirstSnapshotAtOrAfter(snapshots, "2026-06-13T01:00:00.000Z")).toBeNull();
  });
});

function row(
  ticker: string,
  category: string,
  window: SpreadTighteningResearchRow["window"],
  entrySpread: number,
  futureSpread: number | null
): SpreadTighteningResearchRow {
  const calculation = computeSpreadChange(entrySpread, futureSpread);
  return {
    marketId: `market-${ticker}`,
    ticker,
    title: `Title ${ticker}`,
    category,
    detectedAt: new Date("2026-06-13T00:00:00.000Z"),
    window,
    entrySpread,
    futureSpread,
    missingExit: futureSpread === null,
    bucket: classifySpreadBucket(entrySpread),
    ...calculation
  };
}

function snapshot(capturedAt: string, spread: number): SpreadTighteningSnapshotInput {
  return { capturedAt, spread };
}
