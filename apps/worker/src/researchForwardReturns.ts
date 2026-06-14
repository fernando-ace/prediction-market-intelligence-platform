import "./env";

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildForwardReturnCoverageDiagnostics,
  bucketForwardReturnValue,
  calculateNearMissDistanceToThreshold,
  chooseEntryPrice,
  chooseExitPrice,
  classifyNearMissBucket,
  classifyForwardReturnMissingExit,
  classifyForwardReturnRejectionReason,
  computeForwardReturn,
  filterForwardReturnSignalsByStatusAndReason,
  signalDetectedAtCutoffForMinimumAge,
  summarizeForwardReturnsByBucket,
  summarizeForwardReturnSignalSelection,
  summarizeMissingExitReasons,
  summarizeForwardReturns,
  type ForwardReturnBucketDimension,
  type ForwardReturnCoverageDiagnostics,
  type ForwardReturnCoverageSignalInput,
  type ForwardReturnMissingExitReasonSummaryRow,
  type ForwardReturnOrder,
  type ForwardReturnRejectionReasonSummaryRow,
  type ForwardReturnResearchRow,
  type ForwardReturnSignalSelectionSummary,
  type ForwardReturnSignalStatusFilter,
  type ForwardReturnSnapshotInput,
  type ForwardReturnWindow
} from "@prediction-market-scanner/core";
import { Prisma, prisma } from "@prediction-market-scanner/db";
import { loadWorkerConfig } from "./config";

const DEFAULT_LIMIT = 200;
const DEFAULT_LOOKBACK_HOURS = 720;
const DEFAULT_ORDER: ForwardReturnOrder = "oldest";
const WINDOWS: ForwardReturnWindow[] = ["15m", "30m", "60m", "240m"];
const WINDOW_MINUTES: Record<ForwardReturnWindow, number> = {
  "15m": 15,
  "30m": 30,
  "60m": 60,
  "240m": 240
};
const DEFAULT_MIN_AGE_MINUTES = Math.min(...Object.values(WINDOW_MINUTES));

type PersistedSignal = Prisma.SignalGetPayload<{ include: ReturnType<typeof signalInclude> }>;
type PersistedSnapshot = Awaited<ReturnType<typeof readFirstSnapshotAtOrAfter>>;

interface ForwardReturnsOptions {
  limit: number;
  lookbackHours: number;
  minAgeMinutes: number;
  order: ForwardReturnOrder;
  status: ForwardReturnSignalStatusFilter;
  rejectionReason: string | null;
  bucketBy: ForwardReturnBucketDimension | null;
}

interface NearMissDiagnostics {
  thresholdSource: string;
  minNetEdge: number;
  sourceKind: "production config" | "fallback";
  usableNetEdgeSignals: number;
  selectedLowEdgeSignals: number;
}

interface MarketRef {
  marketId: string;
  ticker: string;
}

class ForwardReturnsOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForwardReturnsOptionsError";
  }
}

async function main(): Promise<void> {
  const options = parseForwardReturnsOptions();
  const nearMissThreshold = loadNearMissMinNetEdgeThreshold();
  const since = new Date(Date.now() - options.lookbackHours * 60 * 60 * 1000);
  const newestSnapshotAt = await readNewestSnapshotAt();
  const signalDetectedAtCutoff = signalDetectedAtCutoffForMinimumAge(newestSnapshotAt ?? new Date(), options.minAgeMinutes);
  const signals = await readResearchSignals({
    since,
    signalDetectedAtCutoff,
    limit: options.limit,
    order: options.order,
    status: options.status,
    rejectionReason: options.rejectionReason
  });
  const { rows, coverageSignals } = await buildForwardReturnRows(signals, newestSnapshotAt, nearMissThreshold.minNetEdge);
  const coverageDiagnostics = buildForwardReturnCoverageDiagnostics({
    signals: coverageSignals,
    newestSnapshotAt,
    windows: WINDOWS.map((window) => ({ window, minutes: WINDOW_MINUTES[window] }))
  });
  const signalSelectionSummary = summarizeForwardReturnSignalSelection(signals);

  console.log(
    formatForwardReturnReport({
      options,
      signalDetectedAtCutoff,
      signalsEvaluated: signals.length,
      signalSelectionSummary,
      coverageDiagnostics,
      nearMissDiagnostics: options.bucketBy === "nearMiss" ? buildNearMissDiagnostics(signals, nearMissThreshold) : null,
      missingExitReasons: summarizeMissingExitReasons(rows),
      rows
    })
  );
}

