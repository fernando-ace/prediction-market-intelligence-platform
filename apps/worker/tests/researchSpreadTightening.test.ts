import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { computeSpreadChange, type SpreadTighteningResearchRow } from "@prediction-market-scanner/core";
import { formatSpreadTighteningReport, parseSpreadTighteningOptions } from "../src/researchSpreadTightening";

describe("research spread tightening CLI options", () => {
  it("uses read-only research defaults", () => {
    expect(parseSpreadTighteningOptions([], {})).toEqual({
      limit: 10_000,
      lookbackHours: 720,
      minAgeMinutes: 240,
      bucketBy: "spread",
      top: 20,
      window: "all",
      dedupeBy: "none"
    });
  });

  it("parses named flags and environment fallbacks", () => {
    expect(
      parseSpreadTighteningOptions(
        [
          "--limit",
          "500",
          "--lookback-hours",
          "24",
          "--min-age-minutes",
          "60",
          "--bucket-by",
          "none",
          "--top",
          "5",
          "--window",
          "60m",
          "--dedupe-by",
          "ticker"
        ],
        {}
      )
    ).toEqual({
      limit: 500,
      lookbackHours: 24,
      minAgeMinutes: 60,
      bucketBy: "none",
      top: 5,
      window: "60m",
      dedupeBy: "ticker"
    });

    expect(
      parseSpreadTighteningOptions([], {
        RESEARCH_SPREAD_TIGHTENING_BUCKET_BY: "none",
        RESEARCH_SPREAD_TIGHTENING_WINDOW: "15m",
        RESEARCH_SPREAD_DEDUPE_BY: "market"
      })
    ).toEqual(expect.objectContaining({ bucketBy: "none", window: "15m", dedupeBy: "market" }));
  });

  it("parses full positional arguments forwarded by npm", () => {
    expect(parseSpreadTighteningOptions(["10000", "720", "240", "spread", "ticker", "20"], {})).toEqual({
      limit: 10_000,
      lookbackHours: 720,
      minAgeMinutes: 240,
      bucketBy: "spread",
      top: 20,
      window: "all",
      dedupeBy: "ticker"
    });
  });

  it("parses positional dedupe-only arguments forwarded by npm", () => {
    expect(parseSpreadTighteningOptions(["10000", "720", "240", "ticker", "20"], {})).toEqual({
      limit: 10_000,
      lookbackHours: 720,
      minAgeMinutes: 240,
      bucketBy: "spread",
      dedupeBy: "ticker",
      top: 20,
      window: "all"
    });
  });

  it("keeps positional none as bucket mode when no dedupe mode follows", () => {
    expect(parseSpreadTighteningOptions(["10000", "720", "240", "none"], {})).toEqual({
      limit: 10_000,
      lookbackHours: 720,
      minAgeMinutes: 240,
      bucketBy: "none",
      dedupeBy: "none",
      top: 20,
      window: "all"
    });
  });

  it("rejects unsupported bucket, window, and dedupe values", () => {
    expect(() => parseSpreadTighteningOptions(["--bucket-by", "ticker"], {})).toThrow(
      "Invalid bucket-by from named flag: expected spread or none"
    );
    expect(() => parseSpreadTighteningOptions(["10000", "720", "240", "contract"], {})).toThrow(
      "Invalid bucket-by from positional argument: expected spread or none, received contract."
    );
    expect(() => parseSpreadTighteningOptions(["--window", "10m"], {})).toThrow(
      "Invalid window from named flag: expected 15m, 30m, 60m, 240m, or all"
    );
    expect(() => parseSpreadTighteningOptions(["--dedupe-by", "contract"], {})).toThrow(
      "Invalid dedupe-by from named flag: expected none, ticker, or market, received contract."
    );
    expect(() => parseSpreadTighteningOptions(["10000", "720", "240", "spread", "contract", "20"], {})).toThrow(
      "Invalid dedupe-by from positional argument: expected none, ticker, or market, received contract."
    );
  });

  it("formats the requested report sections", () => {
    const report = formatSpreadTighteningReport({
      options: {
        limit: 100,
        lookbackHours: 720,
        minAgeMinutes: 240,
        bucketBy: "spread",
        top: 5,
        window: "all",
        dedupeBy: "none"
      },
      windows: ["15m", "30m", "60m", "240m"],
      snapshotCapturedAtCutoff: new Date("2026-06-13T00:00:00.000Z"),
      snapshotsEvaluated: 2,
      rows: [
        row("KXWIDE", "Weather", "15m", 0.12, 0.04),
        row("KXTIGHT", "Weather", "15m", 0.03, 0.04)
      ]
    });

    expect(report).toContain("Spread Tightening Research Report");
    expect(report).toContain("Overall:");
    expect(report).toContain("By entry spread bucket:");
    expect(report).toContain("Dedupe by: none");
    expect(report).toContain("Top examples before dedupe: 2");
    expect(report).toContain("Top examples after dedupe: 2");
    expect(report).toContain("> 0.10");
    expect(report).toContain("Top tightening examples:");
    expect(report).toContain("KXWIDE");
  });

  it("dedupes top examples by ticker and keeps the strongest tightening row", () => {
    const report = formatSpreadTighteningReport({
      options: {
        limit: 100,
        lookbackHours: 720,
        minAgeMinutes: 240,
        bucketBy: "spread",
        top: 20,
        window: "all",
        dedupeBy: "ticker"
      },
      windows: ["60m"],
      snapshotCapturedAtCutoff: new Date("2026-06-13T00:00:00.000Z"),
      snapshotsEvaluated: 3,
      rows: [
        row("KXDUP", "Weather", "60m", 0.08, 0.04, { detectedAt: "2026-06-13T00:00:00.000Z" }),
        row("KXDUP", "Weather", "60m", 0.09, 0.02, { detectedAt: "2026-06-13T00:05:00.000Z" }),
        row("KXOTHER", "Weather", "60m", 0.07, 0.05)
      ]
    });

    expect(report).toContain("Dedupe by: ticker");
    expect(report).toContain("Top examples before dedupe: 3");
    expect(report).toContain("Top examples after dedupe: 2");
    const topExamples = report.split("Top tightening examples:")[1];
    expect(topExamples).toContain("2026-06-13T00:05:00.000Z");
    expect(topExamples).not.toContain("1    | KXDUP   | 2026-06-13T00:00:00.000Z");
  });

  it("dedupe none preserves repeated top examples", () => {
    const report = formatSpreadTighteningReport({
      options: {
        limit: 100,
        lookbackHours: 720,
        minAgeMinutes: 240,
        bucketBy: "spread",
        top: 20,
        window: "all",
        dedupeBy: "none"
      },
      windows: ["60m"],
      snapshotCapturedAtCutoff: new Date("2026-06-13T00:00:00.000Z"),
      snapshotsEvaluated: 2,
      rows: [
        row("KXDUP", "Weather", "60m", 0.08, 0.04, { detectedAt: "2026-06-13T00:00:00.000Z" }),
        row("KXDUP", "Weather", "60m", 0.09, 0.02, { detectedAt: "2026-06-13T00:05:00.000Z" })
      ]
    });

    expect(report).toContain("Top examples before dedupe: 2");
    expect(report).toContain("Top examples after dedupe: 2");
    expect(report).toContain("2026-06-13T00:00:00.000Z");
    expect(report).toContain("2026-06-13T00:05:00.000Z");
  });

  it("respects the requested top count", () => {
    const report = formatSpreadTighteningReport({
      options: {
        limit: 100,
        lookbackHours: 720,
        minAgeMinutes: 240,
        bucketBy: "spread",
        top: 1,
        window: "all",
        dedupeBy: "none"
      },
      windows: ["60m"],
      snapshotCapturedAtCutoff: new Date("2026-06-13T00:00:00.000Z"),
      snapshotsEvaluated: 2,
      rows: [row("KXONE", "Weather", "60m", 0.09, 0.01), row("KXTWO", "Weather", "60m", 0.08, 0.04)]
    });

    expect(report).toContain("KXONE");
    expect(report).not.toContain("KXTWO");
  });

  it("keeps Prisma writes out of the read-only command source", () => {
    const source = readFileSync(resolve(process.cwd(), "src/researchSpreadTightening.ts"), "utf8");

    expect(source).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/);
    expect(source).not.toMatch(/\.\$executeRaw|\.\$queryRawUnsafe/);
  });
});

function row(
  ticker: string,
  category: string,
  window: SpreadTighteningResearchRow["window"],
  entrySpread: number,
  futureSpread: number,
  overrides: { detectedAt?: Date | string; marketId?: string } = {}
): SpreadTighteningResearchRow {
  const calculation = computeSpreadChange(entrySpread, futureSpread);
  return {
    marketId: overrides.marketId ?? `market-${ticker}`,
    ticker,
    title: `Title ${ticker}`,
    category,
    detectedAt: overrides.detectedAt ? new Date(overrides.detectedAt) : new Date("2026-06-13T00:00:00.000Z"),
    window,
    entrySpread,
    futureSpread,
    missingExit: false,
    bucket: entrySpread >= 0.1 ? "> 0.10" : "0.02-0.05",
    ...calculation
  };
}
