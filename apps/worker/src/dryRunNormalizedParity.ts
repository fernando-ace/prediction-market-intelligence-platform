import "./env";

import {
  compareSignalOutputs,
  detectBinaryComplementArb,
  detectMultiOutcomeArb,
  evaluateNormalizedSignals,
  groupKalshiRelatedMarkets,
  normalizeKalshiOrderbook,
  type ExistingSignalComparisonInput,
  type MarketLike,
  type NormalizedMarket,
  type NormalizedOrderbook,
  type NormalizedOrderBookSnapshot,
  type OrderbookValidationFlags,
  type PriceLevel
} from "@prediction-market-scanner/core";
import { Prisma, prisma } from "@prediction-market-scanner/db";
import { loadWorkerConfig } from "./config";
import {
  buildNormalizedParityReport,
  formatNormalizedParityDebugCounts,
  formatNormalizedParityReport,
  NormalizedParityOptionsError,
  parseNormalizedParityOptions
} from "./normalizedParity";

type PersistedKalshiMarket = Awaited<ReturnType<typeof readRecentKalshiMarkets>>[number];
type PersistedSnapshot = PersistedKalshiMarket["orderbookSnapshots"][number];

// Dry-run only: this command reads persisted Kalshi markets and snapshots, runs
// both detector paths in memory, and deliberately never imports persistence
// helpers or calls Prisma create/update/upsert/delete methods.
async function main(): Promise<void> {
  const options = parseNormalizedParityOptions();
  const config = loadWorkerConfig();
  const since = new Date(Date.now() - options.lookbackHours * 60 * 60 * 1000);

  if (options.debugCounts) {
    const debugCounts = await readNormalizedParityDebugCounts({ since });
    console.log(`${formatNormalizedParityDebugCounts(debugCounts)}\n`);
  }

  const markets = await readRecentKalshiMarkets({ since, limit: options.limit });
  const snapshotsEvaluated = markets.reduce((sum, market) => sum + market.orderbookSnapshots.length, 0);

  const existingSignals = buildExistingDetectorSignals(markets, {
    includeMveMarkets: config.includeMveMarkets,
    detectionConfig: config.detection
  });
  const normalizedSignals = evaluateNormalizedSignals({
    markets: markets.map(toNormalizedMarket),
    orderBookSnapshots: markets.flatMap(toNormalizedSnapshots),
    detectionConfig: config.detection,
    includeMveMarkets: config.includeMveMarkets,
    validationFlagsByMarketId: Object.fromEntries(
      markets.flatMap((market) => {
        const snapshot = market.orderbookSnapshots[0];
        return snapshot ? [[market.ticker, readValidationFlags(snapshot.validationFlags)]] : [];
      })
    )
  });

  const comparison = compareSignalOutputs(existingSignals, normalizedSignals);
  const report = buildNormalizedParityReport({
    lookbackHours: options.lookbackHours,
    marketsEvaluated: markets.length,
    snapshotsEvaluated,
    comparison
  });

  console.log(formatNormalizedParityReport(report, { verbose: options.verbose }));
}

async function readNormalizedParityDebugCounts(args: { since: Date }) {
  const [totalMarkets, totalOrderbookSnapshots, marketMax, snapshotMax, snapshotsInsideLookback] = await Promise.all([
    prisma.market.count(),
    prisma.orderbookSnapshot.count(),
    prisma.market.aggregate({
      _max: {
        createdAt: true,
        updatedAt: true
      }
    }),
    prisma.orderbookSnapshot.aggregate({
      _max: {
        capturedAt: true
      }
    }),
    prisma.orderbookSnapshot.count({
      where: {
        capturedAt: {
          gte: args.since
        }
      }
    })
  ]);

  return {
    totalMarkets,
    totalOrderbookSnapshots,
    newestMarketTimestamp: newestDate(marketMax._max.updatedAt, marketMax._max.createdAt),
    newestOrderbookSnapshotTimestamp: snapshotMax._max.capturedAt,
    snapshotsInsideLookback
  };
}

async function readRecentKalshiMarkets(args: { since: Date; limit: number }) {
  return prisma.market.findMany({
    where: {
      platform: "kalshi",
      orderbookSnapshots: {
        some: {
          capturedAt: {
            gte: args.since
          }
        }
      }
    },
    orderBy: [{ updatedAt: "desc" }, { closeTime: "asc" }],
    take: args.limit,
    include: {
      orderbookSnapshots: {
        where: {
          capturedAt: {
            gte: args.since
          }
        },
        orderBy: {
          capturedAt: "desc"
        },
        take: 1
      }
    }
  });
}