async function readResearchSignals(args: {
  since: Date;
  signalDetectedAtCutoff: Date;
  limit: number;
  order: ForwardReturnOrder;
  status: ForwardReturnSignalStatusFilter;
  rejectionReason: string | null;
}) {
  const baseWhere = {
    detectedAt: {
      gte: args.since,
      lte: args.signalDetectedAtCutoff
    },
    ...(args.status === "all" ? {} : { status: args.status })
  } satisfies Prisma.SignalWhereInput;

  if (!args.rejectionReason) {
    return prisma.signal.findMany({
      where: baseWhere,
      orderBy: signalOrderBy(args.order),
      take: args.limit,
      include: signalInclude()
    });
  }

  const selected: PersistedSignal[] = [];
  const batchSize = Math.max(args.limit * 5, 500);
  let cursor: { id: string } | undefined;

  while (selected.length < args.limit) {
    const batch = await prisma.signal.findMany({
      where: baseWhere,
      orderBy: signalOrderBy(args.order),
      take: batchSize,
      ...(cursor ? { cursor, skip: 1 } : {}),
      include: signalInclude()
    });

    if (batch.length === 0) {
      break;
    }

    selected.push(
      ...filterForwardReturnSignalsByStatusAndReason(batch, {
        status: "all",
        rejectionReason: args.rejectionReason
      })
    );
    cursor = { id: batch[batch.length - 1].id };
  }

  return selected.slice(0, args.limit);
}

function signalOrderBy(order: ForwardReturnOrder): Prisma.SignalOrderByWithRelationInput[] {
  const direction = order === "oldest" ? "asc" : "desc";
  return [{ detectedAt: direction }, { id: direction }];
}

function signalInclude() {
  return {
    market: {
      select: {
        id: true,
        ticker: true,
        title: true,
        category: true
      }
    },
    relatedGroup: {
      include: {
        markets: {
          orderBy: {
            sortOrder: "asc"
          },
          select: {
            marketId: true,
            marketTicker: true,
            title: true
          }
        }
      }
    }
  } satisfies Prisma.SignalInclude;
}

async function buildForwardReturnRows(
  signals: PersistedSignal[],
  newestSnapshotAt: Date | null,
  nearMissMinNetEdge: number
): Promise<{ rows: ForwardReturnResearchRow[]; coverageSignals: ForwardReturnCoverageSignalInput[] }> {
  const rows: ForwardReturnResearchRow[] = [];
  const coverageSignals: ForwardReturnCoverageSignalInput[] = [];

  for (const signal of signals) {
    const marketRefs = marketRefsForSignal(signal);
    const signalInput = toForwardReturnSignalInput(signal);
    const entrySnapshots = await readEntrySnapshots(signal, marketRefs);
    const entryPrice = chooseEntryPrice(signalInput, oneOrMany(entrySnapshots));
    const bucketLabels = buildBucketLabels(signal, entryPrice, entrySnapshots, nearMissMinNetEdge);
    const hasAnyFutureSnapshot = await hasAnyLaterSnapshot(marketRefs, signal.detectedAt);

    coverageSignals.push({
      signalId: signal.id,
      detectedAt: signal.detectedAt,
      marketRefs,
      hasLaterSnapshot: hasAnyFutureSnapshot
    });

    for (const window of WINDOWS) {
      const targetTime = new Date(signal.detectedAt.getTime() + WINDOW_MINUTES[window] * 60 * 1000);
      const exitSnapshots = await readExitSnapshots(marketRefs, targetTime);
      const exitPrice = chooseExitPrice(signalInput, oneOrMany(exitSnapshots));
      const calculation = computeForwardReturn(entryPrice, exitPrice);
      const hasSnapshotAtOrAfterWindow = marketRefs.length > 0 && exitSnapshots.length === marketRefs.length;

      rows.push({
        signalId: signal.id,
        strategy: signal.strategy,
        window,
        entryPrice,
        exitPrice,
        missingEntry: entryPrice === null,
        missingExit: exitPrice === null,
        missingExitReason:
          exitPrice === null
            ? classifyForwardReturnMissingExit({
                signalDetectedAt: signal.detectedAt,
                targetTime,
                newestSnapshotAt,
                marketRefs,
                strategy: signal.strategy,
                hasAnyFutureSnapshot,
                hasSnapshotAtOrAfterWindow
              })
            : null,
        bucketLabels,
        ...calculation
      });
    }
  }

  return { rows, coverageSignals };
}

