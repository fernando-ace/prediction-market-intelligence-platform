import { describe, expect, it } from "vitest";
import { NormalizedKalshiAdapter } from "../src/adapters/kalshi";
import { normalizeKalshiOrderbook, type AdapterResult, type KalshiMarket, type NormalizedOrderbook } from "../src";

class FakeKalshiClient {
  marketLimit: number | undefined;
  orderbookTicker: string | undefined;
  markets: KalshiMarket[] = [];
  orderbook: NormalizedOrderbook | undefined;

  async fetchOpenMarkets(limit: number): Promise<AdapterResult<KalshiMarket[]>> {
    this.marketLimit = limit;
    return { ok: true, data: this.markets };
  }

  async fetchOrderbook(ticker: string): Promise<AdapterResult<NormalizedOrderbook>> {
    this.orderbookTicker = ticker;
    return this.orderbook ? { ok: true, data: this.orderbook } : { ok: false, error: "missing orderbook" };
  }
}

describe("NormalizedKalshiAdapter", () => {
  it("fetchMarkets returns Kalshi normalized markets", async () => {
    const fake = new FakeKalshiClient();
    fake.markets = [
      {
        ticker: "KXTEST-26",
        title: "Will normalized tests pass?",
        category: "Testing",
        status: "open",
        yes_bid_dollars: "0.42",
        yes_ask_dollars: "0.45"
      }
    ];
    const adapter = new NormalizedKalshiAdapter(fake);

    const result = await adapter.fetchMarkets({ limit: 10 });

    expect(result.nextCursor).toBeUndefined();
    expect(result.markets).toEqual([
      expect.objectContaining({
        platform: "kalshi",
        marketId: "KXTEST-26",
        title: "Will normalized tests pass?",
        category: "Testing",
        status: "active"
      })
    ]);
    expect(result.markets[0].outcomes[0]).toEqual(expect.objectContaining({ outcomeId: "yes", yesBid: 0.42, yesAsk: 0.45 }));
  });

  it("fetchMarkets slices to the requested limit even when the underlying adapter returns more", async () => {
    const fake = new FakeKalshiClient();
    fake.markets = [
      { ticker: "A", title: "A", status: "open" },
      { ticker: "B", title: "B", status: "open" },
      { ticker: "C", title: "C", status: "open" }
    ];
    const adapter = new NormalizedKalshiAdapter(fake);

    const result = await adapter.fetchMarkets({ limit: 2 });

    expect(fake.marketLimit).toBe(2);
    expect(result.markets.map((market) => market.marketId)).toEqual(["A", "B"]);
  });

  it("fetchOrderBookSnapshot returns a normalized snapshot with spread and midpoint", async () => {
    const fake = new FakeKalshiClient();
    fake.orderbook = normalizeKalshiOrderbook(
      "KXTEST-26",
      {
        orderbook: {
          yes: [[40, 5]],
          no: [[57, 10]]
        }
      },
      new Date("2026-06-13T12:00:00Z")
    );
    const adapter = new NormalizedKalshiAdapter(fake);

    const snapshot = await adapter.fetchOrderBookSnapshot("KXTEST-26", "yes");

    expect(fake.orderbookTicker).toBe("KXTEST-26");
    expect(snapshot).toEqual({
      platform: "kalshi",
      marketId: "KXTEST-26",
      outcomeId: "yes",
      capturedAt: "2026-06-13T12:00:00.000Z",
      bestBid: 0.4,
      bestAsk: 0.43,
      spread: 0.03,
      midpoint: 0.415,
      raw: fake.orderbook.rawJson
    });
  });

  it("rejects unsupported caller-supplied cursors instead of silently ignoring them", async () => {
    const adapter = new NormalizedKalshiAdapter(new FakeKalshiClient());

    await expect(adapter.fetchMarkets({ cursor: "opaque-cursor", limit: 2 })).rejects.toThrow(
      "does not support caller-supplied cursors"
    );
  });

  it("rejects unsupported Kalshi outcome IDs", async () => {
    const fake = new FakeKalshiClient();
    fake.orderbook = normalizeKalshiOrderbook("KXTEST-26", { orderbook: { yes: [[40, 5]], no: [[57, 10]] } });
    const adapter = new NormalizedKalshiAdapter(fake);

    await expect(adapter.fetchOrderBookSnapshot("KXTEST-26", "draw")).rejects.toThrow("only supports Kalshi outcome IDs");
  });
});
