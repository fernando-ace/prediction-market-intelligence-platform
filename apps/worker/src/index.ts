import "./env";

import {
  KalshiReadOnlyAdapter,
  detectBinaryComplementArb,
  detectMultiOutcomeArb,
  groupKalshiRelatedMarkets,
  normalizeKalshiOrderbook,
  selectActiveKalshiMarkets,
  simulateMultiOutcomePaperTrade,
  summarizeKalshiCandidateMarkets,
  simulateComplementPaperTrade,
  summarizeValidationSample,
  validateOrderbookSnapshot,
  type KalshiMarket,
  type NormalizedOrderbook,
  type OrderbookValidationFlags,
  type RelatedMarketGroup,
  type SampleSignalInput,
  type PriceLevel
} from "@prediction-market-scanner/core";
import { Prisma, prisma } from "@prediction-market-scanner/db";
import { loadWorkerConfig, type WorkerConfig } from "./config";
import { marketCandidateLimit, shouldCreatePaperTrade } from "./signals";

const config = loadWorkerConfig();
const adapter = new KalshiReadOnlyAdapter({ baseUrl: config.kalshiBaseUrl });

let orderbookCycleRunning = false;
let marketRefreshRunning = false;
let selectedMarketTickers: string[] = [];

async function main(): Promise<void> {
  console.log("Starting read-only prediction market scanner worker.");
  console.log(`Polling up to ${config.maxMarkets} Kalshi markets every ${config.pollIntervalSeconds}s.`);

  await refreshMarkets();
  await runOrderbookCycle();

  setInterval(() => {
    void refreshMarkets();
  }, config.marketPollIntervalSeconds * 1000);

  setInterval(() => {
    void runOrderbookCycle();
  }, config.pollIntervalSeconds * 1000);
}

async function refreshMarkets(): Promise<void> {
  if (marketRefreshRunning) {
    return;
  }

  marketRefreshRunning = true;
  const log = await createRunLog("market_refresh");

  try {
    const result = await adapter.fetchOpenMarkets(marketCandidateLimit(config.maxMarkets, config.kalshiCandidateMarketLimit), {
      includeMveMarkets: config.includeMveMarkets
    });
    if (!result.ok || !result.data) {
      await finishRunLog(log.id, "error", {
        error: result.error ?? "Unknown market refresh error",
        rawJson: toJson({ status: result.status })
      });
      return;
    }

    const candidateStats = summarizeKalshiCandidateMarkets(result.data, {
      includeMveMarkets: config.includeMveMarkets
    });
    const selectedMarkets = selectActiveKalshiMarkets(result.data, config.maxMarkets, {
      includeMveMarkets: config.includeMveMarkets
    });
    selectedMarketTickers = selectedMarkets.map((selected) => selected.market.ticker);

    for (const market of selectedMarkets.map((selected) => selected.market)) {
      await upsertMarket(market);
    }

    await finishRunLog(log.id, "success", {
      marketsFetched: selectedMarkets.length,
      message: `Selected ${selectedMarkets.length} active Kalshi markets from ${result.data.length} open candidates.`,
      rawJson: toJson({
        ...candidateStats,
        candidateMarketsFetched: result.data.length,
        selectedMarkets: selectedMarkets.map((selected) => ({
          ticker: selected.market.ticker,
          activityScore: selected.activity.activityScore,
          status: selected.activity.status
        }))
      })
    });
  } catch (error) {
    await finishRunLog(log.id, "error", { error: errorMessage(error) });
  } finally {
    marketRefreshRunning = false;
  }
}