function marketRefsForSignal(signal: PersistedSignal): MarketRef[] {
  if (signal.strategy === "multi_outcome_arb" && signal.relatedGroup?.markets.length) {
    return signal.relatedGroup.markets.map((market) => ({
      marketId: market.marketId,
      ticker: market.marketTicker
    }));
  }

  return [{ marketId: signal.marketId, ticker: signal.market.ticker }];
}

async function readEntrySnapshots(signal: PersistedSignal, marketRefs: MarketRef[]): Promise<ForwardReturnSnapshotInput[]> {
  const snapshotIds = readSignalSnapshotIds(signal.rawJson);
  if (snapshotIds.length > 0) {
    const snapshots = await prisma.orderbookSnapshot.findMany({
      where: {
        id: {
          in: snapshotIds
        }
      },
      select: snapshotSelect()
    });
    const byId = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
    const ordered = snapshotIds.flatMap((id) => {
      const snapshot = byId.get(id);
      return snapshot ? [toForwardReturnSnapshot(snapshot)] : [];
    });
    if (ordered.length > 0) {
      return ordered;
    }
  }

  const snapshots: ForwardReturnSnapshotInput[] = [];
  for (const marketRef of marketRefs) {
    const snapshot = await readNearestSnapshotToSignalTime(marketRef.marketId, signal.detectedAt);
    if (!snapshot) {
      return [];
    }
    snapshots.push(toForwardReturnSnapshot(snapshot));
  }
  return snapshots;
}

async function readExitSnapshots(marketRefs: MarketRef[], targetTime: Date): Promise<ForwardReturnSnapshotInput[]> {
  const snapshots: ForwardReturnSnapshotInput[] = [];
  for (const marketRef of marketRefs) {
    const snapshot = await readFirstSnapshotAtOrAfter(marketRef.marketId, targetTime);
    if (!snapshot) {
      return [];
    }
    snapshots.push(toForwardReturnSnapshot(snapshot));
  }
  return snapshots;
}

async function hasAnyLaterSnapshot(marketRefs: MarketRef[], detectedAt: Date): Promise<boolean> {
  for (const marketRef of marketRefs) {
    const snapshot = await readFirstSnapshotAfter(marketRef.marketId, detectedAt);
    if (snapshot) {
      return true;
    }
  }
  return false;
}

async function readNearestSnapshotToSignalTime(marketId: string, detectedAt: Date): Promise<PersistedSnapshot> {
  const atOrBefore = await prisma.orderbookSnapshot.findFirst({
    where: {
      marketId,
      capturedAt: {
        lte: detectedAt
      }
    },
    orderBy: {
      capturedAt: "desc"
    },
    select: snapshotSelect()
  });

  if (atOrBefore) {
    return atOrBefore;
  }

  return prisma.orderbookSnapshot.findFirst({
    where: {
      marketId,
      capturedAt: {
        gte: detectedAt
      }
    },
    orderBy: {
      capturedAt: "asc"
    },
    select: snapshotSelect()
  });
}

function readFirstSnapshotAtOrAfter(marketId: string, targetTime: Date) {
  return prisma.orderbookSnapshot.findFirst({
    where: {
      marketId,
      capturedAt: {
        gte: targetTime
      }
    },
    orderBy: {
      capturedAt: "asc"
    },
    select: snapshotSelect()
  });
}

function readFirstSnapshotAfter(marketId: string, detectedAt: Date) {
  return prisma.orderbookSnapshot.findFirst({
    where: {
      marketId,
      capturedAt: {
        gt: detectedAt
      }
    },
    orderBy: {
      capturedAt: "asc"
    },
    select: {
      id: true
    }
  });
}

async function readNewestSnapshotAt(): Promise<Date | null> {
  const aggregate = await prisma.orderbookSnapshot.aggregate({
    _max: {
      capturedAt: true
    }
  });
  return aggregate._max.capturedAt;
}

function snapshotSelect() {
  return {
    id: true,
    capturedAt: true,
    bestYesBid: true,
    bestYesAsk: true,
    bestNoBid: true,
    bestNoAsk: true,
    spread: true
  } satisfies Prisma.OrderbookSnapshotSelect;
}

