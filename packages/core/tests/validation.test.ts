import { describe, expect, it } from "vitest";
import { normalizeKalshiOrderbook } from "../src/kalshi";
import { activeValidationFlags, validateOrderbookSnapshot } from "../src/validation";

describe("orderbook validation flags", () => {
  it("flags missing books and empty orderbooks", () => {
    const book = normalizeKalshiOrderbook("TEST", { orderbook: {} }, new Date("2026-01-01T00:00:00Z"));

    const validation = validateOrderbookSnapshot(book, {
      minLiquidityContracts: 1,
      now: new Date("2026-01-01T00:00:01Z")
    });

    expect(validation.flags.missing_yes_book).toBe(true);
    expect(validation.flags.missing_no_book).toBe(true);
    expect(validation.flags.empty_orderbook).toBe(true);
    expect(validation.flags.low_liquidity).toBe(true);
    expect(activeValidationFlags(validation.flags)).toContain("empty_orderbook");
  });

  it("flags invalid raw prices and parse warnings", () => {
    const book = normalizeKalshiOrderbook("TEST", {
      orderbook: {
        yes: [[125, 1]],
        no: [[80, 1]]
      }
    });

    const validation = validateOrderbookSnapshot(book, { minLiquidityContracts: 1 });

    expect(validation.flags.parse_warning).toBe(true);
    expect(validation.flags.missing_yes_book).toBe(false);
    expect(validation.warnings.join(" ")).toContain("YES book exists");
  });

  it("flags crossed prices and negative spread", () => {
    const book = normalizeKalshiOrderbook("TEST", {
      orderbook: {
        yes: [[70, 10]],
        no: [[40, 10]]
      }
    });

    const validation = validateOrderbookSnapshot(book, { minLiquidityContracts: 1 });

    expect(book.spread).toBe(-0.1);
    expect(validation.flags.negative_spread).toBe(true);
    expect(validation.flags.crossed_or_invalid_prices).toBe(true);
  });

  it("flags stale snapshots using the configured threshold", () => {
    const book = normalizeKalshiOrderbook("TEST", {
      orderbook: {
        yes: [[25, 10]],
        no: [[80, 10]]
      }
    }, new Date("2026-01-01T00:00:00Z"));

    const validation = validateOrderbookSnapshot(book, {
      minLiquidityContracts: 1,
      staleAfterSeconds: 30,
      now: new Date("2026-01-01T00:00:31Z")
    });

    expect(validation.flags.stale_snapshot).toBe(true);
  });
});