async function runOrderbookCycle(): Promise<void> {
  if (orderbookCycleRunning) {
    return;
  }

  orderbookCycleRunning = true;
  const log = await createRunLog("orderbook_poll");
  let snapshotsStored = 0;
  let signalsCreated = 0;
  let paperTradesCreated = 0;
  const signals: SampleSignalInput[] = [];
  const validationFlags: Array<Record<string, boolean>> = [];
  const latestCycleSnapshots = new Map<
    string,
    {
      orderbook: NormalizedOrderbook;
      snapshotId: string;
      validationFlags: OrderbookValidationFlags;
    }
  >();
  const errors: string[] = [];

  try {
    const markets = await readMarketsForOrderbookCycle();

    for (const market of markets) {
      const result = await adapter.fetchOrderbook(market.ticker);
      if (!result.ok || !result.data) {
        errors.push(result.error ?? `Unknown orderbook error for ${market.ticker}`);
        continue;
      }

      const orderbook = result.data;
      const validation = validateOrderbookSnapshot(orderbook, {
        minLiquidityContracts: config.detection.minLiquidityContracts
      });
      validationFlags.push(validation.flags);
      const snapshot = await prisma.orderbookSnapshot.create({
        data: {
          marketId: market.id,
          platform: orderbook.platform,
          capturedAt: orderbook.capturedAt,
          bestYesBid: orderbook.bestYesBid,
          bestYesAsk: orderbook.bestYesAsk,
          bestNoBid: orderbook.bestNoBid,
          bestNoAsk: orderbook.bestNoAsk,
          spread: orderbook.spread,
          validationFlags: toJson(validation.flags),
          liquidityUsedByDetector: validation.liquidityUsedByDetector,
          parseWarnings: validation.warnings.join("\n") || null,
          rawJson: toJson({
            provider: orderbook.rawJson,
            normalized: {
              marketTicker: orderbook.marketTicker,
              yesBids: orderbook.yesBids,
              noBids: orderbook.noBids,
              yesAsks: orderbook.yesAsks,
              noAsks: orderbook.noAsks
            }
          })
        }
      });
      snapshotsStored += 1;
      latestCycleSnapshots.set(market.id, {
        orderbook,
        snapshotId: snapshot.id,
        validationFlags: validation.flags
      });

      const signal = detectBinaryComplementArb(
        orderbook,
        { status: market.status, closeTime: market.closeTime },
        config.detection
      );

      const savedSignal = await prisma.signal.create({
        data: {
          marketId: market.id,
          platform: orderbook.platform,
          strategy: signal.strategy,
          detectedAt: signal.detectedAt,
          grossEdge: signal.grossEdge,
          estimatedFees: signal.estimatedFees,
          netEdge: signal.netEdge,
          maxContracts: signal.maxContracts,
          confidenceScore: signal.confidenceScore,
          liquidityScore: signal.liquidityScore,
          status: signal.status,
          reason: signal.reason,
          rawJson: toJson({ ...signal.rawJson, snapshotId: snapshot.id })
        }
      });
      signalsCreated += 1;
      signals.push({ status: signal.status, reason: signal.reason, validationFlags: validation.flags });

      if (shouldCreatePaperTrade(signal, validation.flags)) {
        await prisma.paperTrade.create({
          data: {
            signalId: savedSignal.id,
            marketId: market.id,
            platform: orderbook.platform,
            strategy: signal.strategy,
            executionDelaySeconds: config.paperExecutionDelaySeconds,
            targetExecutionTime: new Date(signal.detectedAt.getTime() + config.paperExecutionDelaySeconds * 1000),
            status: "pending",
            expectedNetEdge: signal.netEdge,
            yesAskAtSignal: readSignalNumber(signal.rawJson.yesAsk),
            noAskAtSignal: readSignalNumber(signal.rawJson.noAsk),
            feeEstimate: signal.estimatedFees,
            notes: "Pending paper trade: waiting for a snapshot at or after the simulated execution time."
          }
        });
        paperTradesCreated += 1;
      }
    }

    const relatedGroupResult = await processRelatedGroups(markets, latestCycleSnapshots, config);
    signalsCreated += relatedGroupResult.signalsCreated;
    paperTradesCreated += relatedGroupResult.paperTradesCreated;
    signals.push(...relatedGroupResult.signals);

    paperTradesCreated += await processPendingPaperTrades(config);
    const summary = summarizeValidationSample({
      marketsChecked: markets.length,
      snapshotsCollected: snapshotsStored,
      signals,
      paperTradesCreated,
      workerErrors: errors,
      validationFlags
    });

    await finishRunLog(log.id, errors.length > 0 ? "partial" : "success", {
      snapshotsStored,
      signalsCreated,
      paperTradesCreated,
      message: `Stored ${snapshotsStored} snapshots and ${signalsCreated} signals (${summary.signalsAccepted} accepted, ${summary.signalsRejected} rejected).`,
      error: errors.length > 0 ? errors.join("\n") : undefined,
      rawJson: toJson({
        signalsAccepted: summary.signalsAccepted,
        signalsRejected: summary.signalsRejected,
        signalsRejectedForEmptyOrderbook: summary.signalsRejectedForEmptyOrderbook,
        signalsRejectedForMissingLiquidity: summary.signalsRejectedForMissingLiquidity,
        signalsRejectedForLowEdge: summary.signalsRejectedForLowEdge,
        signalsRejectedForStaleSnapshot: summary.signalsRejectedForStaleSnapshot,
        snapshotsWithEmptyOrderbooks: summary.snapshotsWithEmptyOrderbooks
      })
    });
  } catch (error) {
    await finishRunLog(log.id, "error", {
      snapshotsStored,
      signalsCreated,
      paperTradesCreated,
      error: errorMessage(error)
    });
  } finally {
    orderbookCycleRunning = false;
  }
}