function toForwardReturnSignalInput(signal: PersistedSignal) {
  return {
    id: signal.id,
    strategy: signal.strategy,
    rawJson: signal.rawJson
  };
}

function toForwardReturnSnapshot(snapshot: NonNullable<PersistedSnapshot>): ForwardReturnSnapshotInput {
  return {
    capturedAt: snapshot.capturedAt,
    bestYesBid: snapshot.bestYesBid,
    bestYesAsk: snapshot.bestYesAsk,
    bestNoBid: snapshot.bestNoBid,
    bestNoAsk: snapshot.bestNoAsk,
    spread: snapshot.spread
  };
}

function buildBucketLabels(
  signal: PersistedSignal,
  entryPrice: number | null,
  entrySnapshots: ForwardReturnSnapshotInput[],
  nearMissMinNetEdge: number
): Partial<Record<ForwardReturnBucketDimension, string>> {
  const raw = readRecord(signal.rawJson);
  const spread = averageFinite(entrySnapshots.map((snapshot) => snapshot.spread));
  const reason = classifyForwardReturnRejectionReason(signal);
  const netEdge = firstFiniteNumber(signal.netEdge, raw?.netEdge);
  const nearMissDistance = calculateNearMissDistanceToThreshold(netEdge, nearMissMinNetEdge);

  return {
    entryCost: bucketForwardReturnValue("entryCost", entryPrice) ?? undefined,
    estimatedEdge: bucketForwardReturnValue("estimatedEdge", raw?.estimatedEdge ?? raw?.netEdge ?? signal.netEdge) ?? undefined,
    netEdge: bucketForwardReturnValue("netEdge", netEdge) ?? undefined,
    spread: bucketForwardReturnValue("spread", raw?.spread ?? spread) ?? undefined,
    strategy: bucketForwardReturnValue("strategy", signal.strategy) ?? undefined,
    reason: bucketForwardReturnValue("reason", reason ?? signal.reason) ?? undefined,
    nearMiss: classifyNearMissBucket(nearMissDistance) ?? undefined
  };
}

function oneOrMany(snapshots: ForwardReturnSnapshotInput[]): ForwardReturnSnapshotInput | ForwardReturnSnapshotInput[] | null {
  if (snapshots.length === 0) {
    return null;
  }
  return snapshots.length === 1 ? snapshots[0] : snapshots;
}

function readSignalSnapshotIds(rawJson: Prisma.JsonValue): string[] {
  const raw = readRecord(rawJson);
  const snapshotId = typeof raw?.snapshotId === "string" ? raw.snapshotId : null;
  const snapshotIds = Array.isArray(raw?.snapshotIds)
    ? raw.snapshotIds.filter((value): value is string => typeof value === "string")
    : [];
  return snapshotId ? [snapshotId, ...snapshotIds] : snapshotIds;
}

