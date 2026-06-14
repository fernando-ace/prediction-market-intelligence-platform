import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { computeMarkout, type MakerQuoteSimulationRow } from "@prediction-market-scanner/core";
import { formatMakerQuoteReport, parseMakerQuoteOptions } from "../src/researchMakerQuotes";

describe("research maker quotes CLI options", () => {
  it("uses read-only maker quote defaults", () => {
    expect(parseMakerQuoteOptions([], {})).toEqual({
      limit: 50_000,
      lookbackHours: 720,
      minAgeMinutes: 240,
      window: "240m",
      minEntrySpread: 0.04,
      maxEntrySpread: 0.1,
      quoteMode: "midpoint",
      tickSize: 0.01,
      dedupeBy: "ticker",
      sortBy: "markout",
      direction: "desc",
      top: 20
    });
  });

  it("parses named flags and environment fallbacks", () => {
    expect(
      parseMakerQuoteOptions(
        [
          "--limit",
          "500",
          "--lookback-hours",
          "24",
          "--min-age-minutes",
          "60",
          "--window",
          "60m",
          "--min-entry-spread",
          "0.03",
          "--max-entry-spread",
          "0.2",
          "--quote-mode",
          "bid_plus_tick",
          "--tick-size",
          "0.005",
          "--dedupe-by",
          "none",
          "--sort-by",
          "entrySpread",
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
      window: "60m",
      minEntrySpread: 0.03,
      maxEntrySpread: 0.2,
      quoteMode: "bid_plus_tick",
      tickSize: 0.005,
      dedupeBy: "none",
      sortBy: "entrySpread",
      direction: "asc",
      top: 5
    });

    expect(
      parseMakerQuoteOptions([], {
        RESEARCH_MAKER_QUOTE_WINDOW: "15m",
        RESEARCH_MAKER_QUOTE_MODE: "bid_plus_tick",
        RESEARCH_MAKER_QUOTE_DEDUPE_BY: "market"
      })
    ).toEqual(expect.objectContaining({ window: "15m", quoteMode: "bid_plus_tick", dedupeBy: "market" }));
  });

  it("parses the documented named command", () => {
    expect(
      parseMakerQuoteOptions(
        [
          "--limit",
          "50000",
          "--lookback-hours",
          "720",
          "--min-age-minutes",
          "240",
          "--window",
          "240m",
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
      window: "240m",
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

  it("parses full-ish positional arguments with explicit tick size and final top only", () => {
    expect(
      parseMakerQuoteOptions(["50000", "720", "240", "240m", "0.04", "0.10", "bid_plus_tick", "0.01", "ticker", "20"], {})
    ).toEqual({
      limit: 50_000,
      lookbackHours: 720,
      minAgeMinutes: 240,
      window: "240m",
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

  it("parses short npm-forwarded positional arguments without treating dedupe as tick size", () => {
    expect(parseMakerQuoteOptions(["50000", "720", "240", "240m", "0.04", "0.10", "midpoint", "ticker", "20"], {})).toEqual({
      limit: 50_000,
      lookbackHours: 720,
      minAgeMinutes: 240,
      window: "240m",
      minEntrySpread: 0.04,
      maxEntrySpread: 0.1,
      quoteMode: "midpoint",
      tickSize: 0.01,
      dedupeBy: "ticker",
      sortBy: "markout",
      direction: "desc",
      top: 20
    });
  });

  it("parses full positional arguments with explicit tick size and ranking controls", () => {
    expect(
      parseMakerQuoteOptions(["50000", "720", "240", "240m", "0.04", "0.10", "bid_plus_tick", "0.01", "ticker", "markout", "desc", "20"], {})
    ).toEqual({
      limit: 50_000,
      lookbackHours: 720,
      minAgeMinutes: 240,
      window: "240m",
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

  it("parses top correctly when the tick size is omitted from positionals", () => {
    expect(parseMakerQuoteOptions(["50000", "720", "240", "240m", "0.04", "0.10", "midpoint", "market", "7"], {})).toEqual(
      expect.objectContaining({ tickSize: 0.01, dedupeBy: "market", sortBy: "markout", direction: "desc", top: 7 })
    );
  });

  it("rejects unsupported option values clearly", () => {
    expect(() => parseMakerQuoteOptions(["--quote-mode", "cross"], {})).toThrow(
      "Invalid quote-mode from named flag: expected midpoint or bid_plus_tick"
    );
    expect(() => parseMakerQuoteOptions(["--sort-by", "futureSpread"], {})).toThrow(
      "Invalid sort-by from named flag: expected markout, markoutPct, spreadChange, or entrySpread"
    );
    expect(() => parseMakerQuoteOptions(["--direction", "sideways"], {})).toThrow(
      "Invalid direction from named flag: expected asc or desc"
    );
    expect(() => parseMakerQuoteOptions(["--dedupe-by", "contract"], {})).toThrow(
      "Invalid dedupe-by from named flag: expected none, ticker, or market"
    );
    expect(() => parseMakerQuoteOptions(["50000", "720", "240", "240m", "0.04", "0.10", "cross", "ticker", "20"], {})).toThrow(
      "Invalid quote-mode from positional argument: expected midpoint or bid_plus_tick"
    );
    expect(() => parseMakerQuoteOptions(["50000", "720", "240", "240m", "0.04", "0.10", "midpoint", "bad_tick", "ticker"], {})).toThrow(
      "Invalid tick-size from positional argument: expected a positive number"
    );
    expect(() => parseMakerQuoteOptions(["50000", "720", "240", "240m", "0.04", "0.10", "midpoint", "0.01", "contract"], {})).toThrow(
      "Invalid dedupe-by from positional argument: expected none, ticker, or market"
    );
    expect(() => parseMakerQuoteOptions(["50000", "720", "240", "240m", "0.04", "0.10", "midpoint", "ticker", "unexpected"], {})).toThrow(
      "Invalid positional argument after dedupe-by: expected sort-by markout|markoutPct|spreadChange|entrySpread or top, received unexpected."
    );
  });

  it("requires max-entry-spread to be greater than min-entry-spread", () => {
    expect(() => parseMakerQuoteOptions(["--min-entry-spread", "0.10", "--max-entry-spread", "0.04"], {})).toThrow(
      "Invalid entry spread range: max-entry-spread must be greater than min-entry-spread"
    );
  });

  it("formats report summary, dedupe counts, and examples", () => {
    const report = formatMakerQuoteReport({
      options: {
        limit: 100,
        lookbackHours: 720,
        minAgeMinutes: 240,
        window: "240m",
        minEntrySpread: 0.04,
        maxEntrySpread: 0.1,
        quoteMode: "midpoint",
        tickSize: 0.01,
        dedupeBy: "ticker",
        sortBy: "markout",
        direction: "desc",
        top: 2
      },
      candidatesScanned: 4,
      rows: [
        row("KXDUP", 0.45, 0.46, 0.06, 0.04, { capturedAt: "2026-06-13T00:00:00.000Z" }),
        row("KXDUP", 0.45, 0.5, 0.06, 0.02, { capturedAt: "2026-06-13T00:05:00.000Z" }),
        row("KXOTHER", 0.5, 0.49, 0.07, 0.04)
      ]
    });

    expect(report).toContain("Maker Quote Simulation Report");
    expect(report).toContain("Entry spread range: 0.04 to 0.10");
    expect(report).toContain("Quote mode: midpoint");
    expect(report).toContain("Tick size: 0.01");
    expect(report).toContain("Candidates scanned: 4");
    expect(report).toContain("Candidates after filters: 3");
    expect(report).toContain("Candidates after dedupe: 2");
    expect(report).toContain("favorableRate");
    expect(report).toContain("rank | ticker");
    expect(report).toContain("KXDUP");
    expect(report).not.toContain("KXDUP   | 2026-06-13T00:00:00.000Z");
  });

  it("keeps Prisma writes out of the read-only command source", () => {
    const source = readFileSync(resolve(process.cwd(), "src/researchMakerQuotes.ts"), "utf8");

    expect(source).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/);
    expect(source).not.toMatch(/\.\$executeRaw|\.\$queryRawUnsafe/);
  });
});

function row(
  ticker: string,
  quotePrice: number,
  futureMidpoint: number,
  entrySpread: number,
  futureSpread: number,
  overrides: { capturedAt?: Date | string; marketId?: string } = {}
): MakerQuoteSimulationRow {
  const markout = computeMarkout(quotePrice, futureMidpoint);
  return {
    marketId: overrides.marketId ?? `market-${ticker}`,
    ticker,
    title: `Title ${ticker}`,
    capturedAt: overrides.capturedAt ? new Date(overrides.capturedAt) : new Date("2026-06-13T00:00:00.000Z"),
    window: "240m",
    bestBid: 0.4,
    bestAsk: 0.4 + entrySpread,
    quotePrice,
    futureMidpoint,
    markout: markout.markout ?? 0,
    markoutPct: markout.markoutPct,
    favorable: markout.favorable ?? false,
    entrySpread,
    futureSpread,
    spreadChange: Number((futureSpread - entrySpread).toFixed(6)),
    tightened: futureSpread < entrySpread,
    bucket: "0.05-0.10"
  };
}