async function readMarketsForOrderbookCycle() {
  if (selectedMarketTickers.length === 0) {
    return prisma.market.findMany({
      where: { platform: "kalshi", status: "open" },
      orderBy: [{ closeTime: "asc" }, { updatedAt: "desc" }],
      take: config.maxMarkets
    });
  }

  const markets = await prisma.market.findMany({
    where: {
      platform: "kalshi",
      ticker: { in: selectedMarketTickers }
    }
  });
  const order = new Map(selectedMarketTickers.map((ticker, index) => [ticker, index]));
  return markets.sort((a, b) => (order.get(a.ticker) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.ticker) ?? Number.MAX_SAFE_INTEGER));
}

async function processRelatedGroups(
  markets: Awaited<ReturnType<typeof readMarketsForOrderbookCycle>>,
  latestCycleSnapshots: Map<
    string,
    {
      orderbook: NormalizedOrderbook;
      snapshotId: string;
      validationFlags: OrderbookValidationFlags;
    }
  >,
  workerConfig: WorkerConfig
): Promise<{ signalsCreated: number; paperTradesCreated: number; signals: SampleSignalInput[] }> {
  let signalsCreated = 0;
  let paperTradesCreated = 0;
  const sampleSignals: SampleSignalInput[] = [];
  const groups = groupKalshiRelatedMarkets(
    markets.map((market) => ({
      id: market.id,
      platform: "kalshi",
      ticker: market.ticker,
      eventTicker: market.eventTicker,
      title: market.title,
      resolutionRules: market.resolutionRules,
      status: market.status,
      closeTime: market.closeTime
    })),
    { includeMveMarkets: workerConfig.includeMveMarkets }
  );

  for (const group of groups) {
    const savedGroup = await upsertRelatedMarketGroup(group, markets, latestCycleSnapshots);
    const snapshots = group.markets.map((groupMarket) => {
      const dbMarket = markets.find((market) => market.id === groupMarket.id || market.ticker === groupMarket.ticker);
      const latest = dbMarket ? latestCycleSnapshots.get(dbMarket.id) : undefined;
      return {
        market: groupMarket,
        orderbook: latest?.orderbook ?? null,
        validationFlags: latest?.validationFlags
      };
    });
    const signal = detectMultiOutcomeArb(group, snapshots, workerConfig.detection);
    const representative = group.markets[0];
    const representativeDbMarket = markets.find((market) => market.id === representative.id || market.ticker === representative.ticker);
    if (!representativeDbMarket) {
      continue;
    }

    await prisma.relatedMarketGroup.update({
      where: { id: savedGroup.id },
      data: {
        latestSnapshotTime: signal.latestSnapshotTime,
        totalYesAskCost: signal.totalYesAskCost,
        grossEdge: signal.grossEdge,
        estimatedFees: signal.estimatedFees,
        netEdge: signal.netEdge,
        validationFlags: toJson(signal.validationFlags),
        rawJson: toJson({ ...group, latestSignal: signal.rawJson })
      }
    });

    const snapshotIds = group.markets.map((groupMarket) => {
      const dbMarket = markets.find((market) => market.id === groupMarket.id || market.ticker === groupMarket.ticker);
      return dbMarket ? latestCycleSnapshots.get(dbMarket.id)?.snapshotId ?? null : null;
    });
    const savedSignal = await prisma.signal.create({
      data: {
        marketId: representativeDbMarket.id,
        relatedGroupId: savedGroup.id,
        platform: group.platform,
        strategy: signal.strategy,
        detectedAt: signal.detectedAt,
        grossEdge: signal.grossEdge,
        estimatedFees: signal.estimatedFees,
        netEdge: signal.netEdge,
        maxContracts: signal.maxContracts,
        confidenceScore: signal.confidenceScore,
        liquidityScore: signal.liquidityScore,
        status: signal.status,
        reason: signal.reason,
        rawJson: toJson({ ...signal.rawJson, relatedGroupId: savedGroup.id, snapshotIds })
      }
    });
    signalsCreated += 1;
    sampleSignals.push({ status: signal.status, reason: signal.reason, validationFlags: signal.validationFlags });

    if (shouldCreatePaperTrade(signal, signal.validationFlags)) {
      const legs = readSignalLegs(signal.rawJson.legs);
      await prisma.paperTrade.create({
        data: {
          signalId: savedSignal.id,
          marketId: representativeDbMarket.id,
          relatedGroupId: savedGroup.id,
          platform: group.platform,
          strategy: signal.strategy,
          executionDelaySeconds: workerConfig.paperExecutionDelaySeconds,
          targetExecutionTime: new Date(signal.detectedAt.getTime() + workerConfig.paperExecutionDelaySeconds * 1000),
          status: "pending",
          expectedNetEdge: signal.netEdge,
          yesAskAtSignal: legs[0]?.yesAsk ?? null,
          noAskAtSignal: legs[1]?.yesAsk ?? null,
          feeEstimate: signal.estimatedFees,
          notes: "Pending grouped paper trade: waiting for snapshots at or after the simulated execution time for every outcome."
        }
      });
      paperTradesCreated += 1;
    }
  }

  return { signalsCreated, paperTradesCreated, signals: sampleSignals };
}

