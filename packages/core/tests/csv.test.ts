import { describe, expect, it } from "vitest";
import { snapshotsSignalsToCsv } from "../src/csv";

describe("CSV export formatting", () => {
  it("formats snapshot and signal rows with escaped fields", () => {
    const csv = snapshotsSignalsToCsv([
      {
        timestamp: new Date("2026-01-01T00:00:00Z"),
        platform: "kalshi",
        ticker: "TEST",
        title: "Market, with comma",
        bestYesBid: 0.4,
        bestYesAsk: 0.45,
        bestNoBid: 0.55,
        bestNoAsk: 0.6,
        spread: 0.05,
        grossEdge: 0,
        estimatedFees: 0.01,
        netEdge: -0.01,
        signalStatus: "rejected",
        reason: "Rejected: estimated net edge below minimum",
        strategy: "multi_outcome_arb",
        groupKey: "kalshi:event:TEST",
        groupMarketTickers: "A|B",
        groupMarketTitles: "A wins|B wins",
        groupEligibility: "eligible",
        groupConfidence: 0.95,
        groupReason: "Eligible",
        totalYesAskCost: 0.97,
        rejectionReason: "low_edge",
        marketCount: 2,
        closeTimeSpreadSeconds: 0
      }
    ]);

    expect(csv.split("\n")[0]).toBe(
      "timestamp,platform,ticker,title,bestYesBid,bestYesAsk,bestNoBid,bestNoAsk,spread,grossEdge,estimatedFees,netEdge,signalStatus,reason,strategy,groupKey,groupMarketTickers,groupMarketTitles,groupEligibility,groupConfidence,groupReason,totalYesAskCost,rejectionReason,marketCount,closeTimeSpreadSeconds"
    );
    expect(csv).toContain('"Market, with comma"');
    expect(csv).toContain("2026-01-01T00:00:00.000Z");
    expect(csv).toContain("multi_outcome_arb");
  });
});
