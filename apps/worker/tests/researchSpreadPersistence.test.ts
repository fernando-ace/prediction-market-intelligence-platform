import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type SpreadEpisode } from "@prediction-market-scanner/core";
import { formatSpreadPersistenceReport, parseSpreadPersistenceOptions } from "../src/researchSpreadPersistence";

describe("research spread persistence CLI options", () => {
  it("uses read-only research defaults", () => {
    expect(parseSpreadPersistenceOptions([], {})).toEqual({
      limit: 50_000,
      lookbackHours: 720,
      minSpread: 0.04,
      maxSpread: 0.1,
      maxGapMinutes: 2,
      dedupeBy: "ticker",
      top: 20
    });
  });

  it("parses named flags and environment fallbacks", () => {
    expect(
      parseSpreadPersistenceOptions(
        [
          "--limit",
          "500",
          "--lookback-hours",
          "24",
          "--min-spread",
          "0.05",
          "--max-spread",
          "0.12",
          "--max-gap-minutes",
          "5",
          "--dedupe-by",
          "market",
          "--top",
          "10"
        ],
        {}
      )
    ).toEqual({
      limit: 500,
      lookbackHours: 24,
      minSpread: 0.05,
      maxSpread: 0.12,
      maxGapMinutes: 5,
      dedupeBy: "market",
      top: 10
    });

    expect(
      parseSpreadPersistenceOptions([], {
        RESEARCH_SPREAD_PERSISTENCE_LIMIT: "1000",
        RESEARCH_SPREAD_PERSISTENCE_DEDUPE_BY: "none",
        RESEARCH_SPREAD_PERSISTENCE_TOP: "3"
      })
    ).toEqual(expect.objectContaining({ limit: 1000, dedupeBy: "none", top: 3 }));
  });

  it("parses full positional arguments forwarded by npm", () => {
    expect(parseSpreadPersistenceOptions(["50000", "720", "0.04", "0.10", "2", "ticker", "20"], {})).toEqual({
      limit: 50_000,
      lookbackHours: 720,
      minSpread: 0.04,
      maxSpread: 0.1,
      maxGapMinutes: 2,
      dedupeBy: "ticker",
      top: 20
    });
  });

  it("parses short positional arguments forwarded by npm with default max gap", () => {
    expect(parseSpreadPersistenceOptions(["50000", "720", "0.04", "0.10", "ticker", "20"], {})).toEqual({
      limit: 50_000,
      lookbackHours: 720,
      minSpread: 0.04,
      maxSpread: 0.1,
      maxGapMinutes: 2,
      dedupeBy: "ticker",
      top: 20
    });
  });

  it("keeps top separate from max gap in short positional form", () => {
    expect(parseSpreadPersistenceOptions(["50000", "720", "0.04", "0.10", "market", "7"], {})).toEqual(
      expect.objectContaining({
        maxGapMinutes: 2,
        dedupeBy: "market",
        top: 7
      })
    );
  });

  it("rejects unsupported options", () => {
    expect(() => parseSpreadPersistenceOptions(["--limit", "0"], {})).toThrow("Invalid limit from named flag");
    expect(() => parseSpreadPersistenceOptions(["--dedupe-by", "contract"], {})).toThrow(
      "Invalid dedupe-by from named flag: expected none, ticker, or market"
    );
    expect(() => parseSpreadPersistenceOptions(["--min-spread", "0.10", "--max-spread", "0.04"], {})).toThrow(
      "Invalid spread range"
    );
  });

  it("rejects invalid positional dedupe and max gap clearly", () => {
    expect(() => parseSpreadPersistenceOptions(["50000", "720", "0.04", "0.10", "contract", "20"], {})).toThrow(
      "Invalid dedupe-by from positional argument: expected none, ticker, or market, received contract."
    );
    expect(() => parseSpreadPersistenceOptions(["50000", "720", "0.04", "0.10", "0", "ticker", "20"], {})).toThrow(
      "Invalid max-gap-minutes from positional argument: expected a positive number, received 0."
    );
  });

  it("formats the requested report sections", () => {
    const report = formatSpreadPersistenceReport({
      options: {
        limit: 100,
        lookbackHours: 720,
        minSpread: 0.04,
        maxSpread: 0.1,
        maxGapMinutes: 2,
        dedupeBy: "ticker",
        top: 20
      },
      snapshotsScanned: 3,
      episodes: [episode("KXWIDE", "2026-06-13T00:00:00.000Z", "2026-06-13T00:10:00.000Z", 10, 3)]
    });

    expect(report).toContain("Spread Persistence Research Report");
    expect(report).toContain("Lookback hours: 720");
    expect(report).toContain("Spread range: 0.04 to 0.10");
    expect(report).toContain("Max gap minutes: 2");
    expect(report).toContain("Snapshots scanned: 3");
    expect(report).toContain("Episodes found: 1");
    expect(report).toContain("Unique tickers with episodes: 1");
    expect(report).toContain("Overall:");
    expect(report).toContain("By duration bucket:");
    expect(report).toContain("Top episodes:");
    expect(report).toContain("KXWIDE");
  });

  it("dedupes top episodes by ticker and keeps the longest episode", () => {
    const report = formatSpreadPersistenceReport({
      options: {
        limit: 100,
        lookbackHours: 720,
        minSpread: 0.04,
        maxSpread: 0.1,
        maxGapMinutes: 2,
        dedupeBy: "ticker",
        top: 20
      },
      snapshotsScanned: 4,
      episodes: [
        episode("KXDUP", "2026-06-13T00:00:00.000Z", "2026-06-13T00:01:00.000Z", 1, 2),
        episode("KXDUP", "2026-06-13T00:05:00.000Z", "2026-06-13T00:10:00.000Z", 5, 3)
      ]
    });

    const topEpisodes = report.split("Top episodes:")[1];
    expect(topEpisodes).toContain("2026-06-13T00:05:00.000Z");
    expect(topEpisodes).not.toContain("2026-06-13T00:00:00.000Z");
  });

  it("keeps Prisma writes out of the read-only command source", () => {
    const source = readFileSync(resolve(process.cwd(), "src/researchSpreadPersistence.ts"), "utf8");

    expect(source).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/);
    expect(source).not.toMatch(/\.\$executeRaw|\.\$queryRawUnsafe/);
  });
});

function episode(
  ticker: string,
  start: string,
  end: string,
  durationMinutes: number,
  snapshotCount: number
): SpreadEpisode {
  return {
    marketId: `market-${ticker}`,
    ticker,
    title: `Title ${ticker}`,
    start: new Date(start),
    end: new Date(end),
    durationMinutes,
    snapshotCount,
    avgSpread: 0.07,
    maxSpread: 0.09,
    tightened: null
  };
}
