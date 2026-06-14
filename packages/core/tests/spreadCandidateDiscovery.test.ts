import { describe, expect, it } from "vitest";
import {
  buildSpreadCandidateDiagnostics,
  classifySpreadBucket,
  computeSpreadChange,
  dedupeSpreadCandidates,
  extractSpreadCandidates,
  rankSpreadCandidates,
  type SpreadTighteningResearchRow
} from "../src";

describe("spread candidate discovery helpers", () => {
  it("extracts candidates inside the requested entry spread range", () => {
    const candidates = extractSpreadCandidates(
      [
        row("LOW", "240m", 0.019, 0.01),
        row("IN", "240m", 0.05, 0.02),
        row("HIGH", "240m", 0.11, 0.08)
      ],
      { window: "240m", minEntrySpread: 0.02, maxEntrySpread: 0.1 }
    );

    expect(candidates.map((candidate) => candidate.ticker)).toEqual(["IN"]);
  });

  it("filters to the requested window", () => {
    const candidates = extractSpreadCandidates(
      [row("SHORT", "60m", 0.05, 0.03), row("LONG", "240m", 0.05, 0.02)],
      { window: "240m", minEntrySpread: 0.02, maxEntrySpread: 0.1 }
    );

    expect(candidates.map((candidate) => candidate.ticker)).toEqual(["LONG"]);
  });

  it("sorts by spreadChange asc", () => {
    const ranked = rankSpreadCandidates(
      [row("WEAK", "240m", 0.08, 0.07), row("STRONG", "240m", 0.08, 0.02)],
      "spreadChange",
      "asc"
    );

    expect(ranked.map((candidate) => candidate.ticker)).toEqual(["STRONG", "WEAK"]);
  });

  it("sorts by entrySpread asc and desc", () => {
    const rows = [row("MID", "240m", 0.05, 0.03), row("WIDE", "240m", 0.09, 0.06), row("TIGHT", "240m", 0.03, 0.02)];

    expect(rankSpreadCandidates(rows, "entrySpread", "asc").map((candidate) => candidate.ticker)).toEqual(["TIGHT", "MID", "WIDE"]);
    expect(rankSpreadCandidates(rows, "entrySpread", "desc").map((candidate) => candidate.ticker)).toEqual(["WIDE", "MID", "TIGHT"]);
  });

  it("dedupes by ticker after ranking", () => {
    const ranked = rankSpreadCandidates(
      [
        row("DUP", "240m", 0.08, 0.04, { detectedAt: "2026-06-13T00:00:00.000Z" }),
        row("DUP", "240m", 0.09, 0.01, { detectedAt: "2026-06-13T00:05:00.000Z" }),
        row("OTHER", "240m", 0.07, 0.05)
      ],
      "spreadChange",
      "asc"
    );

    expect(dedupeSpreadCandidates(ranked, "ticker").map((candidate) => candidate.detectedAt.toISOString())).toEqual([
      "2026-06-13T00:05:00.000Z",
      "2026-06-13T00:00:00.000Z"
    ]);
  });

  it("excludes rows with missing future snapshots from candidates while reporting diagnostics", () => {
    const rows = [row("READY", "240m", 0.08, 0.04), row("MISSING", "240m", 0.07, null)];
    const candidates = extractSpreadCandidates(rows, { window: "240m", minEntrySpread: 0.02, maxEntrySpread: 0.1 });
    const diagnostics = buildSpreadCandidateDiagnostics(rows);

    expect(candidates.map((candidate) => candidate.ticker)).toEqual(["READY"]);
    expect(diagnostics.missingFutureSnapshotCount).toBe(1);
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
