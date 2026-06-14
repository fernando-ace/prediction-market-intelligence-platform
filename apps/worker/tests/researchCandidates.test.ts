import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCandidateDiscoveryOptions } from "../src/researchCandidates";

describe("research candidate CLI options", () => {
  it("uses low-edge discovery defaults", () => {
    expect(parseCandidateDiscoveryOptions([], {})).toEqual({
      limit: 50_000,
      lookbackHours: 720,
      minAgeMinutes: 240,
      status: "rejected",
      rejectionReason: "low_edge",
      sortBy: "netEdge",
      direction: "desc",
      top: 20,
      dedupeBy: "none"
    });
  });

  it("parses ranking options from named flags", () => {
    expect(
      parseCandidateDiscoveryOptions(
        [
          "--discover-candidates",
          "--limit",
          "1000",
          "--lookback-hours",
          "24",
          "--min-age-minutes",
          "60",
          "--status",
          "rejected",
          "--rejection-reason",
          "low_edge",
          "--sort-by",
          "spread",
          "--direction",
          "asc",
          "--top",
          "5",
          "--dedupe-by",
          "ticker"
        ],
        {}
      )
    ).toEqual({
      limit: 1000,
      lookbackHours: 24,
      minAgeMinutes: 60,
      status: "rejected",
      rejectionReason: "low_edge",
      sortBy: "spread",
      direction: "asc",
      top: 5,
      dedupeBy: "ticker"
    });
  });

  it("uses dedupe mode from the environment", () => {
    expect(parseCandidateDiscoveryOptions([], { RESEARCH_CANDIDATE_DEDUPE_BY: "market" })).toEqual(
      expect.objectContaining({
        dedupeBy: "market"
      })
    );
  });

  it("rejects unsupported sort fields", () => {
    expect(() => parseCandidateDiscoveryOptions(["--sort-by", "ticker"], {})).toThrow(
      "Invalid sort-by from named flag: expected netEdge, spread, entryCost, return15m, return60m, or return240m"
    );
  });

  it("rejects unsupported dedupe modes", () => {
    expect(() => parseCandidateDiscoveryOptions(["--dedupe-by", "contract"], {})).toThrow(
      "Invalid dedupe-by from named flag: expected none, ticker, or market, received contract."
    );
  });

  it("keeps Prisma writes out of the read-only command source", () => {
    const source = readFileSync(resolve(process.cwd(), "src/researchCandidates.ts"), "utf8");

    expect(source).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/);
    expect(source).not.toMatch(/\.\$executeRaw|\.\$queryRawUnsafe/);
  });
});
