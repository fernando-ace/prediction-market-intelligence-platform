import "./env";

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCandidateDiagnostics,
  chooseEntryPrice,
  chooseExitPrice,
  computeForwardReturn,
  dedupeCandidates,
  extractCandidate,
  filterForwardReturnSignalsByStatusAndReason,
  formatCandidateDiscoveryReport,
  rankCandidates,
  signalDetectedAtCutoffForMinimumAge,
  type CandidateDiscoveryCandidate,
  type CandidateDedupeMode,
  type CandidateSortDirection,
  type CandidateSortField,
  type ForwardReturnSignalStatusFilter,
  type ForwardReturnSnapshotInput,
  type ForwardReturnWindow
} from "@prediction-market-scanner/core";
import { Prisma, prisma } from "@prediction-market-scanner/db";
import { loadWorkerConfig } from "./config";

const DEFAULT_LIMIT = 50_000;
const DEFAULT_LOOKBACK_HOURS = 720;
const DEFAULT_MIN_AGE_MINUTES = 240;
const DEFAULT_STATUS: ForwardReturnSignalStatusFilter = "rejected";
const DEFAULT_REJECTION_REASON = "low_edge";
const DEFAULT_SORT_BY: CandidateSortField = "netEdge";
const DEFAULT_DIRECTION: CandidateSortDirection = "desc";
const DEFAULT_TOP = 20;
const DEFAULT_DEDUPE_BY: CandidateDedupeMode = "none";
const MAX_SIGNAL_READ_BATCH_SIZE = 5_000;
const WINDOWS: ForwardReturnWindow[] = ["15m", "30m", "60m", "240m"];
const WINDOW_MINUTES: Record<ForwardReturnWindow, number> = {
  "15m": 15,
  "30m": 30,
  "60m": 60,
  "240m": 240
};

type PersistedSignal = Prisma.SignalGetPayload<{ include: ReturnType<typeof signalInclude> }>;
type PersistedSnapshot = Awaited<ReturnType<typeof readFirstSnapshotAtOrAfter>>;

interface CandidateDiscoveryOptions {
  limit: number;
  lookbackHours: number;
  minAgeMinutes: number;
  status: ForwardReturnSignalStatusFilter;
  rejectionReason: string;
  sortBy: CandidateSortField;
  direction: CandidateSortDirection;
  top: number;
  dedupeBy: CandidateDedupeMode;
}

interface MarketRef {
  marketId: string;
  ticker: string;
}

class CandidateDiscoveryOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidateDiscoveryOptionsError";
  }
}

async function main(): Promise<void> {
  const options = parseCandidateDiscoveryOptions();
  const newestSnapshotAt = await readNewestSnapshotAt();
  const since = new Date(Date.now() - options.lookbackHours * 60 * 60 * 1000);
  const signalDetectedAtCutoff = signalDetectedAtCutoffForMinimumAge(newestSnapshotAt ?? new Date(), options.minAgeMinutes);
  const signals = await readCandidateSignals({
    since,
    signalDetectedAtCutoff,
    limit: options.limit,
    status: options.status,
    rejectionReason: options.rejectionReason
  });
  const candidates = await buildCandidateRows(signals);
  const ranked = rankCandidates(candidates, options.sortBy, options.direction);
  const deduped = dedupeCandidates(ranked, options.dedupeBy);
  const minNetEdgeThreshold = loadWorkerConfig().detection.minNetEdge;

  console.log(
    formatCandidateDiscoveryReport({
      lookbackHours: options.lookbackHours,
      status: options.status,
      rejectionReason: options.rejectionReason,
      sortBy: options.sortBy,
      direction: options.direction,
      candidatesScanned: signals.length,
      candidatesAfterFilters: candidates.length,
      dedupeBy: options.dedupeBy,
      candidatesAfterDedupe: deduped.length,
      candidates: deduped,
      top: options.top,
      diagnostics: buildCandidateDiagnostics(candidates, minNetEdgeThreshold)
    })
  );
}