async function processPendingPaperTrades(workerConfig: WorkerConfig): Promise<number> {
  const pendingTrades = await prisma.paperTrade.findMany({
    where: { status: "pending" },
    include: {
      signal: true,
      market: true,
      relatedGroup: {
        include: {
          markets: {
            orderBy: { sortOrder: "asc" },
            include: { market: true }
          }
        }
      }
    },
    take: 50,
    orderBy: { createdAt: "asc" }
  });

  let processed = 0;

  for (const trade of pendingTrades) {
    const executionTime = new Date(trade.signal.detectedAt.getTime() + trade.executionDelaySeconds * 1000);
    if (executionTime > new Date()) {
      continue;
    }

    if (trade.strategy === "multi_outcome_arb") {
      processed += await processPendingGroupedPaperTrade(trade, executionTime, workerConfig);
      continue;
    }

    const snapshots = await prisma.orderbookSnapshot.findMany({
      where: {
        marketId: trade.marketId,
        capturedAt: { gte: executionTime }
      },
      orderBy: { capturedAt: "asc" },
      take: 5
    });

    if (snapshots.length === 0) {
      await prisma.paperTrade.update({
        where: { id: trade.id },
        data: {
          notes: "Pending paper trade: waiting for the first snapshot at or after the simulated execution time."
        }
      });
      continue;
    }

    const normalized = snapshots.map((snapshot) => snapshotToOrderbook(snapshot, trade.market.ticker));
    const simulation = simulateComplementPaperTrade(
      {
        detectedAt: trade.signal.detectedAt,
        expectedNetEdge: decimalToNumber(trade.expectedNetEdge),
        maxContracts: decimalToNumber(trade.signal.maxContracts),
        yesAskAtSignal: readSignalNumber(readJsonRecord(trade.signal.rawJson)?.yesAsk),
        noAskAtSignal: readSignalNumber(readJsonRecord(trade.signal.rawJson)?.noAsk)
      },
      normalized,
      {
        executionDelaySeconds: trade.executionDelaySeconds,
        feeSettings: workerConfig.detection.feeSettings
      }
    );

    await prisma.$transaction([
      prisma.paperFill.deleteMany({ where: { paperTradeId: trade.id } }),
      prisma.paperTrade.update({
        where: { id: trade.id },
        data: {
          status: simulation.status,
          actualSnapshotExecutionTime: simulation.actualSnapshotExecutionTime,
          realizedNetEdge: simulation.realizedNetEdge,
          yesFillAveragePrice: simulation.yesFillAveragePrice,
          noFillAveragePrice: simulation.noFillAveragePrice,
          yesContractsFilled: simulation.yesContractsFilled,
          noContractsFilled: simulation.noContractsFilled,
          pairedContracts: simulation.pairedContracts,
          unpairedContractsDiscarded: simulation.unpairedContractsDiscarded,
          feeEstimate: simulation.feeEstimate,
          failureReason: simulation.failureReason,
          notes: simulation.notes
        }
      }),
      ...(simulation.fills.length > 0
        ? [
            prisma.paperFill.createMany({
              data: simulation.fills.map((fill) => ({
                paperTradeId: trade.id,
                side: fill.side,
                outcome: fill.outcome,
                price: fill.price,
                contracts: fill.contracts,
                fees: fill.fees,
                filledAt: fill.filledAt
              }))
            })
          ]
        : [])
    ]);
    processed += 1;
  }

  return processed;
}

