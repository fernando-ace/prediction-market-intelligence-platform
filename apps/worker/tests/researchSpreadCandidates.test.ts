import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { classifySpreadBucket, computeSpreadChange, type SpreadTighteningResearchRow } from "@prediction-market-scanner/core";
import { formatSpreadCandidateReport, parseSpreadCandidateOptions } from "../src/researchSpreadCandidates";

describe("research spread candidates CLI options", () => {
  it("uses read-only candidate discovery defaults", () => {
    expect(parseSpreadCandidateOptions([], {})).toEqual({
      limit: 10_000,
      lookbackHours: 720,
      minAgeMinutes: 240,
      window: "240m",
      minEntrySpread: 0.02,
      maxEntrySpread: 0.1,
      dedupeBy: "ticker",
      sortBy: "spreadChange",
      direction: "asc",
      top: 20
    });
  });

  it("parses named flags and environment fallbacks", () => {
    expect(
      parseSpreadCandidateOptions(
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
          "--dedupe-by",
          "none",
          "--sort-by",
          "entrySpread",
          "--direction",
          "desc",
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
      dedupeBy: "none",
      sortBy: "entrySpread",
      direction: "desc",
      top: 5
    });

    expect(
      parseSpreadCandidateOptions([], {
        RESEARCH_SPREAD_CANDIDATE_WINDOW: "15m",
        RESEARCH_SPREAD_CANDIDATE_DEDUPE_BY: "market",
        RESEARCH_SPREAD_CANDIDATE_SORT_BY: "futureSpread"
      })
    ).toEqual(expect.objectContaining({ window: "15m", dedupeBy: "market", sortBy: "futureSpread" }));
  });

  it("parses short positional arguments forwarded by npm workspaces", () => {
    expect(parseSpreadCandidateOptions(["10000", "720", "240", "240m", "0.02", "0.10", "ticker", "20"], {})).toEqual({
      limit: 10_000,
      lookbackHours: 720,
      minAgeMinutes: 240,
      window: "240m",
      minEntrySpread: 0.02,
      maxEntrySpread: 0.1,
      dedupeBy: "ticker",
      sortBy: "spreadChange",
      direction: "asc",
      top: 20
    });
  });

  it("parses full positional arguments forwarded by npm workspaces", () => {
    expect(
      parseSpreadCandidateOptions(["10000", "720", "240", "240m", "0.02", "0.10", "ticker", "spreadChange", "asc", "20"], {})
    ).toEqual({
      limit: 10_000,
      lookbackHours: 720,
      minAgeMinutes: 240,
      window: "240m",
      minEntrySpread: 0.02,
      maxEntrySpread: 0.1,
      dedupeBy: "ticker",
      sortBy: "spreadChange",
      direction: "asc",
      top: 20
    });
  });

  it("lets named flags override positional arguments", () => {
    expect(
      parseSpreadCandidateOptions(
        ["10000", "720", "240", "240m", "0.02", "0.10", "ticker", "20", "--top", "5", "--sort-by", "entrySpread"],
        {}
      )
    ).toEqual(expect.objectContaining({ sortBy: "entrySpread", top: 5 }));
  });

  it("rejects unsupported option values", () => {
    expect(() => parseSpreadCandidateOptions(["--window", "all"], {})).toThrow(
      "Invalid window from named flag: expected 15m, 30m, 60m, or 240m"
    );
    expect(() => parseSpreadCandidateOptions(["--sort-by", "netEdge"], {})).toThrow(
      "Invalid sort-by from named flag: expected spreadChange, tightenPct, entrySpread, or futureSpread"
    );
    expect(() => parseSpreadCandidateOptions(["--direction", "sideways"], {})).toThrow(
      "Invalid direction from named flag: expected asc or desc"
    );
    expect(() => parseSpreadCandidateOptions(["--dedupe-by", "contract"], {})).toThrow(
      "Invalid dedupe-by from named flag: expected none, ticker, or market"
    );
  });

  it("rejects unsupported positional option values clearly", () => {
    expect(() => parseSpreadCandidateOptions(["10000", "720", "240", "all", "0.02", "0.10", "ticker", "20"], {})).toThrow(
      "Invalid window from positional argument: expected 15m, 30m, 60m, or 240m"
    );
    expect(() => parseSpreadCandidateOptions(["10000", "720", "240", "240m", "0.02", "0.10", "contract", "20"], {})).toThrow(
      "Invalid dedupe-by from positional argument: expected none, ticker, or market"
    );
    expect(() =>
      parseSpreadCandidateOptions(["10000", "720", "240", "240m", "0.02", "0.10", "ticker", "netEdge", "asc", "20"], {})
    ).toThrow("Invalid sort-by from positional argument: expected spreadChange, tightenPct, entrySpread, or futureSpread");
  });

  it("does not mistake the short positional top value for sortBy", () => {
    expect(parseSpreadCandidateOptions(["10000", "720", "240", "240m", "0.02", "0.10", "ticker", "7"], {})).toEqual(
      expect.objectContaining({ sortBy: "spreadChange", direction: "asc", top: 7 })
    );
  });

  it("requires max-entry-spread to be greater than min-entry-spread", () => {
    expect(() => parseSpreadCandidateOptions(["--min-entry-spread", "0.10", "--max-entry-spread", "0.02"], {})).toThrow(
      "Invalid entry spread range: max-entry-spread must be greater than min-entry-spread"
    );
  });

  it("formats candidate report counts, diagnostics, and table", () => {
    const report = formatSpreadCandidateReport({
      options: {
        limit: 100,
        lookbackHours: 720,
        minAgeMinutes: 240,
        window: "240m",
        minEntrySpread: 0.02,
        maxEntrySpread: 0.1,
        dedupeBy: "ticker",
        sortBy: "spreadChange",
        direction: "asc",
        top: 2
      },
      candidatesScanned: 4,
      rows: [
        row("KXDUP", "240m", 0.08, 0.04, { detectedAt: "2026-06-13T00:00:00.000Z" }),
        row("KXDUP", "240m", 0.09, 0.01, { detectedAt: "2026-06-13T00:05:00.000Z" }),
        row("KXOTHER", "240m", 0.03, 0.02),
        row("KXMISSING", "240m", 0.07, null)
      ]
    });

    expect(report).toContain("Spread Tightening Candidate Discovery Report");
    expect(report).toContain("Entry spread range: 0.02 to 0.10");
    expect(report).toContain("Candidates scanned: 4");
    expect(report).toContain("Candidates after filters: 3");
    expect(report).toContain("Candidates after dedupe: 2");
    expect(report).toContain("Candidates shown: 2");
    expect(report).toContain("count with missing future snapshot: 1");
    expect(report).toContain("rank | ticker");
    expect(report).toContain("KXDUP");
    expect(report).not.toContain("KXDUP   | 2026-06-13T00:00:00.000Z");
  });

  it("keeps Prisma writes out of the read-only command source", () => {
    const source = readFileSync(resolve(process.cwd(), "src/researchSpreadCandidates.ts"), "utf8");

    expect(source).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/);
    expect(source).not.toMatch(/\.\$executeRaw|\.\$queryRawUnsafe/);
  });
});

function row(
  ticker: string,
  window: SpreadTighteningResearchRow["window"],
  entrySpread: number,
  futureSpread: number | null,
  overrides: { detectedAt?: Date | string; marketId?: string } = {}
): SpreadTighteningResearchRow {
  const calculation = computeSpreadChange(entrySpread, futureSpread);
  return {
    marketId: overrides.marketId ?? `market-${ticker}`,
    ticker,
    title: `Title ${ticker}`,
    category: "Research",
    detectedAt: overrides.detectedAt ? new Date(overrides.detectedAt) : new Date("2026-06-13T00:00:00.000Z"),
    window,
    entrySpread,
    futureSpread,
    missingExit: futureSpread === null,
    bucket: classifySpreadBucket(entrySpread),
    ...calculation
  };
}
