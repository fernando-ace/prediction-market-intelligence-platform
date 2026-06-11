import { describe, expect, it } from "vitest";
import { normalizeKalshiOrderbook } from "../src/kalshi";
import {
  deriveRelatedGroupKeyFromTicker,
  detectMultiOutcomeArb,
  groupKalshiRelatedMarkets,
  isLikelyHeadToHeadWinnerGroup
} from "../src/related-markets";
import type { DetectionConfig, MarketLike, RelatedMarketGroup } from "../src/types";

const closeTime = new Date("2099-01-01T00:00:00Z");
const detectedAt = new Date("2026-01-01T00:00:00Z");
const config: DetectionConfig = {
  minNetEdge: 0.005,
  minLiquidityContracts: 1,
  feeSettings: { feeBufferPerContract: 0.01 }
};

describe("related Kalshi market grouping", () => {
  it("derives group key by removing the final outcome suffix", () => {
    expect(deriveRelatedGroupKeyFromTicker("KXITFWMATCH-26JUN11CHASHO-CHA")).toBe("KXITFWMATCH-26JUN11CHASHO");
  });

  it("groups tennis outcome suffixes together by ticker prefix", () => {
    const groups = groupKalshiRelatedMarkets([
      market("KXITFWMATCH-26JUN11CHASHO-CHA", "Will Piper Charney win the Charney vs Sholokhova: W35 Decatur IL Round of 16 match?", null),
      market("KXITFWMATCH-26JUN11CHASHO-SHO", "Will Maria Sholokhova win the Charney vs Sholokhova: W35 Decatur IL Round of 16 match?", null)
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.groupKey).toBe("KXITFWMATCH-26JUN11CHASHO");
    expect(groups[0]?.eligible).toBe(true);
  });

  it("groups markets by event_ticker first", () => {
    const groups = groupKalshiRelatedMarkets([
      market("A", "Will Player A win the match?", "KXEVENT"),
      market("B", "Will Player B win the match?", "KXEVENT"),
      market("C", "Will Player C win the match?", "OTHER")
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.groupKey).toBe("KXEVENT");
    expect(groups[0]?.marketTickers).toEqual(["A", "B"]);
  });

  it("marks obvious two-outcome head-to-head winner groups eligible", () => {
    const result = isLikelyHeadToHeadWinnerGroup([
      market("A", "Will Player A win the match?", "KXEVENT"),
      market("B", "Will Player B win the match?", "KXEVENT")
    ]);

    expect(result.eligible).toBe(true);
    expect(result.confidenceScore).toBeGreaterThanOrEqual(0.9);
  });

  it("rejects prop and stat markets", () => {
    const result = isLikelyHeadToHeadWinnerGroup([
      market("A", "Will Shohei Ohtani record 2+ hits?", "KXEVENT"),
      market("B", "Will Shohei Ohtani record 3+ hits?", "KXEVENT")
    ]);

    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("prop");
  });

  it("rejects threshold ladder markets", () => {
    const result = isLikelyHeadToHeadWinnerGroup([
      market("A", "Will total points be above 3?", "KXEVENT"),
      market("B", "Will total points be above 4?", "KXEVENT")
    ]);

    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("threshold");
  });

  it("rejects Trump mention markets", () => {
    const result = isLikelyHeadToHeadWinnerGroup([
      market("A", "What will Donald Trump say during Barry Moore Tele-Rally?", "KXEVENT"),
      market("B", "What will Donald Trump mention during Barry Moore Tele-Rally?", "KXEVENT")
    ]);

    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("prop");
  });

  it("rejects mismatched close times", () => {
    const result = isLikelyHeadToHeadWinnerGroup([
      market("A", "Will Player A win the match?", "KXEVENT"),
      { ...market("B", "Will Player B win the match?", "KXEVENT"), closeTime: new Date("2099-01-01T00:02:00Z") }
    ]);

    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("close times");
  });
});

describe("multi-outcome detector", () => {
  it("rejects missing YES asks", () => {
    const group = eligibleGroup();
    const signal = detectMultiOutcomeArb(
      group,
      [
        { market: group.markets[0], orderbook: bookWithYesAsk("A", 0.48, 10), validationFlags: {} },
        { market: group.markets[1], orderbook: normalizeKalshiOrderbook("B", { orderbook: { yes: [[40, 10]], no: [] } }, detectedAt), validationFlags: {} }
      ],
      config,
      detectedAt
    );

    expect(signal.status).toBe("rejected");
    expect(signal.rejectionCode).toBe("missing_yes_ask");
  });

  it("rejects low liquidity", () => {
    const group = eligibleGroup();
    const signal = detectMultiOutcomeArb(
      group,
      [
        { market: group.markets[0], orderbook: bookWithYesAsk("A", 0.48, 0.5), validationFlags: {} },
        { market: group.markets[1], orderbook: bookWithYesAsk("B", 0.49, 0.5), validationFlags: {} }
      ],
      config,
      detectedAt
    );

    expect(signal.status).toBe("rejected");
    expect(signal.rejectionCode).toBe("low_liquidity");
  });

  it("computes gross edge when total YES ask is below 1", () => {
    const group = eligibleGroup();
    const signal = detectMultiOutcomeArb(
      group,
      [
        { market: group.markets[0], orderbook: bookWithYesAsk("A", 0.48, 10), validationFlags: {} },
        { market: group.markets[1], orderbook: bookWithYesAsk("B", 0.49, 10), validationFlags: {} }
      ],
      config,
      detectedAt
    );

    expect(signal.totalYesAskCost).toBe(0.97);
    expect(signal.grossEdge).toBe(0.03);
    expect(signal.netEdge).toBe(0.02);
    expect(signal.status).toBe("accepted");
  });

  it("creates a rejected low-edge signal when total YES ask is above 1", () => {
    const group = eligibleGroup();
    const signal = detectMultiOutcomeArb(
      group,
      [
        { market: group.markets[0], orderbook: bookWithYesAsk("A", 0.98, 10), validationFlags: { missing_yes_book: true } },
        { market: group.markets[1], orderbook: bookWithYesAsk("B", 0.05, 10), validationFlags: { missing_yes_book: true } }
      ],
      config,
      detectedAt
    );

    expect(signal.totalYesAskCost).toBe(1.03);
    expect(signal.grossEdge).toBe(-0.03);
    expect(signal.status).toBe("rejected");
    expect(signal.rejectionCode).toBe("low_edge");
  });

  it("lets fees turn positive gross edge into negative net edge", () => {
    const group = eligibleGroup();
    const signal = detectMultiOutcomeArb(
      group,
      [
        { market: group.markets[0], orderbook: bookWithYesAsk("A", 0.497, 10), validationFlags: {} },
        { market: group.markets[1], orderbook: bookWithYesAsk("B", 0.498, 10), validationFlags: {} }
      ],
      config,
      detectedAt
    );

    expect(signal.grossEdge).toBe(0.005);
    expect(signal.netEdge).toBe(-0.005);
    expect(signal.status).toBe("rejected");
    expect(signal.rejectionCode).toBe("low_edge");
  });

  it("never accepts ineligible groups", () => {
    const group = { ...eligibleGroup(), eligible: false, eligibilityReason: "Ineligible: unclear settlement rules." };
    const signal = detectMultiOutcomeArb(
      group,
      [
        { market: group.markets[0], orderbook: bookWithYesAsk("A", 0.48, 10), validationFlags: {} },
        { market: group.markets[1], orderbook: bookWithYesAsk("B", 0.49, 10), validationFlags: {} }
      ],
      config,
      detectedAt
    );

    expect(signal.status).toBe("rejected");
    expect(signal.rejectionCode).toBe("invalid_group_type");
  });
});

function eligibleGroup(): RelatedMarketGroup {
  return groupKalshiRelatedMarkets([
    market("A", "Will Player A win the match?", "KXEVENT"),
    market("B", "Will Player B win the match?", "KXEVENT")
  ])[0]!;
}

function market(ticker: string, title: string, eventTicker: string | null): MarketLike {
  return {
    platform: "kalshi",
    ticker,
    eventTicker,
    title,
    status: "open",
    closeTime
  };
}

function bookWithYesAsk(ticker: string, yesAsk: number, contracts: number) {
  return normalizeKalshiOrderbook(
    ticker,
    {
      orderbook_fp: {
        yes_dollars: [],
        no_dollars: [[String(1 - yesAsk), String(contracts)]]
      }
    },
    detectedAt
  );
}