async function processPendingGroupedPaperTrade(
  trade: {
    id: string;
    signal: { detectedAt: Date; maxContracts: Prisma.Decimal; rawJson: Prisma.JsonValue };
    relatedGroup?: {
      markets: Array<{
        marketId: string;
        marketTicker: string;
      }>;
    } | null;
    expectedNetEdge: Prisma.Decimal | null;
    executionDelaySeconds: number;
  },
  executionTime: Date,
  workerConfig: WorkerConfig
): Promise<number> {
  const groupMarkets = trade.relatedGroup?.markets ?? [];
  if (groupMarkets.length === 0) {
    await prisma.paperTrade.update({
      where: { id: trade.id },
      data: {
        status: "failed",
        failureReason: "Related market group is missing.",
        notes: "Failed grouped paper trade: related market group is missing."
      }
    });
    return 1;
  }

  const legs = [];
  const signalLegs = readSignalLegs(readJsonRecord(trade.signal.rawJson)?.legs);
  for (const groupMarket of groupMarkets) {
    const snapshots = await prisma.orderbookSnapshot.findMany({
      where: {
        marketId: groupMarket.marketId,
        capturedAt: { gte: executionTime }
      },
      orderBy: { capturedAt: "asc" },
      take: 5
    });
    legs.push({
      marketId: groupMarket.marketId,
      marketTicker: groupMarket.marketTicker,
      yesAskAtSignal: signalLegs.find((leg) => leg.marketTicker === groupMarket.marketTicker)?.yesAsk ?? null,
      snapshots: snapshots.map((snapshot) => snapshotToOrderbook(snapshot, groupMarket.marketTicker))
    });
  }

  if (legs.some((leg) => leg.snapshots.length === 0)) {
    await prisma.paperTrade.update({
      where: { id: trade.id },
      data: {
        notes: "Pending grouped paper trade: waiting for the first snapshot at or after the simulated execution time for every outcome."
      }
    });
    return 0;
  }

  const simulation = simulateMultiOutcomePaperTrade(
    {
      detectedAt: trade.signal.detectedAt,
      expectedNetEdge: decimalToNumber(trade.expectedNetEdge),
      maxContracts: decimalToNumber(trade.signal.maxContracts),
      legs
    },
    {
      executionDelaySeconds: trade.executionDelaySeconds,
      feeSettings: workerConfig.detection.feeSettings
    }
  );

  await prisma.$transaction([
    prisma.paperFill.deleteMany({ where: { paperTradeId: trade.id } }),
    prisma.paperTrade.update({
      where: { id: trade.id },
      data: {
        status: simulation.status,
        actualSnapshotExecutionTime: simulation.actualSnapshotExecutionTime,
        realizedNetEdge: simulation.realizedNetEdge,
        yesFillAveragePrice: simulation.yesFillAveragePrice,
        noFillAveragePrice: simulation.noFillAveragePrice,
        yesContractsFilled: simulation.yesContractsFilled,
        noContractsFilled: simulation.noContractsFilled,
        pairedContracts: simulation.pairedContracts,
        unpairedContractsDiscarded: simulation.unpairedContractsDiscarded,
        feeEstimate: simulation.feeEstimate,
        failureReason: simulation.failureReason,
        notes: simulation.notes
      }
    }),
    ...(simulation.fills.length > 0
      ? [
          prisma.paperFill.createMany({
            data: simulation.fills.map((fill) => ({
              paperTradeId: trade.id,
              marketId: fill.marketId,
              marketTicker: fill.marketTicker,
              legRole: fill.legRole,
              side: fill.side,
              outcome: fill.outcome,
              price: fill.price,
              contracts: fill.contracts,
              fees: fill.fees,
              filledAt: fill.filledAt
            }))
          })
        ]
      : [])
  ]);

  return 1;
}

