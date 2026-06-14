import "./env";

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildSpreadEpisodes,
  getSnapshotSpread,
  selectTopSpreadEpisodes,
  summarizeSpreadEpisodes,
  type SpreadEpisode,
  type SpreadPersistenceDedupeMode,
  type SpreadPersistenceSnapshotInput
} from "@prediction-market-scanner/core";
import { Prisma, prisma } from "@prediction-market-scanner/db";

const DEFAULT_LIMIT = 50_000;
const DEFAULT_LOOKBACK_HOURS = 720;
const DEFAULT_MIN_SPREAD = 0.04;
const DEFAULT_MAX_SPREAD = 0.1;
const DEFAULT_MAX_GAP_MINUTES = 2;
const DEFAULT_DEDUPE_BY: SpreadPersistenceDedupeMode = "ticker";
const DEFAULT_TOP = 20;

type PersistedSnapshot = Prisma.OrderbookSnapshotGetPayload<{ select: ReturnType<typeof snapshotSelect> }>;

interface SpreadPersistenceOptions {
  limit: number;
  lookbackHours: number;
  minSpread: number;
  maxSpread: number;
  maxGapMinutes: number;
  dedupeBy: SpreadPersistenceDedupeMode;
  top: number;
}

class SpreadPersistenceOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpreadPersistenceOptionsError";
  }
}

async function main(): Promise<void> {
  const options = parseSpreadPersistenceOptions();
  const since = new Date(Date.now() - options.lookbackHours * 60 * 60 * 1000);
  const snapshots = await readSnapshots({ since, limit: options.limit });
  const episodeInputs = snapshots.map(toSpreadPersistenceSnapshot).filter((snapshot): snapshot is SpreadPersistenceSnapshotInput => snapshot.spread !== null);
  const episodes = buildSpreadEpisodes(episodeInputs, options);

  console.log(
    formatSpreadPersistenceReport({
      options,
      snapshotsScanned: snapshots.length,
      episodes
    })
  );
}

async function readSnapshots(args: { since: Date; limit: number }): Promise<PersistedSnapshot[]> {
  return prisma.orderbookSnapshot.findMany({
    where: {
      capturedAt: {
        gte: args.since
      }
    },
    orderBy: [{ capturedAt: "desc" }, { id: "desc" }],
    take: args.limit,
    select: snapshotSelect()
  });
}

function snapshotSelect() {
  return {
    id: true,
    marketId: true,
    capturedAt: true,
    bestYesBid: true,
    bestYesAsk: true,
    bestNoBid: true,
    bestNoAsk: true,
    spread: true,
    market: {
      select: {
        id: true,
        ticker: true,
        title: true
      }
    }
  } satisfies Prisma.OrderbookSnapshotSelect;
}

function toSpreadPersistenceSnapshot(snapshot: PersistedSnapshot): SpreadPersistenceSnapshotInput {
  return {
    marketId: snapshot.marketId,
    ticker: snapshot.market.ticker,
    title: snapshot.market.title,
    capturedAt: snapshot.capturedAt,
    spread: getSnapshotSpread(snapshot)
  };
}

export function formatSpreadPersistenceReport(input: {
  options: SpreadPersistenceOptions;
  snapshotsScanned: number;
  episodes: SpreadEpisode[];
}): string {
  const summary = summarizeSpreadEpisodes(input.episodes);
  const topEpisodes = selectTopSpreadEpisodes(input.episodes, input.options.dedupeBy).slice(0, input.options.top);

  return [
    "Spread Persistence Research Report",
    `Lookback hours: ${input.options.lookbackHours}`,
    `Spread range: ${formatPlainNumber(input.options.minSpread)} to ${formatPlainNumber(input.options.maxSpread)}`,
    `Max gap minutes: ${formatPlainNumber(input.options.maxGapMinutes)}`,
    `Snapshots scanned: ${input.snapshotsScanned}`,
    `Episodes found: ${input.episodes.length}`,
    `Unique tickers with episodes: ${new Set(input.episodes.map((episode) => episode.ticker)).size}`,
    "",
    "Overall:",
    `avgEpisodeMinutes: ${formatNumber(summary.overall.avgEpisodeMinutes)}`,
    `medianEpisodeMinutes: ${formatNumber(summary.overall.medianEpisodeMinutes)}`,
    `maxEpisodeMinutes: ${formatNumber(summary.overall.maxEpisodeMinutes)}`,
    `avgSnapshotsPerEpisode: ${formatNumber(summary.overall.avgSnapshotsPerEpisode)}`,
    "",
    "By duration bucket:",
    formatBucketTable(summary.byDurationBucket),
    "",
    "Top episodes:",
    formatEpisodeTable(topEpisodes)
  ].join("\n");
}

