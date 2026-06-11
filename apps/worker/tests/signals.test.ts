import { describe, expect, it } from "vitest";
import { marketCandidateLimit, shouldCreatePaperTrade } from "../src/signals";

describe("worker signal helpers", () => {
  it("does not create paper trades for empty or invalid-liquidity snapshots", () => {
    expect(shouldCreatePaperTrade({ status: "accepted" }, { empty_orderbook: true })).toBe(false);
    expect(shouldCreatePaperTrade({ status: "accepted" }, { low_liquidity: true })).toBe(false);
    expect(shouldCreatePaperTrade({ status: "accepted" }, { stale_snapshot: true })).toBe(false);
    expect(shouldCreatePaperTrade({ status: "rejected" }, {})).toBe(false);
  });

  it("allows paper trades only for accepted signals with clean validation flags", () => {
    expect(shouldCreatePaperTrade({ status: "accepted" }, {})).toBe(true);
    expect(shouldCreatePaperTrade({ status: "accepted" }, { missing_yes_book: false, low_liquidity: false })).toBe(true);
  });

  it("uses an auto market candidate pool before applying MAX_MARKETS", () => {
    expect(marketCandidateLimit(5)).toBe(500);
    expect(marketCandidateLimit(25)).toBe(500);
    expect(marketCandidateLimit(600)).toBe(600);
    expect(marketCandidateLimit(5, 1000)).toBe(1000);
  });
});
