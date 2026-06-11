import { describe, expect, it } from "vitest";
import {
  isKalshiMveMarket,
  scoreKalshiMarketActivity,
  selectActiveKalshiMarkets,
  summarizeKalshiCandidateMarkets
} from "../src/market-activity";
import type { KalshiMarket } from "../src/kalshi";

describe("Kalshi market activity scoring", () => {
  it("scores volume, liquidity, open interest, and visible quote fields", () => {
    const activity = scoreKalshiMarketActivity({
      ticker: "ACTIVE",
      status: "open",
      volume_fp: "100",
      volume_24h_fp: 25,
      liquidity_dollars: "2500",
      open_interest_fp: 75,
      yes_bid_dollars: "0.48",
      yes_ask_dollars: "0.52",
      yes_bid_size_fp: "12",
      yes_ask_size_fp: "8",
      no_bid_dollars: null,
      no_ask_dollars: undefined,
      last_price_dollars: "0.5",
      close_time: "2099-01-01T00:00:00Z"
    });

    expect(activity.activityScore).toBeGreaterThan(7_000);
    expect(activity.hasActivity).toBe(true);
    expect(activity.hasVisibleBidAsk).toBe(true);
    expect(activity.volume).toBe(100);
    expect(activity.volume24h).toBe(25);
    expect(activity.liquidity).toBe(2500);
    expect(activity.openInterest).toBe(75);
  });

  it("prefers open and liquid markets over inactive or empty markets", () => {
    const markets: KalshiMarket[] = [
      { ticker: "EMPTY", status: "open", close_time: "2099-01-01T00:00:00Z" },
      { ticker: "CLOSED_BUT_BUSY", status: "closed", volume_fp: 1_000_000, liquidity_dollars: 1_000_000 },
      { ticker: "ACTIVE", status: "open", volume_24h_fp: 100, liquidity_dollars: 500, yes_bid_dollars: "0.40" }
    ];

    const selected = selectActiveKalshiMarkets(markets, 2);

    expect(selected.map((entry) => entry.market.ticker)).toEqual(["CLOSED_BUT_BUSY", "ACTIVE"]);
  });

  it("does not crash when activity fields are missing or malformed", () => {
    const activity = scoreKalshiMarketActivity({
      ticker: "ODD",
      volume_fp: "not a number",
      liquidity_dollars: {},
      open_interest_fp: [],
      yes_bid_dollars: -1
    });

    expect(activity.activityScore).toBe(0);
    expect(activity.hasActivity).toBe(false);
    expect(activity.volume).toBeNull();
    expect(activity.liquidity).toBeNull();
    expect(activity.openInterest).toBeNull();
  });

  it("keeps no-activity markets near zero even when open and close time exists", () => {
    const activity = scoreKalshiMarketActivity({
      ticker: "EMPTY",
      status: "open",
      close_time: "2099-01-01T00:00:00Z"
    });

    expect(activity.activityScore).toBeLessThanOrEqual(10);
    expect(activity.hasActivity).toBe(false);
  });

  it("supports Kalshi dollar and fp activity field aliases", () => {
    const activity = scoreKalshiMarketActivity({
      ticker: "ALIASES",
      status: "active",
      volume_fp: "42",
      volume_24h_fp: "12",
      liquidity_dollars: "1234.56",
      open_interest_fp: "88",
      yes_bid_dollars: "0.41",
      no_ask_dollars: "0.62",
      last_price_dollars: "0.39"
    });

    expect(activity.volume).toBe(42);
    expect(activity.volume24h).toBe(12);
    expect(activity.liquidity).toBe(1234.56);
    expect(activity.openInterest).toBe(88);
    expect(activity.lastPrice).toBe(0.39);
    expect(activity.hasVisibleBidAsk).toBe(true);
  });

  it("excludes KXMVE markets by default", () => {
    const markets: KalshiMarket[] = [
      { ticker: "KXMVESPORTSMULTIGAMEEXTENDED-TEST", status: "open", yes_bid_dollars: "0.40" },
      { ticker: "KXNORMAL-TEST", status: "open", yes_bid_dollars: "0.30", yes_ask_dollars: "0.35" },
      { ticker: "KXCOLLECTION-TEST", status: "open", mve_collection_ticker: "KXMVE-R", yes_bid_dollars: "0.45" },
      { ticker: "KXLEGS-TEST", status: "open", mve_selected_legs: [{ ticker: "LEG" }], yes_bid_dollars: "0.50" }
    ];

    const selected = selectActiveKalshiMarkets(markets, 10);

    expect(selected.map((entry) => entry.market.ticker)).toEqual(["KXNORMAL-TEST"]);
    expect(isKalshiMveMarket(markets[0])).toBe(true);
    expect(isKalshiMveMarket(markets[2])).toBe(true);
    expect(isKalshiMveMarket(markets[3])).toBe(true);
  });

  it("summarizes candidate stats and excluded MVE count", () => {
    const stats = summarizeKalshiCandidateMarkets([
      { ticker: "KXMVE-TEST", mve_collection_ticker: "KXMVE-R", yes_bid_dollars: "0.40" },
      { ticker: "KXNORMAL-A", yes_bid_dollars: "0.40", liquidity_dollars: "10" },
      { ticker: "KXNORMAL-B", volume_24h_fp: "3", open_interest_fp: "8" }
    ]);

    expect(stats.candidateMarketsFetched).toBe(3);
    expect(stats.mveMarketsExcluded).toBe(1);
    expect(stats.marketsWithVisibleBidAsk).toBe(1);
    expect(stats.marketsWithPositiveLiquidity).toBe(1);
    expect(stats.marketsWithPositiveVolume24h).toBe(1);
    expect(stats.marketsWithPositiveOpenInterest).toBe(1);
  });
});