function buildExistingDetectorSignals(
  markets: PersistedKalshiMarket[],
  options: {
    includeMveMarkets: boolean;
    detectionConfig: Parameters<typeof detectBinaryComplementArb>[2];
  }
): ExistingSignalComparisonInput[] {
  const signals: ExistingSignalComparisonInput[] = [];
  const latestByMarketId = new Map(
    markets.flatMap((market) => {
      const snapshot = market.orderbookSnapshots[0];
      return snapshot ? [[market.id, snapshotToOrderbook(snapshot, market.ticker)]] : [];
    })
  );

  for (const market of markets) {
    const orderbook = latestByMarketId.get(market.id);
    if (!orderbook) {
      continue;
    }

    const signal = detectBinaryComplementArb(orderbook, toMarketLike(market), options.detectionConfig);
    signals.push({
      platform: "kalshi",
      marketId: market.ticker,
      strategy: signal.strategy,
      netEdge: signal.netEdge,
      reason: signal.reason,
      raw: signal.rawJson
    });
  }

  const groups = groupKalshiRelatedMarkets(markets.map(toMarketLike), {
    includeMveMarkets: options.includeMveMarkets
  });
  const marketByTicker = new Map(markets.map((market) => [market.ticker, market]));

  for (const group of groups) {
    const snapshots = group.markets.map((groupMarket) => {
      const market = groupMarket.ticker ? marketByTicker.get(groupMarket.ticker) : undefined;
      const snapshot = market ? latestByMarketId.get(market.id) : undefined;
      return {
        market: groupMarket,
        orderbook: snapshot ?? null,
        validationFlags: market?.orderbookSnapshots[0] ? readValidationFlags(market.orderbookSnapshots[0].validationFlags) : undefined
      };
    });
    const signal = detectMultiOutcomeArb(group, snapshots, options.detectionConfig);
    signals.push({
      platform: group.platform,
      marketId: group.marketTickers[0] ?? group.groupKey,
      strategy: signal.strategy,
      netEdge: signal.netEdge,
      reason: signal.reason,
      raw: signal.rawJson
    });
  }

  return signals;
}

function toNormalizedMarket(market: PersistedKalshiMarket): NormalizedMarket {
  const snapshot = market.orderbookSnapshots[0];
  return {
    platform: "kalshi",
    marketId: market.ticker,
    title: market.title,
    category: market.category ?? undefined,
    closeTime: market.closeTime?.toISOString(),
    status: toNormalizedMarketStatus(market.status),
    outcomes: [
      {
        outcomeId: "yes",
        label: "YES",
        yesBid: decimalToNumber(snapshot?.bestYesBid),
        yesAsk: decimalToNumber(snapshot?.bestYesAsk),
        liquidity: sumLevels(snapshot ? snapshotToOrderbook(snapshot, market.ticker).yesAsks : [])
      },
      {
        outcomeId: "no",
        label: "NO",
        yesBid: decimalToNumber(snapshot?.bestNoBid),
        yesAsk: decimalToNumber(snapshot?.bestNoAsk),
        liquidity: sumLevels(snapshot ? snapshotToOrderbook(snapshot, market.ticker).noAsks : [])
      }
    ],
    raw: {
      event_ticker: market.eventTicker,
      eventTicker: market.eventTicker,
      rules_primary: market.resolutionRules
    }
  };
}

function toNormalizedSnapshots(market: PersistedKalshiMarket): NormalizedOrderBookSnapshot[] {
  const snapshot = market.orderbookSnapshots[0];
  if (!snapshot) {
    return [];
  }

  const providerRaw = readProviderRaw(snapshot.rawJson);
  if (providerRaw !== undefined) {
    return [
      {
        platform: "kalshi",
        marketId: market.ticker,
        capturedAt: snapshot.capturedAt.toISOString(),
        raw: providerRaw
      }
    ];
  }

  return [
    {
      platform: "kalshi",
      marketId: market.ticker,
      outcomeId: "yes",
      capturedAt: snapshot.capturedAt.toISOString(),
      bestBid: decimalToNumber(snapshot.bestYesBid),
      bestAsk: decimalToNumber(snapshot.bestYesAsk),
      spread: decimalToNumber(snapshot.spread)
    },
    {
      platform: "kalshi",
      marketId: market.ticker,
      outcomeId: "no",
      capturedAt: snapshot.capturedAt.toISOString(),
      bestBid: decimalToNumber(snapshot.bestNoBid),
      bestAsk: decimalToNumber(snapshot.bestNoAsk)
    }
  ];
}