async function upsertMarket(market: KalshiMarket): Promise<void> {
  const resolutionRules = [market.rules_primary, market.rules_secondary].filter(Boolean).join("\n\n") || null;

  await prisma.market.upsert({
    where: {
      platform_externalMarketId: {
        platform: "kalshi",
        externalMarketId: market.ticker
      }
    },
    create: {
      platform: "kalshi",
      externalMarketId: market.ticker,
      ticker: market.ticker,
      eventTicker: readOptionalString(market.event_ticker),
      title: market.title ?? market.subtitle ?? market.ticker,
      description: market.subtitle ?? null,
      resolutionRules,
      category: typeof market.category === "string" ? market.category : null,
      status: market.status ?? "open",
      closeTime: parseDate(market.close_time)
    },
    update: {
      ticker: market.ticker,
      eventTicker: readOptionalString(market.event_ticker),
      title: market.title ?? market.subtitle ?? market.ticker,
      description: market.subtitle ?? null,
      resolutionRules,
      category: typeof market.category === "string" ? market.category : null,
      status: market.status ?? "open",
      closeTime: parseDate(market.close_time)
    }
  });
}

async function upsertRelatedMarketGroup(
  group: RelatedMarketGroup,
  markets: Awaited<ReturnType<typeof readMarketsForOrderbookCycle>>,
  latestCycleSnapshots: Map<
    string,
    {
      orderbook: NormalizedOrderbook;
      snapshotId: string;
      validationFlags: OrderbookValidationFlags;
    }
  >
): Promise<{ id: string }> {
  const savedGroup = await prisma.relatedMarketGroup.upsert({
    where: {
      platform_groupKey: {
        platform: group.platform,
        groupKey: group.groupKey
      }
    },
    create: {
      groupKey: group.groupKey,
      platform: group.platform,
      eventTicker: group.eventTicker,
      marketCount: group.markets.length,
      marketTickers: toJson(group.marketTickers),
      marketTitles: toJson(group.marketTitles),
      closeTimes: toJson(group.closeTimes.map((closeTime) => closeTime?.toISOString() ?? null)),
      closeTimeSpreadSeconds: group.closeTimeSpreadSeconds,
      groupingReason: group.groupingReason,
      confidenceScore: group.confidenceScore,
      eligible: group.eligible,
      eligibilityReason: group.eligibilityReason,
      warnings: toJson(group.warnings),
      rawJson: toJson(group)
    },
    update: {
      eventTicker: group.eventTicker,
      marketCount: group.markets.length,
      marketTickers: toJson(group.marketTickers),
      marketTitles: toJson(group.marketTitles),
      closeTimes: toJson(group.closeTimes.map((closeTime) => closeTime?.toISOString() ?? null)),
      closeTimeSpreadSeconds: group.closeTimeSpreadSeconds,
      groupingReason: group.groupingReason,
      confidenceScore: group.confidenceScore,
      eligible: group.eligible,
      eligibilityReason: group.eligibilityReason,
      warnings: toJson(group.warnings),
      rawJson: toJson(group)
    },
    select: { id: true }
  });

  const dbMarkets = await prisma.market.findMany({
    where: {
      platform: group.platform,
      ticker: { in: group.marketTickers }
    },
    select: { id: true, ticker: true }
  });
  const marketIdByTicker = new Map(dbMarkets.map((market) => [market.ticker, market.id]));
  const dbMarketByTicker = new Map(markets.map((market) => [market.ticker, market]));

  await prisma.$transaction([
    prisma.relatedMarketGroupMarket.deleteMany({ where: { relatedGroupId: savedGroup.id } }),
    prisma.relatedMarketGroupMarket.createMany({
      data: group.marketTickers.flatMap((ticker, index) => {
        const marketId = marketIdByTicker.get(ticker);
        const market = dbMarketByTicker.get(ticker);
        const latest = market ? latestCycleSnapshots.get(market.id)?.orderbook : undefined;
        return marketId
          ? [
              {
                relatedGroupId: savedGroup.id,
                marketId,
                platform: group.platform,
                marketTicker: ticker,
                title: market?.title ?? group.marketTitles[index] ?? null,
                yesAsk: latest?.bestYesAsk ?? null,
                yesBid: latest?.bestYesBid ?? null,
                noAsk: latest?.bestNoAsk ?? null,
                noBid: latest?.bestNoBid ?? null,
                closeTime: market?.closeTime ?? group.closeTimes[index] ?? null,
                sortOrder: index
              }
            ]
          : [];
      })
    })
  ]);

  return savedGroup;
}

