import { describe, expect, it } from "vitest";
import {
  buildCandidateDiagnostics,
  dedupeCandidates,
  extractCandidate,
  formatCandidateDiscoveryReport,
  rankCandidates,
  truncateTitle,
  type CandidateDiscoveryCandidate
} from "../src";

describe("candidate discovery helpers", () => {
  it("extracts candidate fields from fake signal and raw JSON rows", () => {
    const candidate = extractCandidate(
      {
        id: "signal-1234567890",
        detectedAt: "2026-06-13T00:00:00.000Z",
        strategy: "binary_complement_arb",
        status: "rejected",
        reason: "Rejected: estimated net edge 0.0010 is below minimum 0.0050.",
        grossEdge: "0.011",
        netEdge: "0.001",
        maxContracts: "25",
        rawJson: {
          yesAsk: 0.47,
          noAsk: 0.52,
          spread: 0.03,
          title: "Will the fixture market resolve yes?"
        },
        market: {
          id: "market-1",
          ticker: "KXTEST",
          title: "Fallback title"
        }
      },
      {
        forwardReturns: {
          "15m": 0.01,
          "30m": -0.02,
          "60m": 0.03,
          "240m": 0.04
        }
      }
    );

    expect(candidate).toEqual(
      expect.objectContaining({
        signalId: "signal-1234567890",
        shortId: "signal...7890",
        strategy: "binary_complement_arb",
        ticker: "KXTEST",
        marketId: "market-1",
        title: "Will the fixture market resolve yes?",
        status: "rejected",
        rejectionReason: "low_edge",
        entryCost: 0.99,
        grossEdge: 0.011,
        netEdge: 0.001,
        spread: 0.03,
        maxContracts: 25,
        returns: {
          "15m": 0.01,
          "30m": -0.02,
          "60m": 0.03,
          "240m": 0.04
        }
      })
    );
  });

  it("ranks by netEdge desc", () => {
    expect(rankCandidates([candidate("low", { netEdge: 0.001 }), candidate("high", { netEdge: 0.004 })], "netEdge", "desc").map((item) => item.signalId)).toEqual([
      "high",
      "low"
    ]);
  });

  it("ranks by spread asc", () => {
    expect(rankCandidates([candidate("wide", { spread: 0.08 }), candidate("tight", { spread: 0.01 })], "spread", "asc").map((item) => item.signalId)).toEqual([
      "tight",
      "wide"
    ]);
  });

  it("ranks by entryCost asc", () => {
    expect(
      rankCandidates([candidate("expensive", { entryCost: 1.01 }), candidate("cheap", { entryCost: 0.96 })], "entryCost", "asc").map(
        (item) => item.signalId
      )
    ).toEqual(["cheap", "expensive"]);
  });

  it("sorts missing values last", () => {
    expect(
      rankCandidates([candidate("missing", { netEdge: null }), candidate("present", { netEdge: -0.02 })], "netEdge", "desc").map(
        (item) => item.signalId
      )
    ).toEqual(["present", "missing"]);
  });

  it("dedupes by ticker and keeps the best netEdge when ranked desc", () => {
    const ranked = rankCandidates(
      [
        candidate("weak-a", { ticker: "KXDUP", netEdge: 0.001 }),
        candidate("strong-a", { ticker: "KXDUP", netEdge: 0.004 }),
        candidate("other", { ticker: "KXOTHER", netEdge: 0.003 })
      ],
      "netEdge",
      "desc"
    );

    expect(dedupeCandidates(ranked, "ticker").map((item) => item.signalId)).toEqual(["strong-a", "other"]);
  });

  it("dedupes by ticker and keeps the best return240m when ranked desc", () => {
    const ranked = rankCandidates(
      [
        candidate("weak-return", { ticker: "KXDUP", returns: returns({ "240m": 0.02 }) }),
        candidate("strong-return", { ticker: "KXDUP", returns: returns({ "240m": 0.08 }) }),
        candidate("other-return", { ticker: "KXOTHER", returns: returns({ "240m": 0.04 }) })
      ],
      "return240m",
      "desc"
    );

    expect(dedupeCandidates(ranked, "ticker").map((item) => item.signalId)).toEqual(["strong-return", "other-return"]);
  });

  it("dedupe none preserves duplicates", () => {
    const ranked = rankCandidates(
      [candidate("first", { ticker: "KXDUP", netEdge: 0.004 }), candidate("second", { ticker: "KXDUP", netEdge: 0.003 })],
      "netEdge",
      "desc"
    );

    expect(dedupeCandidates(ranked, "none").map((item) => item.signalId)).toEqual(["first", "second"]);
  });

  it("handles large diagnostic arrays without stack-unsafe spread", () => {
    const candidates = Array.from({ length: 100_000 }, (_, index) => candidate(`candidate-${index}`, { netEdge: index / 1_000_000 }));

    expect(buildCandidateDiagnostics(candidates, 0.005)).toEqual(
      expect.objectContaining({
        bestNetEdge: 0.099999,
        usableNetEdgeCount: 100_000
      })
    );
  });

  it("truncates long titles and leaves short titles alone", () => {
    expect(truncateTitle("Short title", 20)).toBe("Short title");
    expect(truncateTitle("This title is deliberately too long for a compact report table", 24)).toBe("This title is deliber...");
  });

  it("formats the candidate report table and diagnostics", () => {
    const report = formatCandidateDiscoveryReport({
      lookbackHours: 720,
      status: "rejected",
      rejectionReason: "low_edge",
      sortBy: "netEdge",
      direction: "desc",
      candidatesScanned: 1,
      candidatesAfterFilters: 1,
      dedupeBy: "none",
      candidatesAfterDedupe: 1,
      candidates: [candidate("A", { netEdge: 0.004, grossEdge: 0.01, entryCost: 0.99, spread: 0.02 })],
      top: 20,
      diagnostics: {
        minNetEdgeThreshold: 0.005,
        bestNetEdge: 0.004,
        distanceFromThreshold: 0.001,
        usableNetEdgeCount: 1,
        usableForwardReturnsCount: 1,
        excludedMissingEntryOrEmptyOrderbookCount: 0
      }
    });

    expect(report).toContain("Candidate Discovery Report");
    expect(report).toContain("Sort: netEdge desc");
    expect(report).toContain("Candidates after filters: 1");
    expect(report).toContain("Dedupe by: none");
    expect(report).toContain("Candidates after dedupe: 1");
    expect(report).toContain("rank | detectedAt");
    expect(report).toContain("Min net edge threshold used: 0.005000");
    expect(report).toContain("r15m");
  });
});

function returns(values: Partial<CandidateDiscoveryCandidate["returns"]>): CandidateDiscoveryCandidate["returns"] {
  return {
    "15m": null,
    "30m": null,
    "60m": null,
    "240m": null,
    ...values
  };
}

function candidate(id: string, values: Partial<CandidateDiscoveryCandidate>): CandidateDiscoveryCandidate {
  return {
    signalId: id,
    shortId: id,
    detectedAt: new Date(`2026-06-13T00:00:0${id.length % 10}.000Z`),
    strategy: "binary_complement_arb",
    ticker: `KX${id}`,
    marketId: `market-${id}`,
    title: `Title ${id}`,
    status: "rejected",
    rejectionReason: "low_edge",
    entryCost: 1,
    grossEdge: 0,
    netEdge: 0,
    spread: 0.05,
    maxContracts: 10,
    returns: {
      "15m": 0.01,
      "30m": null,
      "60m": null,
      "240m": null
    },
    ...values
  };
}