export function parseSpreadPersistenceOptions(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): SpreadPersistenceOptions {
  const args = parseArgs(argv);
  const positional = resolveSpreadPersistencePositionals(args.positional);
  const options = {
    limit: readPositiveInteger(resolveOption(args, "limit", positional.limit, env.RESEARCH_SPREAD_PERSISTENCE_LIMIT), "limit", DEFAULT_LIMIT),
    lookbackHours: readPositiveNumber(
      resolveOption(args, "lookback-hours", positional.lookbackHours, env.RESEARCH_SPREAD_PERSISTENCE_LOOKBACK_HOURS),
      "lookback-hours",
      DEFAULT_LOOKBACK_HOURS
    ),
    minSpread: readNonNegativeNumber(
      resolveOption(args, "min-spread", positional.minSpread, env.RESEARCH_SPREAD_PERSISTENCE_MIN_SPREAD),
      "min-spread",
      DEFAULT_MIN_SPREAD
    ),
    maxSpread: readNonNegativeNumber(
      resolveOption(args, "max-spread", positional.maxSpread, env.RESEARCH_SPREAD_PERSISTENCE_MAX_SPREAD),
      "max-spread",
      DEFAULT_MAX_SPREAD
    ),
    maxGapMinutes: readPositiveNumber(
      resolveOption(args, "max-gap-minutes", positional.maxGapMinutes, env.RESEARCH_SPREAD_PERSISTENCE_MAX_GAP_MINUTES),
      "max-gap-minutes",
      DEFAULT_MAX_GAP_MINUTES
    ),
    dedupeBy: readDedupeMode(resolveOption(args, "dedupe-by", positional.dedupeBy, env.RESEARCH_SPREAD_PERSISTENCE_DEDUPE_BY), DEFAULT_DEDUPE_BY),
    top: readPositiveInteger(resolveOption(args, "top", positional.top, env.RESEARCH_SPREAD_PERSISTENCE_TOP), "top", DEFAULT_TOP)
  };
  validateSpreadRange(options.minSpread, options.maxSpread);
  return options;
}

function formatBucketTable(rows: ReturnType<typeof summarizeSpreadEpisodes>["byDurationBucket"]): string {
  return formatTable(
    ["bucket", "count", "avgDurationMinutes", "avgSpread", "maxSpread"],
    rows.map((row) => [
      row.bucket,
      String(row.count),
      formatNumber(row.avgDurationMinutes),
      formatNumber(row.avgSpread),
      formatNumber(row.maxSpread)
    ])
  );
}

function formatEpisodeTable(rows: SpreadEpisode[]): string {
  return formatTable(
    ["rank", "ticker", "start", "end", "durationMinutes", "snapshotCount", "avgSpread", "maxSpread", "title"],
    rows.map((episode, index) => [
      String(index + 1),
      episode.ticker,
      episode.start.toISOString(),
      episode.end.toISOString(),
      formatNumber(episode.durationMinutes),
      String(episode.snapshotCount),
      formatNumber(episode.avgSpread),
      formatNumber(episode.maxSpread),
      truncateTitle(episode.title)
    ])
  );
}

interface SpreadPersistencePositionalOptions {
  limit?: string;
  lookbackHours?: string;
  minSpread?: string;
  maxSpread?: string;
  maxGapMinutes?: string;
  dedupeBy?: string;
  top?: string;
}

function resolveSpreadPersistencePositionals(positional: string[]): SpreadPersistencePositionalOptions {
  const resolved: SpreadPersistencePositionalOptions = {
    limit: positional[0],
    lookbackHours: positional[1],
    minSpread: positional[2],
    maxSpread: positional[3]
  };

  const optional = positional.slice(4);
  if (optional.length === 0) {
    return resolved;
  }

  const [first, second, third] = optional;
  if (isNumericText(first)) {
    resolved.maxGapMinutes = first;
    resolved.dedupeBy = second;
    resolved.top = third;
    return resolved;
  }

  resolved.dedupeBy = first;
  resolved.top = second;
  return resolved;
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
  positionalValue: string | undefined,
  envValue: string | undefined
): ResolvedOption {
  if (args.named[flagName] !== undefined) {
    return { value: args.named[flagName], source: "named flag" };
  }
  if (positionalValue !== undefined) {
    return { value: positionalValue, source: "positional argument" };
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

  throw new SpreadPersistenceOptionsError(
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

  throw new SpreadPersistenceOptionsError(
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

  throw new SpreadPersistenceOptionsError(
    `Invalid ${optionName} from ${option.source}: expected a non-negative number, received ${String(option.value)}.`
  );
}

function readDedupeMode(option: ResolvedOption, fallback: SpreadPersistenceDedupeMode): SpreadPersistenceDedupeMode {
  if (option.value === undefined) {
    return fallback;
  }
  if (option.value === "none" || option.value === "ticker" || option.value === "market") {
    return option.value;
  }

  throw new SpreadPersistenceOptionsError(
    `Invalid dedupe-by from ${option.source}: expected none, ticker, or market, received ${String(option.value)}.`
  );
}

function isNumericText(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  return value.trim() !== "" && Number.isFinite(Number(value));
}

function validateSpreadRange(minSpread: number, maxSpread: number): void {
  if (maxSpread <= minSpread) {
    throw new SpreadPersistenceOptionsError(
      `Invalid spread range: max-spread must be greater than min-spread, received ${maxSpread} <= ${minSpread}.`
    );
  }
}

function formatTable(headers: string[], rows: string[][]): string {
  const allRows = rows.length > 0 ? rows : [headers.map(() => "none")];
  const widths = headers.map((header, index) => Math.max(header.length, ...allRows.map((row) => row[index]?.length ?? 0)));
  const formatRow = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index])).join(" | ");
  return [formatRow(headers), widths.map((width) => "-".repeat(width)).join("-|-"), ...allRows.map(formatRow)].join("\n");
}

function formatNumber(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(6);
}

function formatPlainNumber(value: number): string {
  return value >= 0 && value < 1 ? value.toFixed(2) : String(value);
}

function truncateTitle(value: string | null | undefined): string {
  if (!value) {
    return "";
  }
  return value.length <= 80 ? value : `${value.slice(0, 77)}...`;
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
