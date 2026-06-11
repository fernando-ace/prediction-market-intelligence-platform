import { describe, expect, it } from "vitest";
import { summarizeValidationSample } from "../src/sample";

describe("sample collection summary", () => {
  it("counts validation flags and worker errors", () => {
    const summary = summarizeValidationSample({
      marketsChecked: 5,
      snapshotsCollected: 3,
      signals: [
        { status: "accepted", reason: "Accepted: estimated net edge 0.0100 with 10 available contracts." },
        {
          status: "rejected",
          reason: "Rejected: orderbook is empty; missing YES and NO liquidity.",
          validationFlags: { empty_orderbook: true, low_liquidity: true }
        },
        {
          status: "rejected",
          reason: "Rejected: estimated net edge 0.0010 is below minimum 0.0050."
        },
        {
          status: "rejected",
          reason: "Rejected: stale snapshot.",
          validationFlags: { stale_snapshot: true }
        }
      ],
      paperTradesCreated: 1,
      workerErrors: ["rate limited"],
      validationFlags: [
        { missing_yes_book: true, empty_orderbook: true },
        { missing_no_book: true, crossed_or_invalid_prices: true },
        {}
      ]
    });

    expect(summary.marketsChecked).toBe(5);
    expect(summary.snapshotsWithMissingYesBids).toBe(1);
    expect(summary.snapshotsWithMissingNoBids).toBe(1);
    expect(summary.snapshotsWithEmptyOrderbooks).toBe(1);
    expect(summary.snapshotsWithInvalidPrices).toBe(1);
    expect(summary.signalsCreatedTotal).toBe(4);
    expect(summary.signalsAccepted).toBe(1);
    expect(summary.signalsRejected).toBe(3);
    expect(summary.signalsRejectedForEmptyOrderbook).toBe(1);
    expect(summary.signalsRejectedForMissingLiquidity).toBe(0);
    expect(summary.signalsRejectedForLowEdge).toBe(1);
    expect(summary.signalsRejectedForStaleSnapshot).toBe(1);
    expect(summary.workerErrors).toBe(1);
  });
});
