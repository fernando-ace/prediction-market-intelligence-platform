import "./env";

import {
  KalshiReadOnlyAdapter,
  detectBinaryComplementArb,
  detectMultiOutcomeArb,
  groupKalshiRelatedMarkets,
  selectActiveKalshiMarkets,
  summarizeKalshiCandidateMarkets,
  summarizeValidationSample,
  validateOrderbookSnapshot,
  type KalshiMarket,
  type NormalizedOrderbook,
  type OrderbookValidationFlags,
  type RelatedMarketGroup,
  type SampleSignalInput,
  type SelectedKalshiMarket
} from "@prediction-market-scanner/core";
import { Prisma, prisma } from "@prediction-market-scanner/db";
import { loadWorkerConfig } from "./config";
import { marketCandidateLimit, shouldCreatePaperTrade } from "./signals";

const config = loadWorkerConfig();
const adapter = new KalshiReadOnlyAdapter({ baseUrl: config.kalshiBaseUrl });

async function main(): Promise<void> {
  const maxMarkets = readNumber("MAX_MARKETS", 5);
  const durationSeconds = readNumber("SAMPLE_DURATION_SECONDS", 30);
  const pollIntervalSeconds = readNumber("SAMPLE_POLL_INTERVAL_SECONDS", 5);
  const startedAt = Date.now();
  const errors: string[] = [];
  const validationFlags: Array<Record<string, boolean>> = [];
  const signals: SampleSignalInput[] = [];
  const latestEmptyOrderbookByTicker = new Map<string, boolean>();
  const latestCycleSnapshots = new Map<
    string,
    {
      orderbook: NormalizedOrderbook;
      snapshotId: string;
      validationFlags: OrderbookValidationFlags;
    }
  >();
  let snapshotsCollected = 0;
  let paperTradesCreated = 0;

  const candidateLimit = marketCandidateLimit(maxMarkets, config.kalshiCandidateMarketLimit);
  const marketResult = await adapter.fetchOpenMarkets(candidateLimit, { includeMveMarkets: config.includeMveMarkets });
  if (!marketResult.ok || !marketResult.data) {
    throw new Error(marketResult.error ?? "Unable to fetch Kalshi markets.");
  }

  const candidateStats = summarizeKalshiCandidateMarkets(marketResult.data, {
    includeMveMarkets: config.includeMveMarkets
  });
  const selectedMarkets = selectActiveKalshiMarkets(marketResult.data, maxMarkets, {
    includeMveMarkets: config.includeMveMarkets
  });
  const markets = selectedMarkets.map((selected) => selected.market);
  for (const market of markets) {
    await upsertMarket(market);
  }

  while (Date.now() - startedAt < durationSeconds * 1000) {
    for (const market of markets) {
      const dbMarket = await prisma.market.findUnique({
        where: {
          platform_externalMarketId: {
            platform: "kalshi",
            externalMarketId: market.ticker
          }
        }
      });

      if (!dbMarket) {
        continue;
      }

      const orderbookResult = await adapter.fetchOrderbook(market.ticker);
      if (!orderbookResult.ok || !orderbookResult.data) {
        errors.push(orderbookResult.error ?? `Unknown orderbook error for ${market.ticker}`);
        continue;
      }

      const orderbook = orderbookResult.data;
      const validation = validateOrderbookSnapshot(orderbook, {
        minLiquidityContracts: config.detection.minLiquidityContracts
      });
      validationFlags.push(validation.flags);
      latestEmptyOrderbookByTicker.set(market.ticker, validation.flags.empty_orderbook);

      const snapshot = await prisma.orderbookSnapshot.create({
        data: {
          marketId: dbMarket.id,
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
      snapshotsCollected += 1;
      latestCycleSnapshots.set(dbMarket.id, {
        orderbook,
        snapshotId: snapshot.id,
        validationFlags: validation.flags
      });

      const signal = detectBinaryComplementArb(
        orderbook,
        { status: dbMarket.status, closeTime: dbMarket.closeTime },
        config.detection
      );

      const savedSignal = await prisma.signal.create({
        data: {
          marketId: dbMarket.id,
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
      signals.push({ status: signal.status, reason: signal.reason, validationFlags: validation.flags });

      if (shouldCreatePaperTrade(signal, validation.flags)) {
        await prisma.paperTrade.create({
          data: {
            signalId: savedSignal.id,
            marketId: dbMarket.id,
            platform: orderbook.platform,
            strategy: signal.strategy,
            executionDelaySeconds: config.paperExecutionDelaySeconds,
            targetExecutionTime: new Date(signal.detectedAt.getTime() + config.paperExecutionDelaySeconds * 1000),
            status: "pending",
            expectedNetEdge: signal.netEdge,
            yesAskAtSignal: Number(signal.rawJson.yesAsk),
            noAskAtSignal: Number(signal.rawJson.noAsk),
            feeEstimate: signal.estimatedFees,
            notes: "Pending paper trade: waiting for a snapshot at or after the simulated execution time."
          }
        });
        paperTradesCreated += 1;
      }
    }

    if (Date.now() - startedAt >= durationSeconds * 1000) {
      break;
    }
    await sleep(pollIntervalSeconds * 1000);
  }

  const dbMarkets = await prisma.market.findMany({
    where: {
      platform: "kalshi",
      ticker: { in: markets.map((market) => market.ticker) }
    }
  });
  const relatedSummary = await processRelatedGroupsForSample(dbMarkets, latestCycleSnapshots);
  signals.push(...relatedSummary.signals);
  paperTradesCreated += relatedSummary.paperTradesCreated;

  const summary = summarizeValidationSample({
    marketsChecked: markets.length,
    snapshotsCollected,
    signals,
    paperTradesCreated,
    workerErrors: errors,
    validationFlags
  });

  printCandidateStats(candidateStats);
  printSelectedMarkets(selectedMarkets, latestEmptyOrderbookByTicker);
  console.log("Validation sample summary");
  console.log(`markets checked: ${summary.marketsChecked}`);
  console.log(`snapshots collected: ${summary.snapshotsCollected}`);
  console.log(`snapshots with missing YES bids: ${summary.snapshotsWithMissingYesBids}`);
  console.log(`snapshots with missing NO bids: ${summary.snapshotsWithMissingNoBids}`);
  console.log(`snapshots with empty orderbooks: ${summary.snapshotsWithEmptyOrderbooks}`);
  console.log(`snapshots with invalid prices: ${summary.snapshotsWithInvalidPrices}`);
  console.log(`signals created total: ${summary.signalsCreatedTotal}`);
  console.log(`signals accepted: ${summary.signalsAccepted}`);
  console.log(`signals rejected: ${summary.signalsRejected}`);
  console.log(`signals rejected because empty orderbook: ${summary.signalsRejectedForEmptyOrderbook}`);
  console.log(`signals rejected because missing liquidity: ${summary.signalsRejectedForMissingLiquidity}`);
  console.log(`signals rejected because low edge: ${summary.signalsRejectedForLowEdge}`);
  console.log(`signals rejected for stale snapshot: ${summary.signalsRejectedForStaleSnapshot}`);
  console.log(`paper trades created: ${summary.paperTradesCreated}`);
  console.log(`worker errors: ${summary.workerErrors}`);
  for (const error of summary.workerErrorMessages) {
    console.log(`- ${error}`);
  }
  printRelatedGroupSummary(relatedSummary);
}

async function processRelatedGroupsForSample(
  dbMarkets: Array<{
    id: string;
    platform: string;
    ticker: string;
    eventTicker: string | null;
    title: string;
    resolutionRules: string | null;
    status: string;
    closeTime: Date | null;
  }>,
  latestCycleSnapshots: Map<
    string,
    {
      orderbook: NormalizedOrderbook;
      snapshotId: string;
      validationFlags: OrderbookValidationFlags;
    }
  >
): Promise<{
  groupsFound: number;
  eligibleGroups: number;
  ineligibleGroups: number;
  signalsCreated: number;
  accepted: number;
  rejected: number;
  paperTradesCreated: number;
  signals: SampleSignalInput[];
  evaluatedGroups: Array<{
    groupKey: string;
    tickers: string[];
    titles: string[];
    totalYesAskCost: number | null;
    grossEdge: number | null;
    estimatedFees: number;
    netEdge: number | null;
    eligibilityReason: string;
    rejectionReason: string;
    eligible: boolean;
  }>;
}> {
  let signalsCreated = 0;
  let accepted = 0;
  let rejected = 0;
  let paperTradesCreated = 0;
  const sampleSignals: SampleSignalInput[] = [];
  const evaluatedGroups = [];
  const groups = groupKalshiRelatedMarkets(
    dbMarkets.map((market) => ({
      id: market.id,
      platform: "kalshi",
      ticker: market.ticker,
      eventTicker: market.eventTicker,
      title: market.title,
      resolutionRules: market.resolutionRules,
      status: market.status,
      closeTime: market.closeTime
    })),
    { includeMveMarkets: config.includeMveMarkets }
  );

  for (const group of groups) {
    const savedGroup = await upsertRelatedMarketGroup(group, dbMarkets, latestCycleSnapshots);
    const snapshots = group.markets.map((groupMarket) => {
      const dbMarket = dbMarkets.find((market) => market.id === groupMarket.id || market.ticker === groupMarket.ticker);
      const latest = dbMarket ? latestCycleSnapshots.get(dbMarket.id) : undefined;
      return {
        market: groupMarket,
        orderbook: latest?.orderbook ?? null,
        validationFlags: latest?.validationFlags
      };
    });
    const signal = detectMultiOutcomeArb(group, snapshots, config.detection);
    const representative = group.markets[0];
    const representativeDbMarket = dbMarkets.find((market) => market.id === representative.id || market.ticker === representative.ticker);
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
      const dbMarket = dbMarkets.find((market) => market.id === groupMarket.id || market.ticker === groupMarket.ticker);
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
    void savedSignal;
    signalsCreated += 1;
    accepted += signal.status === "accepted" ? 1 : 0;
    rejected += signal.status === "rejected" ? 1 : 0;
    sampleSignals.push({ status: signal.status, reason: signal.reason, validationFlags: signal.validationFlags });
    evaluatedGroups.push({
      groupKey: group.groupKey,
      tickers: group.marketTickers,
      titles: group.marketTitles,
      totalYesAskCost: signal.totalYesAskCost,
      grossEdge: signal.grossEdge,
      estimatedFees: signal.estimatedFees,
      netEdge: signal.netEdge,
      eligibilityReason: group.eligibilityReason,
      rejectionReason: signal.reason,
      eligible: group.eligible
    });
  }

  return {
    groupsFound: groups.length,
    eligibleGroups: groups.filter((group) => group.eligible).length,
    ineligibleGroups: groups.filter((group) => !group.eligible).length,
    signalsCreated,
    accepted,
    rejected,
    paperTradesCreated,
    signals: sampleSignals,
    evaluatedGroups
  };
}

async function upsertRelatedMarketGroup(
  group: RelatedMarketGroup,
  dbMarkets: Array<{ id: string; ticker: string; title: string; closeTime: Date | null }>,
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
  const dbMarketByTicker = new Map(dbMarkets.map((market) => [market.ticker, market]));

  await prisma.$transaction([
    prisma.relatedMarketGroupMarket.deleteMany({ where: { relatedGroupId: savedGroup.id } }),
    prisma.relatedMarketGroupMarket.createMany({
      data: group.marketTickers.flatMap((ticker, index) => {
        const market = dbMarketByTicker.get(ticker);
        const latest = market ? latestCycleSnapshots.get(market.id)?.orderbook : undefined;
        return market
          ? [
              {
                relatedGroupId: savedGroup.id,
                marketId: market.id,
                platform: group.platform,
                marketTicker: ticker,
                title: market.title,
                yesAsk: latest?.bestYesAsk ?? null,
                yesBid: latest?.bestYesBid ?? null,
                noAsk: latest?.bestNoAsk ?? null,
                noBid: latest?.bestNoBid ?? null,
                closeTime: market.closeTime,
                sortOrder: index
              }
            ]
          : [];
      })
    })
  ]);

  return savedGroup;
}

function printRelatedGroupSummary(summary: Awaited<ReturnType<typeof processRelatedGroupsForSample>>): void {
  console.log("Related group summary");
  console.log(`related groups found: ${summary.groupsFound}`);
  console.log(`eligible related groups: ${summary.eligibleGroups}`);
  console.log(`ineligible related groups: ${summary.ineligibleGroups}`);
  console.log(`multi_outcome_arb signals created: ${summary.signalsCreated}`);
  console.log(`multi_outcome_arb accepted: ${summary.accepted}`);
  console.log(`multi_outcome_arb rejected: ${summary.rejected}`);
  console.log("top 10 eligible groups by lowest total YES ask cost");
  const topEligibleGroups = summary.evaluatedGroups
    .filter((entry) => entry.eligible && entry.totalYesAskCost !== null)
    .sort((a, b) => (a.totalYesAskCost ?? Number.POSITIVE_INFINITY) - (b.totalYesAskCost ?? Number.POSITIVE_INFINITY))
    .slice(0, 10);
  if (topEligibleGroups.length === 0) {
    console.log("- none");
  }
  for (const group of topEligibleGroups) {
    console.log(
      [
        `- groupKey: ${group.groupKey}`,
        `tickers: ${group.tickers.join(", ")}`,
        `titles: ${group.titles.join(" | ")}`,
        `totalYesAskCost: ${formatNumber(group.totalYesAskCost)}`,
        `grossEdge: ${formatNumber(group.grossEdge)}`,
        `estimatedFees: ${formatNumber(group.estimatedFees)}`,
        `netEdge: ${formatNumber(group.netEdge)}`,
        `eligibility reason: ${group.eligibilityReason}`,
        `rejection reason: ${group.rejectionReason}`
      ].join(" | ")
    );
  }
}

function printCandidateStats(stats: {
  candidateMarketsFetched: number;
  mveMarketsExcluded: number;
  marketsWithVisibleBidAsk: number;
  marketsWithPositiveLiquidity: number;
  marketsWithPositiveVolume24h: number;
  marketsWithPositiveOpenInterest: number;
}): void {
  console.log("Candidate market stats");
  console.log(`candidate markets fetched: ${stats.candidateMarketsFetched}`);
  console.log(`MVE markets excluded: ${stats.mveMarketsExcluded}`);
  console.log(`markets with visible bid/ask: ${stats.marketsWithVisibleBidAsk}`);
  console.log(`markets with positive liquidity: ${stats.marketsWithPositiveLiquidity}`);
  console.log(`markets with positive volume_24h: ${stats.marketsWithPositiveVolume24h}`);
  console.log(`markets with positive open_interest: ${stats.marketsWithPositiveOpenInterest}`);
}

function printSelectedMarkets(
  selectedMarkets: SelectedKalshiMarket[],
  latestEmptyOrderbookByTicker: Map<string, boolean>
): void {
  console.log("Selected markets");
  for (const selected of selectedMarkets) {
    const empty = latestEmptyOrderbookByTicker.has(selected.market.ticker)
      ? latestEmptyOrderbookByTicker.get(selected.market.ticker)
        ? "yes"
        : "no"
      : "unknown";
    console.log(
      [
        `- ticker: ${selected.market.ticker}`,
        `title: ${selected.market.title ?? selected.market.subtitle ?? selected.market.ticker}`,
        `status: ${selected.activity.status}`,
        `close: ${formatDate(selected.activity.closeTime)}`,
        `yes_bid_dollars: ${formatNumber(selected.activity.yesBidDollars)}`,
        `yes_ask_dollars: ${formatNumber(selected.activity.yesAskDollars)}`,
        `yes_bid_size_fp: ${formatNumber(selected.activity.yesBidSize)}`,
        `yes_ask_size_fp: ${formatNumber(selected.activity.yesAskSize)}`,
        `no_bid_dollars: ${formatNumber(selected.activity.noBidDollars)}`,
        `no_ask_dollars: ${formatNumber(selected.activity.noAskDollars)}`,
        `volume_fp: ${formatNumber(selected.activity.volume)}`,
        `volume_24h_fp: ${formatNumber(selected.activity.volume24h)}`,
        `liquidity_dollars: ${formatNumber(selected.activity.liquidity)}`,
        `open_interest_fp: ${formatNumber(selected.activity.openInterest)}`,
        `activity_score: ${selected.activity.activityScore}`,
        `empty: ${empty}`
      ].join(" | ")
    );
  }
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

function readNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function formatNumber(value: number | null): string {
  return value === null ? "N/A" : String(value);
}

function formatDate(value: Date | null): string {
  return value ? value.toISOString() : "N/A";
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
