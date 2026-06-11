import type { NormalizedOrderbook, Platform, PriceLevel } from "./types";

export interface KalshiAdapterOptions {
  baseUrl: string;
  fetcher?: typeof fetch;
}

export interface FetchKalshiMarketsOptions {
  includeMveMarkets?: boolean;
}

export interface KalshiMarket {
  ticker: string;
  event_ticker?: string;
  title?: string;
  subtitle?: string;
  rules_primary?: string;
  rules_secondary?: string;
  category?: string;
  status?: string;
  close_time?: string;
  created_time?: string;
  updated_time?: string;
  [key: string]: unknown;
}

export interface KalshiMarketsResponse {
  markets: KalshiMarket[];
  cursor?: string;
}

export interface AdapterResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  status?: number;
}

const platform: Platform = "kalshi";

export class KalshiReadOnlyAdapter {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: KalshiAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetcher = options.fetcher ?? fetch;
  }

  async fetchOpenMarkets(limit: number, options: FetchKalshiMarketsOptions = {}): Promise<AdapterResult<KalshiMarket[]>> {
    const markets: KalshiMarket[] = [];
    let cursor: string | undefined;
    const includeMveMarkets = options.includeMveMarkets ?? false;

    try {
      while (markets.length < limit) {
        const url = new URL(`${this.baseUrl}/markets`);
        url.searchParams.set("status", "open");
        if (!includeMveMarkets) {
          url.searchParams.set("mve_filter", "exclude");
        }
        url.searchParams.set("limit", String(Math.min(1000, limit - markets.length)));
        if (cursor) {
          url.searchParams.set("cursor", cursor);
        }

        const response = await this.fetcher(url);
        if (!response.ok) {
          return {
            ok: false,
            status: response.status,
            error: `Kalshi markets request failed with status ${response.status}`
          };
        }

        const body = (await response.json()) as KalshiMarketsResponse;
        markets.push(...(Array.isArray(body.markets) ? body.markets : []));
        cursor = body.cursor || undefined;
        if (!cursor || markets.length >= limit) {
          break;
        }
      }

      return { ok: true, data: markets.slice(0, limit) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Unknown Kalshi markets error" };
    }
  }

  async fetchOrderbook(ticker: string): Promise<AdapterResult<NormalizedOrderbook>> {
    try {
      const response = await this.fetcher(`${this.baseUrl}/markets/${encodeURIComponent(ticker)}/orderbook`);
      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          error: `Kalshi orderbook request for ${ticker} failed with status ${response.status}`
        };
      }

      const body = await response.json();
      return { ok: true, data: normalizeKalshiOrderbook(ticker, body, new Date()) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : `Unknown Kalshi orderbook error for ${ticker}` };
    }
  }
}

export function normalizeKalshiOrderbook(
  marketTicker: string,
  rawJson: unknown,
  capturedAt: Date = new Date()
): NormalizedOrderbook {
  const yesBids = extractBidLevels(rawJson, "yes").sort((a, b) => b.price - a.price);
  const noBids = extractBidLevels(rawJson, "no").sort((a, b) => b.price - a.price);
  const yesAsks = noBids.map((level) => ({ price: roundPrice(1 - level.price), contracts: level.contracts })).sort(sortAsk);
  const noAsks = yesBids.map((level) => ({ price: roundPrice(1 - level.price), contracts: level.contracts })).sort(sortAsk);

  const bestYesBid = yesBids[0]?.price ?? null;
  const bestNoBid = noBids[0]?.price ?? null;
  const bestYesAsk = noBids[0] ? roundPrice(1 - noBids[0].price) : null;
  const bestNoAsk = yesBids[0] ? roundPrice(1 - yesBids[0].price) : null;
  const spread = bestYesAsk !== null && bestYesBid !== null ? roundPrice(bestYesAsk - bestYesBid) : null;

  return {
    platform,
    marketTicker,
    capturedAt,
    bestYesBid,
    bestYesAsk,
    bestNoBid,
    bestNoAsk,
    spread,
    yesBids,
    noBids,
    yesAsks,
    noAsks,
    rawJson
  };
}

function extractBidLevels(rawJson: unknown, side: "yes" | "no"): PriceLevel[] {
  if (!rawJson || typeof rawJson !== "object") {
    return [];
  }

  const root = rawJson as Record<string, unknown>;
  const orderbook = readRecord(root.orderbook);
  const orderbookFp = readRecord(root.orderbook_fp);
  const fpKey = `${side}_dollars`;
  const candidates = [
    orderbookFp?.[fpKey],
    orderbook?.[fpKey],
    orderbook?.[side],
    root[side],
    root[fpKey]
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.map(parseLevel).filter((level): level is PriceLevel => Boolean(level));
    }
  }

  return [];
}

function parseLevel(value: unknown): PriceLevel | null {
  if (!Array.isArray(value) || value.length < 2) {
    return null;
  }

  const rawPrice = Number(value[0]);
  const rawContracts = Number(value[1]);
  if (!Number.isFinite(rawPrice) || !Number.isFinite(rawContracts) || rawContracts <= 0) {
    return null;
  }

  const price = rawPrice > 1 ? rawPrice / 100 : rawPrice;
  if (price < 0 || price > 1) {
    return null;
  }

  return { price: roundPrice(price), contracts: rawContracts };
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function sortAsk(a: PriceLevel, b: PriceLevel): number {
  return a.price - b.price;
}

export function roundPrice(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
