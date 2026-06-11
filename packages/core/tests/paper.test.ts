import { describe, expect, it } from "vitest";
import { normalizeKalshiOrderbook } from "../src/kalshi";
import { simulateComplementPaperTrade, simulateMultiOutcomePaperTrade } from "../src/paper";

const detectedAt = new Date("2026-01-01T00:00:00Z");
const config = {
  executionDelaySeconds: 30,
  feeSettings: { feeBufferPerContract: 0.01 }
};

describe("paper trading simulator", () => {
  it("uses the next snapshot after execution delay", () => {
    const before = normalizeKalshiOrderbook("TEST", { orderbook: { yes: [[40, 5]], no: [[60, 5]] } }, new Date("2026-01-01T00:00:20Z"));
    const after = normalizeKalshiOrderbook("TEST", { orderbook: { yes: [[25, 5]], no: [[80, 5]] } }, new Date("2026-01-01T00:00:31Z"));

    const result = simulateComplementPaperTrade(
      { detectedAt, expectedNetEdge: 0.04, maxContracts: 5 },
      [before, after],
      config
    );

    expect(result.status).toBe("filled");
    expect(result.fills[0]?.filledAt).toEqual(after.capturedAt);
    expect(result.targetExecutionTime).toEqual(new Date("2026-01-01T00:00:30Z"));
    expect(result.actualSnapshotExecutionTime).toEqual(after.capturedAt);
  });

  it("allows a snapshot exactly at the simulated execution time", () => {
    const exact = normalizeKalshiOrderbook("TEST", {
      orderbook: {
        yes: [[25, 5]],
        no: [[80, 5]]
      }
    }, new Date("2026-01-01T00:00:30Z"));

    const result = simulateComplementPaperTrade(
      { detectedAt, expectedNetEdge: 0.04, maxContracts: 5 },
      [exact],
      config
    );

    expect(result.status).toBe("filled");
    expect(result.fills.every((fill) => fill.filledAt.getTime() === exact.capturedAt.getTime())).toBe(true);
  });

  it("fills at ask instead of midpoint", () => {
    const snapshot = normalizeKalshiOrderbook("TEST", {
      orderbook: {
        yes: [[25, 10]],
        no: [[80, 10]]
      }
    }, new Date("2026-01-01T00:00:30Z"));

    const result = simulateComplementPaperTrade(
      { detectedAt, expectedNetEdge: 0.04, maxContracts: 1 },
      [snapshot],
      config
    );

    expect(result.fills.find((fill) => fill.outcome === "yes")?.price).toBe(0.2);
    expect(result.fills.find((fill) => fill.outcome === "no")?.price).toBe(0.75);
  });

  it("records partial fills and leg risk", () => {
    const snapshot = normalizeKalshiOrderbook("TEST", {
      orderbook: {
        yes: [[25, 1]],
        no: [[80, 5]]
      }
    }, new Date("2026-01-01T00:00:30Z"));

    const result = simulateComplementPaperTrade(
      { detectedAt, expectedNetEdge: 0.04, maxContracts: 5 },
      [snapshot],
      config
    );

    expect(result.status).toBe("partial");
    expect(result.legRisk).toBe(true);
    expect(result.fills.reduce((sum, fill) => sum + fill.contracts, 0)).toBe(2);
    expect(result.fills.find((fill) => fill.outcome === "yes")?.contracts).toBe(1);
    expect(result.fills.find((fill) => fill.outcome === "no")?.contracts).toBe(1);
    expect(result.pairedContracts).toBe(1);
    expect(result.unpairedContractsDiscarded).toBe(4);
  });

  it("does not record unpaired excess contracts on the more liquid leg", () => {
    const snapshot = normalizeKalshiOrderbook("TEST", {
      orderbook: {
        yes: [[25, 100]],
        no: [[80, 3]]
      }
    }, new Date("2026-01-01T00:00:30Z"));

    const result = simulateComplementPaperTrade(
      { detectedAt, expectedNetEdge: 0.04, maxContracts: 10 },
      [snapshot],
      config
    );

    const yesContracts = result.fills
      .filter((fill) => fill.outcome === "yes")
      .reduce((sum, fill) => sum + fill.contracts, 0);
    const noContracts = result.fills
      .filter((fill) => fill.outcome === "no")
      .reduce((sum, fill) => sum + fill.contracts, 0);

    expect(result.status).toBe("partial");
    expect(result.legRisk).toBe(true);
    expect(yesContracts).toBe(3);
    expect(noContracts).toBe(3);
  });

  it("walks ask depth and computes realized edge from paired weighted average prices", () => {
    const snapshot = normalizeKalshiOrderbook("TEST", {
      orderbook: {
        yes: [[20, 2], [25, 2]],
        no: [[80, 1], [75, 3]]
      }
    }, new Date("2026-01-01T00:00:30Z"));

    const result = simulateComplementPaperTrade(
      { detectedAt, expectedNetEdge: 0.04, maxContracts: 4 },
      [snapshot],
      config
    );

    expect(result.status).toBe("filled");
    expect(result.fills.filter((fill) => fill.outcome === "yes").map((fill) => fill.price)).toEqual([0.2, 0.25]);
    expect(result.fills.filter((fill) => fill.outcome === "no").map((fill) => fill.price)).toEqual([0.75, 0.8]);
    expect(result.realizedNetEdge).toBe(-0.09);
  });

  it("subtracts fees from realized estimated edge", () => {
    const snapshot = normalizeKalshiOrderbook("TEST", {
      orderbook: {
        yes: [[25, 2]],
        no: [[80, 2]]
      }
    }, new Date("2026-01-01T00:00:30Z"));

    const result = simulateComplementPaperTrade(
      { detectedAt, expectedNetEdge: 0.04, maxContracts: 1 },
      [snapshot],
      config
    );

    expect(result.realizedNetEdge).toBe(0.04);
    expect(result.feeEstimate).toBe(0.01);
  });

  it("does not look ahead before simulated execution time", () => {
    const earlyOnly = normalizeKalshiOrderbook("TEST", {
      orderbook: {
        yes: [[25, 2]],
        no: [[80, 2]]
      }
    }, new Date("2026-01-01T00:00:29Z"));

    const result = simulateComplementPaperTrade(
      { detectedAt, expectedNetEdge: 0.04, maxContracts: 1 },
      [earlyOnly],
      config
    );

    expect(result.status).toBe("failed");
    expect(result.notes).toContain("no orderbook snapshot");
    expect(result.failureReason).toContain("No eligible execution snapshot");
  });

  it("sorts snapshots and uses the earliest eligible one", () => {
    const later = normalizeKalshiOrderbook("TEST", {
      orderbook: {
        yes: [[10, 2]],
        no: [[90, 2]]
      }
    }, new Date("2026-01-01T00:01:00Z"));
    const earliestEligible = normalizeKalshiOrderbook("TEST", {
      orderbook: {
        yes: [[25, 2]],
        no: [[80, 2]]
      }
    }, new Date("2026-01-01T00:00:30Z"));

    const result = simulateComplementPaperTrade(
      { detectedAt, expectedNetEdge: 0.04, maxContracts: 1 },
      [later, earliestEligible],
      config
    );

    expect(result.fills[0]?.filledAt).toEqual(earliestEligible.capturedAt);
    expect(result.realizedNetEdge).toBe(0.04);
  });
});