export function formatForwardReturnReport(input: {
  options: ForwardReturnsOptions;
  signalDetectedAtCutoff: Date;
  signalsEvaluated: number;
  signalSelectionSummary: ForwardReturnSignalSelectionSummary;
  coverageDiagnostics: ForwardReturnCoverageDiagnostics;
  nearMissDiagnostics?: NearMissDiagnostics | null;
  missingExitReasons: ForwardReturnMissingExitReasonSummaryRow[];
  rows: ForwardReturnResearchRow[];
}): string {
  const summary = summarizeForwardReturns(input.rows);
  const missingEntrySignals = new Set(input.rows.filter((row) => row.missingEntry).map((row) => row.signalId)).size;

  return [
    "Forward Return Research Report",
    `Lookback hours: ${input.options.lookbackHours}`,
    `Minimum signal age minutes: ${input.options.minAgeMinutes}`,
    `Signal detectedAt cutoff: ${formatDateTime(input.signalDetectedAtCutoff)}`,
    `Order: ${input.options.order}`,
    `Windows: ${WINDOWS.join(", ")}`,
    `Signals with missing entry price: ${missingEntrySignals}`,
    "",
    "Signal selection:",
    `Status: ${input.options.status}`,
    `Rejection reason: ${input.options.rejectionReason ?? "all"}`,
    ...(input.options.bucketBy ? [`Bucket by: ${input.options.bucketBy}`] : []),
    "Rejection reason source: persisted Signal.reason; grouped signals also use rawJson.rejectionCode when present",
    `Signals evaluated: ${input.signalsEvaluated}`,
    `Selected accepted count: ${input.signalSelectionSummary.acceptedCount}`,
    `Selected rejected count: ${input.signalSelectionSummary.rejectedCount}`,
    "Top rejection reasons:",
    formatTopRejectionReasons(input.signalSelectionSummary.topRejectionReasons),
    ...formatNearMissDiagnostics(input.nearMissDiagnostics),
    "",
    "Coverage diagnostics:",
    `Oldest selected signal timestamp: ${formatDateTime(input.coverageDiagnostics.oldestSelectedSignalAt)}`,
    `Newest selected signal timestamp: ${formatDateTime(input.coverageDiagnostics.newestSelectedSignalAt)}`,
    `Newest available snapshot timestamp: ${formatDateTime(input.coverageDiagnostics.newestAvailableSnapshotAt)}`,
    ...input.coverageDiagnostics.olderThanWindowCounts.map(
      (row) => `Selected signals older than ${row.window}: ${row.count}`
    ),
    `Selected signals with at least one later snapshot for same market/ticker: ${input.coverageDiagnostics.signalsWithLaterSnapshotCount}`,
    `Selected signals with no later snapshot for same market/ticker: ${input.coverageDiagnostics.signalsWithoutLaterSnapshotCount}`,
    `Selected signals missing market identifier: ${input.coverageDiagnostics.missingMarketIdentifierCount}`,
    "",
    "Missing exits by reason:",
    formatTable(
      ["window", "reason", "count"],
      input.missingExitReasons.map((row) => [row.window, row.reason, String(row.count)])
    ),
    "",
    "By strategy:",
    formatTable(
      ["strategy/type", "window", "count", "avgReturnAbs", "avgReturnPct", "winRate", "missingExitCount"],
      summary.byStrategy.map((row) => [
        row.strategy ?? "unknown",
        row.window,
        String(row.count),
        formatNumber(row.avgReturnAbs),
        formatPercent(row.avgReturnPct),
        formatPercent(row.winRate),
        String(row.missingExitCount)
      ])
    ),
    "",
    "Overall:",
    formatTable(
      ["window", "count", "avgReturnAbs", "avgReturnPct", "winRate", "missingExitCount"],
      summary.overall.map((row) => [
        row.window,
        String(row.count),
        formatNumber(row.avgReturnAbs),
        formatPercent(row.avgReturnPct),
        formatPercent(row.winRate),
        String(row.missingExitCount)
      ])
    ),
    ...(input.options.bucketBy ? [""] : []),
    ...formatBucketAnalysis(input.options.bucketBy, input.rows)
  ].join("\n");
}

function formatBucketAnalysis(bucketBy: ForwardReturnBucketDimension | null, rows: ForwardReturnResearchRow[]): string[] {
  if (!bucketBy) {
    return [];
  }

  const summary = summarizeForwardReturnsByBucket(rows, bucketBy);
  const headers = ["bucket", "window", "count", "avgReturnAbs", "avgReturnPct", "winRate", "missingExitCount"];
  if (!summary.available) {
    return [
      "Bucket analysis:",
      `Bucket by: ${bucketBy}`,
      `Bucket field unavailable for selected signals: ${bucketBy}`,
      formatTable(headers, [])
    ];
  }

  return [
    "Bucket analysis:",
    `Bucket by: ${bucketBy}`,
    formatTable(
      headers,
      summary.rows.map((row) => [
        row.bucket,
        row.window,
        String(row.count),
        formatNumber(row.avgReturnAbs),
        formatPercent(row.avgReturnPct),
        formatPercent(row.winRate),
        String(row.missingExitCount)
      ])
    )
  ];
}

function formatTopRejectionReasons(rows: ForwardReturnRejectionReasonSummaryRow[]): string {
  return formatTable(
    ["reason", "count"],
    rows.slice(0, 10).map((row) => [row.reason, String(row.count)])
  );
}

function formatNearMissDiagnostics(diagnostics: NearMissDiagnostics | null | undefined): string[] {
  if (!diagnostics) {
    return [];
  }
  return [
    "",
    "Near-miss diagnostics:",
    `Near-miss threshold source: ${diagnostics.thresholdSource}`,
    `Min net edge threshold used: ${formatNumber(diagnostics.minNetEdge)}`,
    `Threshold source kind: ${diagnostics.sourceKind}`,
    `Selected low_edge signals with usable netEdge values: ${diagnostics.usableNetEdgeSignals} of ${diagnostics.selectedLowEdgeSignals}`
  ];
}