function toMarketLike(market: PersistedKalshiMarket): MarketLike {
  return {
    id: market.id,
    platform: "kalshi",
    ticker: market.ticker,
    eventTicker: market.eventTicker,
    title: market.title,
    resolutionRules: market.resolutionRules,
    status: market.status,
    closeTime: market.closeTime
  };
}

function snapshotToOrderbook(snapshot: PersistedSnapshot, marketTicker: string): NormalizedOrderbook {
  const providerRaw = readProviderRaw(snapshot.rawJson);
  const raw = readRecord(snapshot.rawJson);
  const normalized = readRecord(raw?.normalized);
  const yesBids = readLevels(normalized?.yesBids);
  const noBids = readLevels(normalized?.noBids);
  const yesAsks = readLevels(normalized?.yesAsks);
  const noAsks = readLevels(normalized?.noAsks);

  if (providerRaw !== undefined && yesBids.length === 0 && noBids.length === 0 && yesAsks.length === 0 && noAsks.length === 0) {
    return normalizeKalshiOrderbook(marketTicker, providerRaw, snapshot.capturedAt);
  }

  return {
    platform: "kalshi",
    marketTicker,
    capturedAt: snapshot.capturedAt,
    bestYesBid: decimalToNullableNumber(snapshot.bestYesBid),
    bestYesAsk: decimalToNullableNumber(snapshot.bestYesAsk),
    bestNoBid: decimalToNullableNumber(snapshot.bestNoBid),
    bestNoAsk: decimalToNullableNumber(snapshot.bestNoAsk),
    spread: decimalToNullableNumber(snapshot.spread),
    yesBids,
    noBids,
    yesAsks,
    noAsks,
    rawJson: providerRaw ?? snapshot.rawJson
  };
}

function readProviderRaw(value: Prisma.JsonValue): unknown {
  const raw = readRecord(value);
  if (!raw) {
    return undefined;
  }
  if (raw.provider !== undefined) {
    return raw.provider;
  }
  if (raw.orderbook !== undefined || raw.orderbook_fp !== undefined || raw.yes !== undefined || raw.no !== undefined) {
    return raw;
  }
  return undefined;
}

function readLevels(value: unknown): PriceLevel[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((level) => {
    const record = readRecord(level);
    const price = Number(record?.price);
    const contracts = Number(record?.contracts);
    return Number.isFinite(price) && Number.isFinite(contracts) ? [{ price, contracts }] : [];
  });
}

function readValidationFlags(value: Prisma.JsonValue | null): Partial<OrderbookValidationFlags> {
  const record = readRecord(value);
  if (!record) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(record)
      .filter(([, flagValue]) => typeof flagValue === "boolean")
      .map(([key, flagValue]) => [key, flagValue])
  ) as Partial<OrderbookValidationFlags>;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function decimalToNumber(value: Prisma.Decimal | null | undefined): number | undefined {
  return value === null || value === undefined ? undefined : value.toNumber();
}

function decimalToNullableNumber(value: Prisma.Decimal | null | undefined): number | null {
  return value === null || value === undefined ? null : value.toNumber();
}

function sumLevels(levels: PriceLevel[]): number {
  return levels.reduce((sum, level) => sum + level.contracts, 0);
}

function toNormalizedMarketStatus(status: string): NormalizedMarket["status"] {
  const normalized = status.toLowerCase();
  if (normalized === "open" || normalized === "active") {
    return "active";
  }
  if (normalized === "closed" || normalized === "settled") {
    return normalized;
  }
  return "unknown";
}

function newestDate(...values: Array<Date | null | undefined>): Date | null {
  const timestamps = values.filter((value): value is Date => value instanceof Date);
  if (timestamps.length === 0) {
    return null;
  }
  return new Date(Math.max(...timestamps.map((value) => value.getTime())));
}

main()
  .catch((error) => {
    if (error instanceof NormalizedParityOptionsError) {
      console.error(error.message);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  })
  .finally(() => {
    return prisma.$disconnect();
  });
