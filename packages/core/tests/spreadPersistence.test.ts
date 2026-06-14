import { describe, expect, it } from "vitest";
import {
  bucketEpisodeDuration,
  buildSpreadEpisodes,
  isSpreadInRange,
  selectTopSpreadEpisodes,
  summarizeSpreadEpisodes,
  type SpreadPersistenceSnapshotInput
} from "../src";

describe("spread persistence helpers", () => {
  it("checks spread ranges inclusively", () => {
    expect(isSpreadInRange(0.04, 0.04, 0.1)).toBe(true);
    expect(isSpreadInRange("0.10", 0.04, 0.1)).toBe(true);
    expect(isSpreadInRange(0.039, 0.04, 0.1)).toBe(false);
    expect(isSpreadInRange(null, 0.04, 0.1)).toBe(false);
  });

  it("builds contiguous wide-spread episodes sorted by ticker and captured time", () => {
    const episodes = buildSpreadEpisodes(
      [
        snapshot("KXB", "2026-06-13T00:01:00.000Z", 0.07),
        snapshot("KXA", "2026-06-13T00:02:00.000Z", 0.08),
        snapshot("KXA", "2026-06-13T00:00:00.000Z", 0.06)
      ],
      options()
    );

    expect(episodes).toEqual([
      expect.objectContaining({ ticker: "KXA", durationMinutes: 2, snapshotCount: 2, avgSpread: 0.07, maxSpread: 0.08 }),
      expect.objectContaining({ ticker: "KXB", durationMinutes: 0, snapshotCount: 1, avgSpread: 0.07, maxSpread: 0.07 })
    ]);
  });

  it("splits episodes when spread leaves the configured range", () => {
    const episodes = buildSpreadEpisodes(
      [
        snapshot("KXWIDE", "2026-06-13T00:00:00.000Z", 0.06),
        snapshot("KXWIDE", "2026-06-13T00:01:00.000Z", 0.08),
        snapshot("KXWIDE", "2026-06-13T00:02:00.000Z", 0.02),
        snapshot("KXWIDE", "2026-06-13T00:03:00.000Z", 0.09)
      ],
      options()
    );

    expect(episodes).toHaveLength(2);
    expect(episodes[0]).toEqual(expect.objectContaining({ durationMinutes: 1, snapshotCount: 2, tightened: true }));
    expect(episodes[1]).toEqual(expect.objectContaining({ durationMinutes: 0, snapshotCount: 1, tightened: null }));
  });

  it("splits episodes when the time gap exceeds max gap minutes", () => {
    const episodes = buildSpreadEpisodes(
      [
        snapshot("KXGAP", "2026-06-13T00:00:00.000Z", 0.06),
        snapshot("KXGAP", "2026-06-13T00:01:00.000Z", 0.07),
        snapshot("KXGAP", "2026-06-13T00:04:30.000Z", 0.08)
      ],
      options({ maxGapMinutes: 2 })
    );

    expect(episodes).toHaveLength(2);
    expect(episodes[0]).toEqual(expect.objectContaining({ durationMinutes: 1, snapshotCount: 2 }));
    expect(episodes[1]).toEqual(expect.objectContaining({ durationMinutes: 0, snapshotCount: 1 }));
  });

  it("assigns duration buckets", () => {
    expect(bucketEpisodeDuration(0.5)).toBe("<1m");
    expect(bucketEpisodeDuration(1)).toBe("1-5m");
    expect(bucketEpisodeDuration(5)).toBe("5-15m");
    expect(bucketEpisodeDuration(15)).toBe("15-60m");
    expect(bucketEpisodeDuration(61)).toBe("> 60m");
  });

  it("dedupes by ticker and keeps the longest episode", () => {
    const episodes = buildSpreadEpisodes(
      [
        snapshot("KXDUP", "2026-06-13T00:00:00.000Z", 0.06),
        snapshot("KXDUP", "2026-06-13T00:01:00.000Z", 0.07),
        snapshot("KXDUP", "2026-06-13T00:05:00.000Z", 0.08),
        snapshot("KXOTHER", "2026-06-13T00:00:00.000Z", 0.09)
      ],
      options({ maxGapMinutes: 2 })
    );

    const top = selectTopSpreadEpisodes(episodes, "ticker");

    expect(top).toHaveLength(2);
    expect(top[0]).toEqual(expect.objectContaining({ ticker: "KXDUP", durationMinutes: 1 }));
    expect(top[1]).toEqual(expect.objectContaining({ ticker: "KXOTHER" }));
  });

  it("summarizes duration and bucket metrics", () => {
    const summary = summarizeSpreadEpisodes(
      buildSpreadEpisodes(
        [
          snapshot("KXA", "2026-06-13T00:00:00.000Z", 0.06),
          snapshot("KXA", "2026-06-13T00:10:00.000Z", 0.08),
          snapshot("KXB", "2026-06-13T00:00:00.000Z", 0.09),
          snapshot("KXB", "2026-06-13T01:05:00.000Z", 0.1)
        ],
        options({ maxGapMinutes: 120 })
      )
    );

    expect(summary.overall).toEqual({
      avgEpisodeMinutes: 37.5,
      medianEpisodeMinutes: 37.5,
      maxEpisodeMinutes: 65,
      avgSnapshotsPerEpisode: 2
    });
    expect(summary.byDurationBucket).toContainEqual(
      expect.objectContaining({ bucket: "5-15m", count: 1, avgDurationMinutes: 10, avgSpread: 0.07, maxSpread: 0.08 })
    );
    expect(summary.byDurationBucket).toContainEqual(
      expect.objectContaining({ bucket: "> 60m", count: 1, avgDurationMinutes: 65, avgSpread: 0.095, maxSpread: 0.1 })
    );
  });
});

function snapshot(ticker: string, capturedAt: string, spread: number): SpreadPersistenceSnapshotInput {
  return {
    marketId: `market-${ticker}`,
    ticker,
    title: `Title ${ticker}`,
    capturedAt,
    spread
  };
}

function options(overrides: Partial<Parameters<typeof buildSpreadEpisodes>[1]> = {}): Parameters<typeof buildSpreadEpisodes>[1] {
  return {
    minSpread: 0.04,
    maxSpread: 0.1,
    ...overrides
  };
}