describe("multi-outcome paper trading simulator", () => {
  it("waits for post-delay snapshots for every outcome", () => {
    const before = normalizeKalshiOrderbook("A", { orderbook: { no: [[52, 5]] } }, new Date("2026-01-01T00:00:20Z"));
    const afterA = normalizeKalshiOrderbook("A", { orderbook: { no: [[52, 5]] } }, new Date("2026-01-01T00:00:31Z"));
    const afterB = normalizeKalshiOrderbook("B", { orderbook: { no: [[51, 5]] } }, new Date("2026-01-01T00:00:32Z"));

    const result = simulateMultiOutcomePaperTrade(
      {
        detectedAt,
        expectedNetEdge: 0.02,
        maxContracts: 5,
        legs: [
          { marketTicker: "A", snapshots: [before, afterA] },
          { marketTicker: "B", snapshots: [afterB] }
        ]
      },
      config
    );

    expect(result.status).toBe("filled");
    expect(result.targetExecutionTime).toEqual(new Date("2026-01-01T00:00:30Z"));
    expect(result.fills.every((fill) => fill.filledAt >= result.targetExecutionTime)).toBe(true);
  });

  it("uses YES asks only and never midpoint pricing", () => {
    const snapshotA = normalizeKalshiOrderbook("A", {
      orderbook: {
        yes: [[30, 10]],
        no: [[52, 10]]
      }
    }, new Date("2026-01-01T00:00:30Z"));
    const snapshotB = normalizeKalshiOrderbook("B", {
      orderbook: {
        yes: [[45, 10]],
        no: [[51, 10]]
      }
    }, new Date("2026-01-01T00:00:30Z"));

    const result = simulateMultiOutcomePaperTrade(
      {
        detectedAt,
        expectedNetEdge: 0.02,
        maxContracts: 1,
        legs: [
          { marketTicker: "A", snapshots: [snapshotA] },
          { marketTicker: "B", snapshots: [snapshotB] }
        ]
      },
      config
    );

    expect(result.fills.map((fill) => fill.price)).toEqual([0.48, 0.49]);
  });

  it("caps partial group fills to the minimum outcome fill and records discarded contracts", () => {
    const snapshotA = normalizeKalshiOrderbook("A", { orderbook: { no: [[52, 2]] } }, new Date("2026-01-01T00:00:30Z"));
    const snapshotB = normalizeKalshiOrderbook("B", { orderbook: { no: [[51, 5]] } }, new Date("2026-01-01T00:00:30Z"));

    const result = simulateMultiOutcomePaperTrade(
      {
        detectedAt,
        expectedNetEdge: 0.02,
        maxContracts: 5,
        legs: [
          { marketTicker: "A", snapshots: [snapshotA] },
          { marketTicker: "B", snapshots: [snapshotB] }
        ]
      },
      config
    );

    expect(result.status).toBe("partial");
    expect(result.pairedContracts).toBe(2);
    expect(result.fills.map((fill) => fill.contracts)).toEqual([2, 2]);
    expect(result.unpairedContractsDiscarded).toBe(3);
    expect(result.groupFillRisk).toBe(true);
  });

  it("does not use snapshots before the execution time for any outcome", () => {
    const earlyA = normalizeKalshiOrderbook("A", { orderbook: { no: [[52, 5]] } }, new Date("2026-01-01T00:00:29Z"));
    const afterB = normalizeKalshiOrderbook("B", { orderbook: { no: [[51, 5]] } }, new Date("2026-01-01T00:00:31Z"));

    const result = simulateMultiOutcomePaperTrade(
      {
        detectedAt,
        expectedNetEdge: 0.02,
        maxContracts: 5,
        legs: [
          { marketTicker: "A", snapshots: [earlyA] },
          { marketTicker: "B", snapshots: [afterB] }
        ]
      },
      config
    );

    expect(result.status).toBe("failed");
    expect(result.failureReason).toContain("No eligible execution snapshot");
  });
});