function formatTable(headers: string[], rows: string[][]): string {
  const allRows = rows.length > 0 ? rows : [headers.map(() => "none")];
  const widths = headers.map((header, index) => {
    return Math.max(header.length, ...allRows.map((row) => row[index]?.length ?? 0));
  });
  const formatRow = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index])).join(" | ");
  return [formatRow(headers), widths.map((width) => "-".repeat(width)).join("-|-"), ...allRows.map(formatRow)].join("\n");
}

export function parseForwardReturnsOptions(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): ForwardReturnsOptions {
  const args = parseArgs(argv);
  const minAgeEnvValue = env.RESEARCH_MIN_AGE_MINUTES;
  const rejectionReason = readOptionalString(
    resolveAliasOption(args, ["rejection-reason", "reason"], 5, env.RESEARCH_REJECTION_REASON),
    "rejection-reason"
  );

  return {
    limit: readPositiveInteger(resolveOption(args, "limit", 0, env.FORWARD_RETURNS_LIMIT), "limit", DEFAULT_LIMIT),
    lookbackHours: readPositiveNumber(
      resolveOption(args, "lookback-hours", 1, env.FORWARD_RETURNS_LOOKBACK_HOURS),
      "lookback-hours",
      DEFAULT_LOOKBACK_HOURS
    ),
    minAgeMinutes: readNonNegativeNumber(
      resolveOption(args, "min-age-minutes", 2, minAgeEnvValue),
      "min-age-minutes",
      DEFAULT_MIN_AGE_MINUTES
    ),
    order: readOrder(resolveOption(args, "order", 3, env.RESEARCH_FORWARD_RETURNS_ORDER), DEFAULT_ORDER),
    status: readSignalStatus(resolveOption(args, "status", 4, env.RESEARCH_SIGNAL_STATUS), "all"),
    rejectionReason,
    bucketBy: readBucketDimension(resolveOption(args, "bucket-by", 6, env.RESEARCH_FORWARD_RETURNS_BUCKET_BY))
  };
}

interface ParsedArgs {
  named: Record<string, string | boolean>;
  positional: string[];
}

interface ResolvedOption {
  value: string | boolean | undefined;
  source: "named flag" | "positional argument" | "environment variable" | "default";
}

function parseArgs(argv: string[]): ParsedArgs {
  const named: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      named[rawKey] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      named[rawKey] = next;
      index += 1;
    } else {
      named[rawKey] = true;
    }
  }

  return { named, positional };
}

function resolveOption(
  args: ParsedArgs,
  flagName: string,
  positionalIndex: number,
  envValue: string | undefined
): ResolvedOption {
  if (args.named[flagName] !== undefined) {
    return { value: args.named[flagName], source: "named flag" };
  }
  if (args.positional[positionalIndex] !== undefined) {
    return { value: args.positional[positionalIndex], source: "positional argument" };
  }
  if (envValue !== undefined) {
    return { value: envValue, source: "environment variable" };
  }
  return { value: undefined, source: "default" };
}

function resolveAliasOption(
  args: ParsedArgs,
  flagNames: string[],
  positionalIndex: number | null,
  envValue: string | undefined
): ResolvedOption {
  for (const flagName of flagNames) {
    if (args.named[flagName] !== undefined) {
      return { value: args.named[flagName], source: "named flag" };
    }
  }
  if (positionalIndex !== null && args.positional[positionalIndex] !== undefined) {
    return { value: args.positional[positionalIndex], source: "positional argument" };
  }
  if (envValue !== undefined) {
    return { value: envValue, source: "environment variable" };
  }
  return { value: undefined, source: "default" };
}

function readPositiveInteger(option: ResolvedOption, optionName: string, fallback: number): number {
  if (option.value === undefined) {
    return fallback;
  }

  const parsed = typeof option.value === "boolean" ? Number.NaN : Number(option.value);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }

  throw new ForwardReturnsOptionsError(
    `Invalid ${optionName} from ${option.source}: expected a positive integer, received ${String(option.value)}.`
  );
}

