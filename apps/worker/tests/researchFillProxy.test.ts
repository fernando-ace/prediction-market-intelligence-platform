import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { computeMarkout, type FillProxyRow } from "@prediction-market-scanner/core";
import { formatFillProxyReport, parseFillProxyOptions } from "../src/researchFillProxy";

describe("research fill proxy CLI options", () => {
  it("uses read-only fill proxy defaults", () => {
    expect(parseFillProxyOptions([], {})).toEqual({
      limit: 50_000,
      lookbackHours: 720,
      minAgeMinutes: 240,
      markoutWindow: "240m",
      fillWindow: "60m",
      minEntrySpread: 0.04,
      maxEntrySpread: 0.1,
      quoteMode: "bid_plus_tick",
      tickSize: 0.01,
      dedupeBy: "ticker",
      sortBy: "markout",
      direction: "desc",
      top: 20
    });
  });

  it("parses named flags and environment fallbacks", () => {
    expect(
      parseFillProxyOptions(
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
          "--quote-mode",
          "midpoint",
          "--tick-size",
          "0.005",
          "--dedupe-by",
          "none",
          "--sort-by",
          "timeToFill",
          "--direction",
          "asc",
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
      quoteMode: "midpoint",
      tickSize: 0.005,
      dedupeBy: "none",
      sortBy: "timeToFill",
      direction: "asc",
      top: 5
    });

    expect(
      parseFillProxyOptions([], {
        RESEARCH_FILL_PROXY_MARKOUT_WINDOW: "15m",
        RESEARCH_FILL_PROXY_FILL_WINDOW: "5m",
        RESEARCH_FILL_PROXY_QUOTE_MODE: "midpoint",
        RESEARCH_FILL_PROXY_DEDUPE_BY: "market"
      })
    ).toEqual(expect.objectContaining({ markoutWindow: "15m", fillWindow: "5m", quoteMode: "midpoint", dedupeBy: "market" }));
  });

  it("parses the documented 240m markout and 60m fill proxy command", () => {
    expect(
      parseFillProxyOptions(
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
          "60m",
          "--min-entry-spread",
          "0.04",
          "--max-entry-spread",
          "0.10",
          "--quote-mode",
          "bid_plus_tick",
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
      fillWindow: "60m",
      minEntrySpread: 0.04,
      maxEntrySpread: 0.1,
      quoteMode: "bid_plus_tick",
      tickSize: 0.01,
      dedupeBy: "ticker",
      sortBy: "markout",
      direction: "desc",
      top: 20
    });
  });

  it("parses npm-forwarded positional arguments with explicit tick size and final top only", () => {
    expect(parseFillProxyOptions(["50000", "720", "240", "240m", "60m", "0.04", "0.10", "bid_plus_tick", "0.01", "ticker", "20"], {})).toEqual({
      limit: 50_000,
      lookbackHours: 720,
      minAgeMinutes: 240,
      markoutWindow: "240m",
      fillWindow: "60m",
      minEntrySpread: 0.04,
      maxEntrySpread: 0.1,
      quoteMode: "bid_plus_tick",
      tickSize: 0.01,
      dedupeBy: "ticker",
      sortBy: "markout",
      direction: "desc",
      top: 20
    });
  });

  it("parses full positional arguments with ranking controls", () => {
    expect(
      parseFillProxyOptions(["50000", "720", "240", "240m", "60m", "0.04", "0.10", "bid_plus_tick", "0.01", "ticker", "markout", "desc", "20"], {})
    ).toEqual({
      limit: 50_000,
      lookbackHours: 720,
      minAgeMinutes: 240,
      markoutWindow: "240m",
      fillWindow: "60m",
      minEntrySpread: 0.04,
      maxEntrySpread: 0.1,
      quoteMode: "bid_plus_tick",
      tickSize: 0.01,
      dedupeBy: "ticker",
      sortBy: "markout",
      direction: "desc",
      top: 20
    });
  });

  it("parses short positional arguments when tick size is omitted", () => {
    expect(parseFillProxyOptions(["50000", "720", "240", "240m", "60m", "0.04", "0.10", "bid_plus_tick", "ticker", "20"], {})).toEqual({
      limit: 50_000,
      lookbackHours: 720,
      minAgeMinutes: 240,
      markoutWindow: "240m",
      fillWindow: "60m",
      minEntrySpread: 0.04,
      maxEntrySpread: 0.1,
      quoteMode: "bid_plus_tick",
      tickSize: 0.01,
      dedupeBy: "ticker",
      sortBy: "markout",
      direction: "desc",
      top: 20
    });
  });

  it("parses positional top without mistaking it for sort-by", () => {
    expect(parseFillProxyOptions(["50000", "720", "240", "240m", "60m", "0.04", "0.10", "midpoint", "market", "7"], {})).toEqual(
      expect.objectContaining({ quoteMode: "midpoint", tickSize: 0.01, dedupeBy: "market", sortBy: "markout", direction: "desc", top: 7 })
    );
  });

  it("rejects unsupported option values clearly", () => {
    expect(() => parseFillProxyOptions(["--markout-window", "10m"], {})).toThrow(
      "Invalid markout-window from named flag: expected 15m, 30m, 60m, or 240m"
    );
    expect(() => parseFillProxyOptions(["--fill-window", "10m"], {})).toThrow(
      "Invalid fill-window from named flag: expected 5m, 15m, 30m, 60m, or 240m"
    );
    expect(() => parseFillProxyOptions(["50000", "720", "240", "10m"], {})).toThrow(
      "Invalid markout-window from positional argument: expected 15m, 30m, 60m, or 240m"
    );
    expect(() => parseFillProxyOptions(["50000", "720", "240", "240m", "10m"], {})).toThrow(
      "Invalid fill-window from positional argument: expected 5m, 15m, 30m, 60m, or 240m"
    );
    expect(() => parseFillProxyOptions(["50000", "720", "240", "240m", "60m", "0.04", "0.10", "cross", "ticker", "20"], {})).toThrow(
      "Invalid quote-mode from positional argument: expected midpoint or bid_plus_tick"
    );
    expect(() => parseFillProxyOptions(["--sort-by", "futureSpread"], {})).toThrow(
      "Invalid sort-by from named flag: expected markout, markoutPct, timeToFill, or quotePrice"
    );
    expect(() => parseFillProxyOptions(["--direction", "sideways"], {})).toThrow(
      "Invalid direction from named flag: expected asc or desc"
    );
    expect(() => parseFillProxyOptions(["--dedupe-by", "contract"], {})).toThrow(
      "Invalid dedupe-by from named flag: expected none, ticker, or market"
    );
    expect(() => parseFillProxyOptions(["50000", "720", "240", "240m", "60m", "0.04", "0.10", "bid_plus_tick", "0.01", "contract"], {})).toThrow(
      "Invalid dedupe-by from positional argument: expected none, ticker, or market"
    );
    expect(() => parseFillProxyOptions(["50000", "720", "240", "240m", "60m", "0.04", "0.10", "bid_plus_tick", "ticker", "unexpected"], {})).toThrow(
      "Invalid positional argument after dedupe-by: expected sort-by markout|markoutPct|timeToFill|quotePrice or top, received unexpected."
    );
  });

  it("requires max-entry-spread to be greater than min-entry-spread", () => {
    expect(() => parseFillProxyOptions(["--min-entry-spread", "0.10", "--max-entry-spread", "0.04"], {})).toThrow(
      "Invalid entry spread range: max-entry-spread must be greater than min-entry-spread"
    );
  });

  it("formats report summary, dedupe counts, and examples", () => {
    const report = formatFillProxyReport({
      options: {
        limit: 100,
        lookbackHours: 720,
        minAgeMinutes: 240,
        markoutWindow: "240m",
        fillWindow: "60m",
        minEntrySpread: 0.04,
        maxEntrySpread: 0.1,
        quoteMode: "bid_plus_tick",
        tickSize: 0.01,
        dedupeBy: "ticker",
        sortBy: "markout",
        direction: "desc",
        top: 2
      },
      candidatesScanned: 4,
      rows: [
        row("KXDUP", 0.45, 0.46, false, null, { capturedAt: "2026-06-13T00:00:00.000Z" }),
        row("KXDUP", 0.45, 0.5, true, 5, { capturedAt: "2026-06-13T00:05:00.000Z" }),
        row("KXOTHER", 0.5, 0.49, false, null)
      ]
    });

    expect(report).toContain("Fill Proxy Research Report");
    expect(report).toContain("Markout window: 240m");
    expect(report).toContain("Fill window: 60m");
    expect(report).toContain("Entry spread range: 0.04 to 0.10");
    expect(report).toContain("Quote mode: bid_plus_tick");
    expect(report).toContain("Candidates scanned: 4");
    expect(report).toContain("Candidates after filters: 3");
    expect(report).toContain("Candidates after dedupe: 2");
    expect(report).toContain("possibleFillRate");
    expect(report).toContain("favorableIfFillableRate");
    expect(report).toContain("rank | ticker");
    expect(report).toContain("KXDUP");
    expect(report).not.toContain("KXDUP   | 2026-06-13T00:00:00.000Z");
  });

  it("keeps Prisma writes out of the read-only command source", () => {
    const source = readFileSync(resolve(process.cwd(), "src/researchFillProxy.ts"), "utf8");

    expect(source).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/);
    expect(source).not.toMatch(/\.\$executeRaw|\.\$queryRawUnsafe/);
  });
});

function row(
  ticker: string,
  quotePrice: number,
  futureMidpoint: number,
  possibleFill: boolean,
  timeToFillMinutes: number | null,
  overrides: { capturedAt?: Date | string; marketId?: string } = {}
): FillProxyRow {
  const capturedAt = overrides.capturedAt ? new Date(overrides.capturedAt) : new Date("2026-06-13T00:00:00.000Z");
  const markout = computeMarkout(quotePrice, futureMidpoint);
  const firstFillAt = timeToFillMinutes === null ? null : new Date(capturedAt.getTime() + timeToFillMinutes * 60 * 1000);
  return {
    marketId: overrides.marketId ?? `market-${ticker}`,
    ticker,
    title: `Title ${ticker}`,
    capturedAt,
    window: "240m",
    bestBid: 0.4,
    bestAsk: 0.46,
    quotePrice,
    futureMidpoint,
    markout: markout.markout ?? 0,
    markoutPct: markout.markoutPct,
    favorable: markout.favorable ?? false,
    entrySpread: 0.06,
    futureSpread: 0.02,
    spreadChange: -0.04,
    tightened: true,
    bucket: "0.05-0.10",
    firstFillAt,
    timeToFillMinutes,
    possibleFill
  };
}
