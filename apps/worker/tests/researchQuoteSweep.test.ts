import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { computeMarkout, type QuoteSweepLevel, type QuoteSweepRow } from "@prediction-market-scanner/core";
import { formatQuoteSweepReport, parseQuoteSweepOptions } from "../src/researchQuoteSweep";

describe("research quote sweep CLI options", () => {
  it("uses read-only quote sweep defaults", () => {
    expect(parseQuoteSweepOptions([], {})).toEqual({
      limit: 50_000,
      lookbackHours: 720,
      minAgeMinutes: 240,
      markoutWindow: "240m",
      fillWindow: "240m",
      minEntrySpread: 0.04,
      maxEntrySpread: 0.1,
      tickSize: 0.01,
      dedupeBy: "ticker",
      top: 20
    });
  });

  it("parses named flags and environment fallbacks", () => {
    expect(
      parseQuoteSweepOptions(
        [
          "--limit",
          "500",
          "--lookback-hours",
          "24",
          "--min-age-minutes",
          "60",
          "--markout-window",
          "60m",
          "--fill-window",
          "15m",
          "--min-entry-spread",
          "0.03",
          "--max-entry-spread",
          "0.2",
          "--tick-size",
          "0.005",
          "--dedupe-by",
          "none",
          "--top",
          "5"
        ],
        {}
      )
    ).toEqual({
      limit: 500,
      lookbackHours: 24,
      minAgeMinutes: 60,
      markoutWindow: "60m",
      fillWindow: "15m",
      minEntrySpread: 0.03,
      maxEntrySpread: 0.2,
      tickSize: 0.005,
      dedupeBy: "none",
      top: 5
    });

    expect(
      parseQuoteSweepOptions([], {
        RESEARCH_QUOTE_SWEEP_MARKOUT_WINDOW: "15m",
        RESEARCH_QUOTE_SWEEP_FILL_WINDOW: "5m",
        RESEARCH_QUOTE_SWEEP_DEDUPE_BY: "market"
      })
    ).toEqual(expect.objectContaining({ markoutWindow: "15m", fillWindow: "5m", dedupeBy: "market" }));
  });

  it("parses the documented 240m markout and 240m fill command", () => {
    expect(
      parseQuoteSweepOptions(
        [
          "--limit",
          "50000",
          "--lookback-hours",
          "720",
          "--min-age-minutes",
          "240",
          "--markout-window",
          "240m",
          "--fill-window",
          "240m",
          "--min-entry-spread",
          "0.04",
          "--max-entry-spread",
          "0.10",
          "--tick-size",
          "0.01",
          "--dedupe-by",
          "ticker",
          "--top",
          "20"
        ],
        {}
      )
    ).toEqual({
      limit: 50_000,
      lookbackHours: 720,
      minAgeMinutes: 240,
      markoutWindow: "240m",
      fillWindow: "240m",
      minEntrySpread: 0.04,
      maxEntrySpread: 0.1,
      tickSize: 0.01,
      dedupeBy: "ticker",
      top: 20
    });
  });

  it("parses positional arguments with and without explicit tick size", () => {
    expect(parseQuoteSweepOptions(["50000", "720", "240", "240m", "240m", "0.04", "0.10", "0.01", "ticker", "20"], {})).toEqual({
      limit: 50_000,
      lookbackHours: 720,
      minAgeMinutes: 240,
      markoutWindow: "240m",
      fillWindow: "240m",
      minEntrySpread: 0.04,
      maxEntrySpread: 0.1,
      tickSize: 0.01,
      dedupeBy: "ticker",
      top: 20
    });
    expect(parseQuoteSweepOptions(["50000", "720", "60", "60m", "60m", "0.04", "0.10", "ticker", "20"], {})).toEqual(
      expect.objectContaining({ minAgeMinutes: 60, markoutWindow: "60m", fillWindow: "60m", tickSize: 0.01, dedupeBy: "ticker", top: 20 })
    );
  });

  it("rejects unsupported option values clearly", () => {
    expect(() => parseQuoteSweepOptions(["--markout-window", "10m"], {})).toThrow(
      "Invalid markout-window from named flag: expected 15m, 30m, 60m, or 240m"
    );
    expect(() => parseQuoteSweepOptions(["--fill-window", "10m"], {})).toThrow(
      "Invalid fill-window from named flag: expected 5m, 15m, 30m, 60m, or 240m"
    );
    expect(() => parseQuoteSweepOptions(["--dedupe-by", "contract"], {})).toThrow(
      "Invalid dedupe-by from named flag: expected none, ticker, or market"
    );
    expect(() => parseQuoteSweepOptions(["--tick-size", "0"], {})).toThrow("Invalid tick-size from named flag: expected a positive number");
    expect(() => parseQuoteSweepOptions(["--min-entry-spread", "0.10", "--max-entry-spread", "0.04"], {})).toThrow(
      "Invalid entry spread range: max-entry-spread must be greater than min-entry-spread"
    );
  });

  it("formats the requested report sections, summary columns, and top examples", () => {
    const report = formatQuoteSweepReport({
      options: {
        limit: 100,
        lookbackHours: 720,
        minAgeMinutes: 240,
        markoutWindow: "240m",
        fillWindow: "240m",
        minEntrySpread: 0.04,
        maxEntrySpread: 0.1,
        tickSize: 0.01,
        dedupeBy: "ticker",
        top: 2
      },
      candidatesScanned: 4,
      baseCandidatesAfterFilters: 3,
      baseCandidatesAfterDedupe: 2,
      rows: [
        row("bid_plus_1_tick", "KXFILL", 0.41, 0.5, true, 5),
        row("bid_plus_2_ticks", "KXNOFILL", 0.42, 0.39, false, null),
        row("bid_plus_3_ticks", "KXSKIP", null, 0.5, false, null, { skipped: true })
      ]
    });

    expect(report).toContain("Quote Aggressiveness Sweep Report");
    expect(report).toContain("Markout window: 240m");
    expect(report).toContain("Fill window: 240m");
    expect(report).toContain("Entry spread range: 0.04 to 0.10");
    expect(report).toContain("Tick size: 0.01");
    expect(report).toContain("Dedupe by: ticker");
    expect(report).toContain("Dedupe assumption: base candidates are deduped before quote expansion by strongest original bid_plus_tick markout.");
    expect(report).toContain("Candidates scanned: 4");
    expect(report).toContain("Base candidates after filters: 3");
    expect(report).toContain("Base candidates after dedupe: 2");
    expect(report).toMatch(/quoteLevel\s+\|\s+count\s+\|\s+possibleFillRate/);
    expect(report).toContain("possibleFillRate");
    expect(report).toContain("avgFillableMarkoutPct");
    expect(report).toContain("skippedCount");
    expect(report).toContain("Top examples by fillable positive markout:");
    expect(report).toMatch(/rank\s+\|\s+quoteLevel/);
    expect(report).toContain("KXFILL");
    expect(report).not.toContain("KXNOFILL");
  });

  it("keeps Prisma writes out of the read-only command source", () => {
    const source = readFileSync(resolve(process.cwd(), "src/researchQuoteSweep.ts"), "utf8");

    expect(source).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/);
    expect(source).not.toMatch(/\.\$executeRaw|\.\$queryRawUnsafe/);
  });
});

function row(
  quoteLevel: QuoteSweepLevel,
  ticker: string,
  quotePrice: number | null,
  futureMidpoint: number,
  possibleFill: boolean,
  timeToFillMinutes: number | null,
  overrides: { skipped?: boolean } = {}
): QuoteSweepRow {
  const capturedAt = new Date("2026-06-13T00:00:00.000Z");
  const markout = computeMarkout(quotePrice, futureMidpoint);
  const firstFillAt = timeToFillMinutes === null ? null : new Date(capturedAt.getTime() + timeToFillMinutes * 60 * 1000);
  return {
    marketId: `market-${ticker}`,
    ticker,
    title: `Title ${ticker}`,
    capturedAt,
    window: "240m",
    quoteLevel,
    bestBid: 0.4,
    bestAsk: 0.46,
    quotePrice,
    futureMidpoint,
    markout: markout.markout,
    markoutPct: markout.markoutPct,
    favorable: markout.favorable,
    entrySpread: 0.06,
    futureSpread: 0.02,
    spreadChange: -0.04,
    tightened: true,
    bucket: "0.05-0.10",
    firstFillAt,
    timeToFillMinutes,
    possibleFill,
    skipped: overrides.skipped ?? false
  };
}