async function readCandidateSignals(args: {
  since: Date;
  signalDetectedAtCutoff: Date;
  limit: number;
  status: ForwardReturnSignalStatusFilter;
  rejectionReason: string;
}): Promise<PersistedSignal[]> {
  const baseWhere = {
    detectedAt: {
      gte: args.since,
      lte: args.signalDetectedAtCutoff
    },
    ...(args.status === "all" ? {} : { status: args.status })
  } satisfies Prisma.SignalWhereInput;

  const selected: PersistedSignal[] = [];
  const batchSize = Math.min(Math.max(args.limit * 5, 500), MAX_SIGNAL_READ_BATCH_SIZE);
  let cursor: { id: string } | undefined;

  while (selected.length < args.limit) {
    const batch = await prisma.signal.findMany({
      where: baseWhere,
      orderBy: [{ detectedAt: "desc" }, { id: "desc" }],
      take: batchSize,
      ...(cursor ? { cursor, skip: 1 } : {}),
      include: signalInclude()
    });

    if (batch.length === 0) {
      break;
    }

    const matching = filterForwardReturnSignalsByStatusAndReason(batch, {
      status: "all",
      rejectionReason: args.rejectionReason
    });
    for (const signal of matching) {
      selected.push(signal);
    }
    cursor = { id: batch[batch.length - 1].id };
  }

  return selected.slice(0, args.limit);
}

