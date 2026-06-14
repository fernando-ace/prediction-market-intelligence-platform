import { describe, expect, it } from "vitest";
import {
  buildMakerQuoteSimulationRow,
  buildQuoteSweepRows,
  buildFillProxyRow,
  computeMarkout,
  computeMidpoint,
  computePossibleFillByAsk,
  computeQuoteForLevel,
  computeSimulatedQuote,
  computeTimeToPossibleFill,
  dedupeFillProxyRows,
  dedupeMakerQuoteRows,
  dedupeQuoteSweepBaseRows,
  summarizeFillProxyRows,
  summarizeMakerQuoteRows,
  summarizeQuoteSweepRows,
  type FillProxyRow,
  type MakerQuoteSimulationRow
} from "../src";

describe("maker quote simulation helpers", () => {
  it("computes midpoint from valid bid ask values", () => {
    expect(computeMidpoint(0.42, 0.48)).toBe(0.45);
    expect(computeMidpoint("0.40", "0.50")).toBe(0.45);
    expect(computeMidpoint(0.51, 0.49)).toBeNull();
  });

  it("computes bid-plus-tick quotes with the configured tick size", () => {
    expect(computeSimulatedQuote(0.42, 0.48, "bid_plus_tick", 0.01)).toBe(0.43);
    expect(computeSimulatedQuote(0.42, 0.425, "bid_plus_tick", 0.01)).toBe(0.425);
    expect(computeSimulatedQuote(0.42, 0.48, "bid_plus_tick", 0)).toBeNull();
  });

  it("computes midpoint quotes", () => {
    expect(computeSimulatedQuote(0.42, 0.48, "midpoint", 0.01)).toBe(0.45);
  });

  it("computes quote sweep levels without crossing the ask", () => {
    expect(computeQuoteForLevel(0.42, 0.48, "bid_plus_1_tick", 0.01)).toBe(0.43);
    expect(computeQuoteForLevel(0.42, 0.48, "bid_plus_2_ticks", 0.01)).toBe(0.44);
    expect(computeQuoteForLevel(0.42, 0.48, "bid_plus_3_ticks", 0.01)).toBe(0.45);
    expect(computeQuoteForLevel(0.42, 0.48, "midpoint", 0.01)).toBe(0.45);
    expect(computeQuoteForLevel(0.42, 0.48, "ask_minus_1_tick", 0.01)).toBe(0.47);
    expect(computeQuoteForLevel(0.42, 0.425, "bid_plus_1_tick", 0.01)).toBeNull();
    expect(computeQuoteForLevel(0.42, 0.425, "ask_minus_1_tick", 0.01)).toBeNull();
  });

  it("computes markout, markout percent, and favorable classification", () => {
    expect(computeMarkout(0.45, 0.48)).toEqual({ markout: 0.03, markoutPct: 0.066667, favorable: true });
    expect(computeMarkout(0.45, 0.44)).toEqual({ markout: -0.01, markoutPct: -0.022222, favorable: false });
    expect(computeMarkout(0, 0.44)).toEqual({ markout: 0.44, markoutPct: null, favorable: true });
    expect(computeMarkout(null, 0.44)).toEqual({ markout: null, markoutPct: null, favorable: null });
  });

  it("builds simulation rows with spread tightening metadata", () => {
    expect(
      buildMakerQuoteSimulationRow({
        marketId: "market-1",
        ticker: "KXTEST",
        title: "Test title",
        capturedAt: "2026-06-13T00:00:00.000Z",
        window: "240m",
        bestBid: 0.42,
        bestAsk: 0.48,
        futureBestBid: 0.47,
        futureBestAsk: 0.49,
        quoteMode: "midpoint",
        tickSize: 0.01
      })
    ).toEqual(
      expect.objectContaining({
        quotePrice: 0.45,
        futureMidpoint: 0.48,
        markout: 0.03,
        favorable: true,
        entrySpread: 0.06,
        futureSpread: 0.02,
        spreadChange: -0.04,
        tightened: true,
        bucket: "0.05-0.10"
      })
    );
  });

  it("summarizes simulation rows", () => {
    const summary = summarizeMakerQuoteRows([row("A", 0.45, 0.48, 0.06, 0.02), row("B", 0.5, 0.49, 0.08, 0.1)]);

    expect(summary.overall).toEqual({
      count: 2,
      avgEntrySpread: 0.07,
      avgFutureSpread: 0.06,
      tightenRate: 0.5,
      avgQuotePrice: 0.475,
      avgFutureMidpoint: 0.485,
      avgMarkout: 0.01,
      avgMarkoutPct: 0.023334,
      favorableRate: 0.5
    });
    expect(summary.byEntrySpreadBucket).toContainEqual(expect.objectContaining({ bucket: "0.05-0.10", count: 2 }));
  });

  it("keeps the best row per ticker according to requested sort", () => {
    const rows = [
      row("KXDUP", 0.45, 0.46, 0.06, 0.04),
      row("KXDUP", 0.45, 0.5, 0.06, 0.02, { capturedAt: "2026-06-13T00:05:00.000Z" }),
      row("KXOTHER", 0.5, 0.49, 0.07, 0.04)
    ];

    expect(dedupeMakerQuoteRows(rows, "ticker", "markout", "desc").map((item) => item.ticker)).toEqual(["KXDUP", "KXOTHER"]);
    expect(dedupeMakerQuoteRows(rows, "ticker", "markout", "desc")[0].futureMidpoint).toBe(0.5);
  });

  it("marks possible fills when a future ask is at or below quote price", () => {
    expect(
      computePossibleFillByAsk(0.43, [
        { capturedAt: "2026-06-13T00:02:00.000Z", bestYesAsk: 0.44 },
        { capturedAt: "2026-06-13T00:01:00.000Z", bestYesAsk: 0.43 }
      ])
    ).toEqual({ possibleFill: true, firstFillSnapshotTime: new Date("2026-06-13T00:01:00.000Z") });
  });

  it("does not mark possible fills when future asks stay above quote price", () => {
    expect(
      computePossibleFillByAsk(0.43, [
        { capturedAt: "2026-06-13T00:01:00.000Z", bestYesAsk: 0.44 },
        { capturedAt: "2026-06-13T00:02:00.000Z", bestYesAsk: 0.45 }
      ])
    ).toEqual({ possibleFill: false, firstFillSnapshotTime: null });
  });

  it("computes first fill time in minutes", () => {
    expect(computeTimeToPossibleFill("2026-06-13T00:00:00.000Z", "2026-06-13T00:12:30.000Z")).toBe(12.5);
    expect(computeTimeToPossibleFill("2026-06-13T00:00:00.000Z", null)).toBeNull();
  });

  it("builds fill proxy rows from maker quote rows", () => {
    const fillRow = buildFillProxyRow(row("KXFILL", 0.43, 0.5, 0.06, 0.02), [
      { capturedAt: "2026-06-13T00:04:00.000Z", bestYesAsk: 0.44 },
      { capturedAt: "2026-06-13T00:05:00.000Z", bestYesAsk: 0.43 }
    ]);

    expect(fillRow).toEqual(expect.objectContaining({
      possibleFill: true,
      firstFillAt: new Date("2026-06-13T00:05:00.000Z"),
      timeToFillMinutes: 5
    }));
  });

  it("builds quote sweep rows with possible fill semantics reused per quote level", () => {
    const sweepRows = buildQuoteSweepRows(row("KXSWEEP", 0.43, 0.5, 0.06, 0.02), [
      { capturedAt: "2026-06-13T00:03:00.000Z", bestYesAsk: 0.45 },
      { capturedAt: "2026-06-13T00:05:00.000Z", bestYesAsk: 0.43 }
    ]);

    expect(sweepRows.find((item) => item.quoteLevel === "bid_plus_1_tick")).toEqual(
      expect.objectContaining({
        quotePrice: 0.41,
        possibleFill: false,
        firstFillAt: null,
        markout: 0.09
      })
    );
    expect(sweepRows.find((item) => item.quoteLevel === "bid_plus_3_ticks")).toEqual(
      expect.objectContaining({
        quotePrice: 0.43,
        possibleFill: true,
        firstFillAt: new Date("2026-06-13T00:05:00.000Z"),
        timeToFillMinutes: 5,
        markout: 0.07
      })
    );
  });

  it("counts skipped quote sweep levels when a quote would be outside the bid ask", () => {
    const sweepRows = buildQuoteSweepRows(row("KXNARROW", 0.43, 0.5, 0.015, 0.01), []);

    expect(sweepRows.find((item) => item.quoteLevel === "bid_plus_2_ticks")).toEqual(
      expect.objectContaining({ quotePrice: null, skipped: true })
    );
    expect(sweepRows.find((item) => item.quoteLevel === "ask_minus_1_tick")).toEqual(
      expect.objectContaining({ quotePrice: 0.405, skipped: false })
    );
  });

  it("summarizes quote sweep rows by quote level", () => {
    const summary = summarizeQuoteSweepRows([
      ...buildQuoteSweepRows(row("KXFILL", 0.43, 0.5, 0.06, 0.02), [{ capturedAt: "2026-06-13T00:05:00.000Z", bestYesAsk: 0.43 }]),
      ...buildQuoteSweepRows(row("KXNOFILL", 0.43, 0.42, 0.06, 0.02), [{ capturedAt: "2026-06-13T00:05:00.000Z", bestYesAsk: 0.5 }])
    ]);

    expect(summary.find((item) => item.quoteLevel === "bid_plus_3_ticks")).toEqual(
      expect.objectContaining({
        count: 2,
        possibleFillRate: 0.5,
        avgTimeToFillMinutes: 5,
        favorableRate: 0.5,
        favorableIfFillableRate: 1,
        avgMarkoutPct: 0.069768,
        avgFillableMarkoutPct: 0.162791,
        skippedCount: 0
      })
    );
  });

  it("summarizes fillable and favorable fill proxy rows", () => {
    const summary = summarizeFillProxyRows([
      fillRow("KXFILLWIN", 0.45, 0.5, true, 4),
      fillRow("KXFILLLOSS", 0.45, 0.44, true, 6),
      fillRow("KXNOFILLWIN", 0.45, 0.49, false, null)
    ]);

    expect(summary.overall).toEqual({
      count: 3,
      possibleFillRate: 0.666667,
      avgTimeToFillMinutes: 5,
      favorableRate: 0.666667,
      favorableIfFillableRate: 0.5,
      avgMarkout: 0.026667,
      avgMarkoutPct: 0.059259,
      avgFillableMarkout: 0.02,
      avgFillableMarkoutPct: 0.044445,
      fillableCount: 2,
      favorableFillableCount: 1,
      unfillableFavorableCount: 1
    });
    expect(summary.byEntrySpreadBucket).toContainEqual(
      expect.objectContaining({ bucket: "0.05-0.10", count: 3, possibleFillRate: 0.666667, favorableIfFillableRate: 0.5 })
    );
  });

  it("dedupes fill proxy rows by ticker according to requested sort", () => {
    const rows = [
      fillRow("KXDUP", 0.45, 0.5, true, 10),
      fillRow("KXDUP", 0.45, 0.51, true, 5, { capturedAt: "2026-06-13T00:05:00.000Z" }),
      fillRow("KXOTHER", 0.5, 0.49, false, null)
    ];

    expect(dedupeFillProxyRows(rows, "ticker", "markout", "desc").map((item) => item.ticker)).toEqual(["KXDUP", "KXOTHER"]);
    expect(dedupeFillProxyRows(rows, "ticker", "timeToFill", "asc")[0].timeToFillMinutes).toBe(5);
  });

  it("dedupes quote sweep base rows before expansion by strongest original markout", () => {
    const rows = [
      row("KXDUP", 0.43, 0.45, 0.06, 0.04),
      row("KXDUP", 0.43, 0.52, 0.06, 0.02, { capturedAt: "2026-06-13T00:05:00.000Z" }),
      row("KXOTHER", 0.43, 0.44, 0.06, 0.04)
    ];
    const deduped = dedupeQuoteSweepBaseRows(rows, "ticker");
    const expanded = deduped.flatMap((baseRow) => buildQuoteSweepRows(baseRow, []));

    expect(deduped.map((item) => item.ticker)).toEqual(["KXDUP", "KXOTHER"]);
    expect(deduped[0].futureMidpoint).toBe(0.52);
    expect(expanded.filter((item) => item.ticker === "KXDUP")).toHaveLength(5);
  });

  it("throws clearly for invalid quote mode values reaching the helper", () => {
    expect(() => computeSimulatedQuote(0.42, 0.48, "bad_mode" as never, 0.01)).toThrow("Unsupported quote mode: bad_mode");
  });
});

function fillRow(
  ticker: string,
  quotePrice: number,
  futureMidpoint: number,
  possibleFill: boolean,
  timeToFillMinutes: number | null,
  overrides: { capturedAt?: Date | string; marketId?: string } = {}
): FillProxyRow {
  const base = row(ticker, quotePrice, futureMidpoint, 0.06, 0.02, overrides);
  const firstFillAt =
    timeToFillMinutes === null ? null : new Date(base.capturedAt.getTime() + timeToFillMinutes * 60 * 1000);
  return {
    ...base,
    firstFillAt,
    timeToFillMinutes,
    possibleFill
  };
}

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