function readPositiveNumber(option: ResolvedOption, optionName: string, fallback: number): number {
  if (option.value === undefined) {
    return fallback;
  }

  const parsed = typeof option.value === "boolean" ? Number.NaN : Number(option.value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  throw new ForwardReturnsOptionsError(
    `Invalid ${optionName} from ${option.source}: expected a positive number, received ${String(option.value)}.`
  );
}

function readNonNegativeNumber(option: ResolvedOption, optionName: string, fallback: number): number {
  if (option.value === undefined) {
    return fallback;
  }

  const parsed = typeof option.value === "boolean" ? Number.NaN : Number(option.value);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed;
  }

  throw new ForwardReturnsOptionsError(
    `Invalid ${optionName} from ${option.source}: expected a non-negative number, received ${String(option.value)}.`
  );
}

function readOrder(option: ResolvedOption, fallback: ForwardReturnOrder): ForwardReturnOrder {
  if (option.value === undefined) {
    return fallback;
  }
  if (option.value === "oldest" || option.value === "newest") {
    return option.value;
  }

  throw new ForwardReturnsOptionsError(
    `Invalid order from ${option.source}: expected oldest or newest, received ${String(option.value)}.`
  );
}

function readSignalStatus(option: ResolvedOption, fallback: ForwardReturnSignalStatusFilter): ForwardReturnSignalStatusFilter {
  if (option.value === undefined) {
    return fallback;
  }
  if (option.value === "accepted" || option.value === "rejected" || option.value === "all") {
    return option.value;
  }

  throw new ForwardReturnsOptionsError(
    `Invalid status from ${option.source}: expected accepted, rejected, or all, received ${String(option.value)}.`
  );
}

function readBucketDimension(option: ResolvedOption): ForwardReturnBucketDimension | null {
  if (option.value === undefined) {
    return null;
  }
  if (
    option.value === "entryCost" ||
    option.value === "estimatedEdge" ||
    option.value === "netEdge" ||
    option.value === "spread" ||
    option.value === "strategy" ||
    option.value === "reason" ||
    option.value === "nearMiss"
  ) {
    return option.value;
  }

  throw new ForwardReturnsOptionsError(
    `Invalid bucket-by from ${option.source}: expected entryCost, estimatedEdge, netEdge, spread, strategy, reason, or nearMiss, received ${String(option.value)}.`
  );
}

function readOptionalString(option: ResolvedOption, optionName: string): string | null {
  if (option.value === undefined) {
    return null;
  }
  if (typeof option.value === "boolean") {
    throw new ForwardReturnsOptionsError(
      `Invalid ${optionName} from ${option.source}: expected a string, received ${String(option.value)}.`
    );
  }
  const value = option.value.trim();
  return value.length === 0 ? null : value;
}

function formatNumber(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(6);
}

function formatPercent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(2)}%`;
}

function formatDateTime(value: Date | null): string {
  return value ? value.toISOString() : "n/a";
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function averageFinite(values: unknown[]): number | null {
  const finite = values.flatMap((value) => {
    const parsed = toFiniteNumber(value);
    return parsed === null ? [] : [parsed];
  });
  if (finite.length === 0) {
    return null;
  }
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function firstFiniteNumber(...values: Array<unknown>): number | null {
  for (const value of values) {
    const parsed = toFiniteNumber(value);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "object" && "toNumber" in value && typeof value.toNumber === "function") {
    return toFiniteNumber(value.toNumber());
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function loadNearMissMinNetEdgeThreshold(): Pick<NearMissDiagnostics, "thresholdSource" | "minNetEdge" | "sourceKind"> {
  const configured = loadWorkerConfig().detection.minNetEdge;
  if (Number.isFinite(configured)) {
    return {
      thresholdSource: "production config loadWorkerConfig().detection.minNetEdge",
      minNetEdge: configured,
      sourceKind: "production config"
    };
  }
  return {
    thresholdSource: "fallback constant",
    minNetEdge: 0.005,
    sourceKind: "fallback"
  };
}

function buildNearMissDiagnostics(
  signals: PersistedSignal[],
  threshold: Pick<NearMissDiagnostics, "thresholdSource" | "minNetEdge" | "sourceKind">
): NearMissDiagnostics {
  const lowEdgeSignals = signals.filter((signal) => classifyForwardReturnRejectionReason(signal) === "low_edge");
  const usableNetEdgeSignals = lowEdgeSignals.filter((signal) => {
    const raw = readRecord(signal.rawJson);
    return firstFiniteNumber(signal.netEdge, raw?.netEdge) !== null;
  }).length;

  return {
    ...threshold,
    usableNetEdgeSignals,
    selectedLowEdgeSignals: lowEdgeSignals.length
  };
}

function isMainModule(): boolean {
  return process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
}

if (isMainModule()) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