function signalInclude() {
  return {
    market: {
      select: {
        id: true,
        ticker: true,
        title: true
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

async function buildCandidateRows(signals: PersistedSignal[]): Promise<CandidateDiscoveryCandidate[]> {
  const candidates: CandidateDiscoveryCandidate[] = [];

  for (const signal of signals) {
    const marketRefs = marketRefsForSignal(signal);
    const entrySnapshots = await readEntrySnapshots(signal, marketRefs);
    const signalInput = toForwardReturnSignalInput(signal);
    const entryCost = chooseEntryPrice(signalInput, oneOrMany(entrySnapshots));
    const forwardReturns: Partial<Record<ForwardReturnWindow, number | null>> = {};

    for (const window of WINDOWS) {
      const targetTime = new Date(signal.detectedAt.getTime() + WINDOW_MINUTES[window] * 60 * 1000);
      const exitSnapshots = await readExitSnapshots(marketRefs, targetTime);
      const exitPrice = chooseExitPrice(signalInput, oneOrMany(exitSnapshots));
      forwardReturns[window] = computeForwardReturn(entryCost, exitPrice).returnPct;
    }

    candidates.push(
      extractCandidate(toCandidateSignalInput(signal), {
        entryCost,
        spread: averageFinite(entrySnapshots.map((snapshot) => snapshot.spread)),
        forwardReturns
      })
    );
  }

  return candidates;
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

function toCandidateSignalInput(signal: PersistedSignal) {
  return {
    id: signal.id,
    detectedAt: signal.detectedAt,
    strategy: signal.strategy,
    status: signal.status,
    reason: signal.reason,
    grossEdge: signal.grossEdge,
    netEdge: signal.netEdge,
    maxContracts: signal.maxContracts,
    rawJson: signal.rawJson,
    market: {
      id: signal.market.id,
      ticker: signal.market.ticker,
      title: signal.market.title
    },
    relatedGroup: signal.relatedGroup
      ? {
          markets: signal.relatedGroup.markets.map((market) => ({
            id: market.marketId,
            ticker: market.marketTicker,
            title: market.title
          }))
        }
      : null
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

export function parseCandidateDiscoveryOptions(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): CandidateDiscoveryOptions {
  const args = parseArgs(argv);
  return {
    limit: readPositiveInteger(resolveOption(args, "limit", 0, env.RESEARCH_CANDIDATE_LIMIT), "limit", DEFAULT_LIMIT),
    lookbackHours: readPositiveNumber(
      resolveOption(args, "lookback-hours", 1, env.RESEARCH_CANDIDATE_LOOKBACK_HOURS),
      "lookback-hours",
      DEFAULT_LOOKBACK_HOURS
    ),
    minAgeMinutes: readNonNegativeNumber(
      resolveOption(args, "min-age-minutes", 2, env.RESEARCH_CANDIDATE_MIN_AGE_MINUTES ?? env.RESEARCH_MIN_AGE_MINUTES),
      "min-age-minutes",
      DEFAULT_MIN_AGE_MINUTES
    ),
    status: readSignalStatus(resolveOption(args, "status", 3, env.RESEARCH_SIGNAL_STATUS), DEFAULT_STATUS),
    rejectionReason: readRequiredString(
      resolveAliasOption(args, ["rejection-reason", "reason"], 4, env.RESEARCH_REJECTION_REASON),
      "rejection-reason",
      DEFAULT_REJECTION_REASON
    ),
    sortBy: readSortField(resolveOption(args, "sort-by", 5, env.RESEARCH_CANDIDATE_SORT_BY), DEFAULT_SORT_BY),
    direction: readDirection(resolveOption(args, "direction", 6, env.RESEARCH_CANDIDATE_DIRECTION), DEFAULT_DIRECTION),
    top: readPositiveInteger(resolveOption(args, "top", 7, env.RESEARCH_CANDIDATE_TOP), "top", DEFAULT_TOP),
    dedupeBy: readDedupeMode(resolveOption(args, "dedupe-by", 8, env.RESEARCH_CANDIDATE_DEDUPE_BY), DEFAULT_DEDUPE_BY)
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
    if (arg === "--discover-candidates") {
      named["discover-candidates"] = true;
      continue;
    }
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
  positionalIndex: number,
  envValue: string | undefined
): ResolvedOption {
  for (const flagName of flagNames) {
    if (args.named[flagName] !== undefined) {
      return { value: args.named[flagName], source: "named flag" };
    }
  }
  if (args.positional[positionalIndex] !== undefined) {
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

  throw new CandidateDiscoveryOptionsError(
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

  throw new CandidateDiscoveryOptionsError(
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

  throw new CandidateDiscoveryOptionsError(
    `Invalid ${optionName} from ${option.source}: expected a non-negative number, received ${String(option.value)}.`
  );
}

function readRequiredString(option: ResolvedOption, optionName: string, fallback: string): string {
  if (option.value === undefined) {
    return fallback;
  }
  if (typeof option.value === "boolean") {
    throw new CandidateDiscoveryOptionsError(
      `Invalid ${optionName} from ${option.source}: expected a string, received ${String(option.value)}.`
    );
  }
  const value = option.value.trim();
  return value.length === 0 ? fallback : value;
}

function readSignalStatus(option: ResolvedOption, fallback: ForwardReturnSignalStatusFilter): ForwardReturnSignalStatusFilter {
  if (option.value === undefined) {
    return fallback;
  }
  if (option.value === "accepted" || option.value === "rejected" || option.value === "all") {
    return option.value;
  }

  throw new CandidateDiscoveryOptionsError(
    `Invalid status from ${option.source}: expected accepted, rejected, or all, received ${String(option.value)}.`
  );
}

function readSortField(option: ResolvedOption, fallback: CandidateSortField): CandidateSortField {
  if (option.value === undefined) {
    return fallback;
  }
  if (
    option.value === "netEdge" ||
    option.value === "spread" ||
    option.value === "entryCost" ||
    option.value === "return15m" ||
    option.value === "return60m" ||
    option.value === "return240m"
  ) {
    return option.value;
  }

  throw new CandidateDiscoveryOptionsError(
    `Invalid sort-by from ${option.source}: expected netEdge, spread, entryCost, return15m, return60m, or return240m, received ${String(option.value)}.`
  );
}

function readDirection(option: ResolvedOption, fallback: CandidateSortDirection): CandidateSortDirection {
  if (option.value === undefined) {
    return fallback;
  }
  if (option.value === "asc" || option.value === "desc") {
    return option.value;
  }

  throw new CandidateDiscoveryOptionsError(
    `Invalid direction from ${option.source}: expected asc or desc, received ${String(option.value)}.`
  );
}

function readDedupeMode(option: ResolvedOption, fallback: CandidateDedupeMode): CandidateDedupeMode {
  if (option.value === undefined) {
    return fallback;
  }
  if (option.value === "none" || option.value === "ticker" || option.value === "market") {
    return option.value;
  }

  throw new CandidateDiscoveryOptionsError(
    `Invalid dedupe-by from ${option.source}: expected none, ticker, or market, received ${String(option.value)}.`
  );
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
