import { describe, expect, it } from "vitest";
import { normalizeKalshiMarket, normalizeKalshiOrderBookSnapshot } from "../src/adapters/kalshi";
import { KalshiReadOnlyAdapter, normalizeKalshiOrderbook } from "../src/kalshi";

describe("Kalshi orderbook normalization", () => {
  it("normalizes bid-only orderbooks into best YES/NO bids and asks", () => {
    const book = normalizeKalshiOrderbook("TEST", {
      orderbook: {
        yes: [[40, 5], [41, 2]],
        no: [[58, 3], [57, 8]]
      }
    });

    expect(book.bestYesBid).toBe(0.41);
    expect(book.bestNoBid).toBe(0.58);
    expect(book.bestYesAsk).toBe(0.42);
    expect(book.bestNoAsk).toBe(0.59);
    expect(book.spread).toBe(0.01);
  });

  it("converts YES bids into NO asks", () => {
    const book = normalizeKalshiOrderbook("TEST", {
      orderbook: {
        yes: [[7, 8738]],
        no: []
      }
    });

    expect(book.noAsks).toEqual([{ price: 0.93, contracts: 8738 }]);
  });

  it("converts NO bids into YES asks", () => {
    const book = normalizeKalshiOrderbook("TEST", {
      orderbook: {
        yes: [],
        no: [[80, 25]]
      }
    });

    expect(book.yesAsks).toEqual([{ price: 0.2, contracts: 25 }]);
  });

  it("supports fractional dollar orderbook responses", () => {
    const book = normalizeKalshiOrderbook("TEST", {
      orderbook_fp: {
        yes_dollars: [["0.4000", "2.00"]],
        no_dollars: [["0.5700", "4.00"]]
      }
    });

    expect(book.bestYesBid).toBe(0.4);
    expect(book.bestNoBid).toBe(0.57);
    expect(book.bestYesAsk).toBe(0.43);
  });

  it("sorts unsorted bids before deriving best asks", () => {
    const book = normalizeKalshiOrderbook("TEST", {
      orderbook: {
        yes: [[12, 1], [44, 1], [30, 1]],
        no: [[20, 1], [67, 1], [40, 1]]
      }
    });

    expect(book.bestYesBid).toBe(0.44);
    expect(book.bestNoBid).toBe(0.67);
    expect(book.bestYesAsk).toBe(0.33);
    expect(book.bestNoAsk).toBe(0.56);
  });

  it("supports dollar bid arrays nested under orderbook", () => {
    const book = normalizeKalshiOrderbook("TEST", {
      orderbook: {
        yes_dollars: [["0.3100", "6.00"]],
        no_dollars: [["0.6500", "4.00"]]
      }
    });

    expect(book.bestYesBid).toBe(0.31);
    expect(book.bestNoBid).toBe(0.65);
    expect(book.bestYesAsk).toBe(0.35);
    expect(book.bestNoAsk).toBe(0.69);
  });

  it("returns null best prices and empty depth for missing orderbooks", () => {
    const book = normalizeKalshiOrderbook("TEST", { orderbook: {} });

    expect(book.bestYesBid).toBeNull();
    expect(book.bestYesAsk).toBeNull();
    expect(book.bestNoBid).toBeNull();
    expect(book.bestNoAsk).toBeNull();
    expect(book.yesAsks).toEqual([]);
    expect(book.noAsks).toEqual([]);
  });

  it("requests Kalshi markets with mve_filter=exclude by default", async () => {
    const requestedUrls: string[] = [];
    const adapter = new KalshiReadOnlyAdapter({
      baseUrl: "https://example.test",
      fetcher: async (url) => {
        requestedUrls.push(String(url));
        return new Response(JSON.stringify({ markets: [] }), { status: 200 });
      }
    });

    await adapter.fetchOpenMarkets(10);

    expect(requestedUrls).toHaveLength(1);
    expect(new URL(requestedUrls[0]).searchParams.get("mve_filter")).toBe("exclude");
  });

  it("omits mve_filter when MVE markets are explicitly included", async () => {
    const requestedUrls: string[] = [];
    const adapter = new KalshiReadOnlyAdapter({
      baseUrl: "https://example.test",
      fetcher: async (url) => {
        requestedUrls.push(String(url));
        return new Response(JSON.stringify({ markets: [] }), { status: 200 });
      }
    });

    await adapter.fetchOpenMarkets(10, { includeMveMarkets: true });

    expect(new URL(requestedUrls[0]).searchParams.has("mve_filter")).toBe(false);
  });

  it("maps Kalshi market fields into a normalized market", () => {
    const market = normalizeKalshiMarket({
      ticker: "KXTEST-26",
      title: "Will the test pass?",
      category: "Testing",
      status: "open",
      close_time: "2026-06-14T00:00:00Z",
      yes_bid_dollars: "0.42",
      yes_ask_dollars: "0.45",
      no_bid_dollars: "0.55",
      no_ask_dollars: "0.58",
      volume_fp: "100",
      liquidity_dollars: "25.5"
    });

    expect(market).toMatchObject({
      platform: "kalshi",
      marketId: "KXTEST-26",
      title: "Will the test pass?",
      category: "Testing",
      closeTime: "2026-06-14T00:00:00Z",
      status: "active"
    });
    expect(market.outcomes).toEqual([
      expect.objectContaining({ outcomeId: "yes", label: "YES", yesBid: 0.42, yesAsk: 0.45, volume: 100, liquidity: 25.5 }),
      expect.objectContaining({ outcomeId: "no", label: "NO", yesBid: 0.55, yesAsk: 0.58, volume: 100, liquidity: 25.5 })
    ]);
  });

  it("maps a YES Kalshi orderbook into a normalized orderbook snapshot", () => {
    const capturedAt = new Date("2026-06-13T12:00:00Z");
    const orderbook = normalizeKalshiOrderbook("KXTEST-26", {
      orderbook: {
        yes: [[40, 5]],
        no: [[57, 10]]
      }
    }, capturedAt);

    const snapshot = normalizeKalshiOrderBookSnapshot(orderbook, "yes");

    expect(snapshot).toEqual({
      platform: "kalshi",
      marketId: "KXTEST-26",
      outcomeId: "yes",
      capturedAt: "2026-06-13T12:00:00.000Z",
      bestBid: 0.4,
      bestAsk: 0.43,
      spread: 0.03,
      midpoint: 0.415,
      raw: orderbook.rawJson
    });
  });

  it("maps a NO Kalshi orderbook into a normalized orderbook snapshot", () => {
    const capturedAt = new Date("2026-06-13T12:00:00Z");
    const orderbook = normalizeKalshiOrderbook("KXTEST-26", {
      orderbook: {
        yes: [[41, 8]],
        no: [[56, 4]]
      }
    }, capturedAt);

    const snapshot = normalizeKalshiOrderBookSnapshot(orderbook, "no");

    expect(snapshot).toMatchObject({
      platform: "kalshi",
      marketId: "KXTEST-26",
      outcomeId: "no",
      capturedAt: "2026-06-13T12:00:00.000Z",
      bestBid: 0.56,
      bestAsk: 0.59,
      spread: 0.03,
      midpoint: 0.575
    });
  });
});