function snapshotToOrderbook(
  snapshot: {
    platform: string;
    capturedAt: Date;
    bestYesBid: Prisma.Decimal | null;
    bestYesAsk: Prisma.Decimal | null;
    bestNoBid: Prisma.Decimal | null;
    bestNoAsk: Prisma.Decimal | null;
    spread: Prisma.Decimal | null;
    rawJson: Prisma.JsonValue;
  },
  marketTicker: string
): NormalizedOrderbook {
  const raw = snapshot.rawJson && typeof snapshot.rawJson === "object" ? (snapshot.rawJson as Record<string, unknown>) : {};
  const normalized = raw.normalized && typeof raw.normalized === "object" ? (raw.normalized as Record<string, unknown>) : {};

  return {
    platform: "kalshi",
    marketTicker,
    capturedAt: snapshot.capturedAt,
    bestYesBid: decimalToNullableNumber(snapshot.bestYesBid),
    bestYesAsk: decimalToNullableNumber(snapshot.bestYesAsk),
    bestNoBid: decimalToNullableNumber(snapshot.bestNoBid),
    bestNoAsk: decimalToNullableNumber(snapshot.bestNoAsk),
    spread: decimalToNullableNumber(snapshot.spread),
    yesBids: readLevels(normalized.yesBids),
    noBids: readLevels(normalized.noBids),
    yesAsks: readLevels(normalized.yesAsks),
    noAsks: readLevels(normalized.noAsks),
    rawJson: raw.provider ?? raw
  };
}

function readLevels(value: unknown): PriceLevel[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((level) => {
      if (!level || typeof level !== "object") {
        return null;
      }
      const record = level as Record<string, unknown>;
      const price = Number(record.price);
      const contracts = Number(record.contracts);
      return Number.isFinite(price) && Number.isFinite(contracts) ? { price, contracts } : null;
    })
    .filter((level): level is PriceLevel => Boolean(level));
}

async function createRunLog(runType: string): Promise<{ id: string }> {
  return prisma.runLog.create({
    data: {
      runType,
      status: "running"
    },
    select: { id: true }
  });
}

async function finishRunLog(
  id: string,
  status: string,
  data: {
    marketsFetched?: number;
    snapshotsStored?: number;
    signalsCreated?: number;
    paperTradesCreated?: number;
    message?: string;
    error?: string;
    rawJson?: Prisma.InputJsonValue;
  }
): Promise<void> {
  await prisma.runLog.update({
    where: { id },
    data: {
      status,
      finishedAt: new Date(),
      marketsFetched: data.marketsFetched,
      snapshotsStored: data.snapshotsStored,
      signalsCreated: data.signalsCreated,
      paperTradesCreated: data.paperTradesCreated,
      message: data.message,
      error: data.error,
      rawJson: data.rawJson
    }
  });
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function decimalToNullableNumber(value: Prisma.Decimal | null): number | null {
  return value === null ? null : value.toNumber();
}

function decimalToNumber(value: Prisma.Decimal | null): number {
  return value === null ? 0 : value.toNumber();
}

function readJsonRecord(value: Prisma.JsonValue): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readSignalNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readSignalLegs(value: unknown): Array<{ marketTicker: string; yesAsk: number | null }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const marketTicker = typeof record.marketTicker === "string" ? record.marketTicker : null;
    if (!marketTicker) {
      return [];
    }
    return [{ marketTicker, yesAsk: readSignalNumber(record.yesAsk) }];
  });
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

process.on("SIGINT", () => {
  void prisma.$disconnect().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void prisma.$disconnect().finally(() => process.exit(0));
});

main().catch((error) => {
  console.error(error);
  void prisma.$disconnect().finally(() => process.exit(1));
});
