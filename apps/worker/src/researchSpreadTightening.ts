import "./env";

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildSpreadTighteningRow,
  summarizeSpreadTightening,
  type ForwardReturnWindow,
  type SpreadTighteningResearchRow,
  type SpreadTighteningSnapshotInput,
  type SpreadTighteningSummaryRow
} from "@prediction-market-scanner/core";
import { Prisma, prisma } from "@prediction-market-scanner/db";

const DEFAULT_LIMIT = 10_000;
const DEFAULT_LOOKBACK_HOURS = 720;
const DEFAULT_MIN_AGE_MINUTES = 240;
const DEFAULT_BUCKET_BY: SpreadTighteningBucketMode = "spread";
const DEFAULT_TOP = 20;
const DEFAULT_DEDUPE_BY: SpreadTighteningDedupeMode = "none";
const ALL_WINDOWS: ForwardReturnWindow[] = ["15m", "30m", "60m", "240m"];
const WINDOW_MINUTES: Record<ForwardReturnWindow, number> = {
  "15m": 15,
  "30m": 30,
  "60m": 60,
  "240m": 240
};

type PersistedSnapshot = Prisma.OrderbookSnapshotGetPayload<{ select: ReturnType<typeof snapshotSelect> }>;
type SpreadTighteningBucketMode = "spread" | "none";
type SpreadTighteningDedupeMode = "none" | "ticker" | "market";
type SpreadTighteningWindowOption = ForwardReturnWindow | "all";

interface SpreadTighteningOptions {
  limit: number;
  lookbackHours: number;
  minAgeMinutes: number;
  bucketBy: SpreadTighteningBucketMode;
  top: number;
  window: SpreadTighteningWindowOption;
  dedupeBy: SpreadTighteningDedupeMode;
}

class SpreadTighteningOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpreadTighteningOptionsError";
  }
}

async function main(): Promise<void> {
  const options = parseSpreadTighteningOptions();
  const windows = windowsForOption(options.window);
  const newestSnapshotAt = await readNewestSnapshotAt();
  const since = new Date(Date.now() - options.lookbackHours * 60 * 60 * 1000);
  const snapshotCapturedAtCutoff = new Date((newestSnapshotAt ?? new Date()).getTime() - options.minAgeMinutes * 60 * 1000);
  const snapshots = await readEntrySnapshots({ since, snapshotCapturedAtCutoff, limit: options.limit });
  const rows = await buildSpreadRows(snapshots, windows);

  console.log(
    formatSpreadTighteningReport({
      options,
      windows,
      snapshotCapturedAtCutoff,
      snapshotsEvaluated: snapshots.length,
      rows
    })
  );
}

async function readEntrySnapshots(args: { since: Date; snapshotCapturedAtCutoff: Date; limit: number }): Promise<PersistedSnapshot[]> {
  return prisma.orderbookSnapshot.findMany({
    where: {
      capturedAt: {
        gte: args.since,
        lte: args.snapshotCapturedAtCutoff
      }
    },
    orderBy: [{ capturedAt: "desc" }, { id: "desc" }],
    take: args.limit,
    select: snapshotSelect()
  });
}

async function buildSpreadRows(snapshots: PersistedSnapshot[], windows: ForwardReturnWindow[]): Promise<SpreadTighteningResearchRow[]> {
  const rows: SpreadTighteningResearchRow[] = [];

  for (const snapshot of snapshots) {
    for (const window of windows) {
      const targetTime = new Date(snapshot.capturedAt.getTime() + WINDOW_MINUTES[window] * 60 * 1000);
      const futureSnapshot = await readFirstSnapshotAtOrAfter(snapshot.marketId, targetTime);
      rows.push(
        buildSpreadTighteningRow({
          marketId: snapshot.marketId,
          ticker: snapshot.market.ticker,
          title: snapshot.market.title,
          category: snapshot.market.category,
          detectedAt: snapshot.capturedAt,
          window,
          entrySnapshot: toSpreadSnapshot(snapshot),
          futureSnapshot: futureSnapshot ? toSpreadSnapshot(futureSnapshot) : null
        })
      );
    }
  }

  return rows;
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
        title: true,
        category: true
      }
    }
  } satisfies Prisma.OrderbookSnapshotSelect;
}

function toSpreadSnapshot(snapshot: PersistedSnapshot): SpreadTighteningSnapshotInput {
  return {
    capturedAt: snapshot.capturedAt,
    bestYesBid: snapshot.bestYesBid,
    bestYesAsk: snapshot.bestYesAsk,
    bestNoBid: snapshot.bestNoBid,
    bestNoAsk: snapshot.bestNoAsk,
    spread: snapshot.spread
  };
}

export function formatSpreadTighteningReport(input: {
  options: SpreadTighteningOptions;
  windows: ForwardReturnWindow[];
  snapshotCapturedAtCutoff: Date;
  snapshotsEvaluated: number;
  rows: SpreadTighteningResearchRow[];
}): string {
  const summary = summarizeSpreadTightening(input.rows);
  const topExampleDiagnostics = buildTopExampleDiagnostics(input.rows, input.options.dedupeBy);
  const tickerSummaryRows = dedupeTickerSummaryRows(summary.byTicker).slice(0, input.options.top);

  return [
    "Spread Tightening Research Report",
    `Lookback hours: ${input.options.lookbackHours}`,
    `Minimum snapshot age minutes: ${input.options.minAgeMinutes}`,
    `Snapshot capturedAt cutoff: ${input.snapshotCapturedAtCutoff.toISOString()}`,
    `Snapshots evaluated: ${input.snapshotsEvaluated}`,
    `Windows: ${input.windows.join(", ")}`,
    `Bucket by: ${input.options.bucketBy}`,
    `Dedupe by: ${input.options.dedupeBy}`,
    `Top examples before dedupe: ${topExampleDiagnostics.beforeDedupe}`,
    `Top examples after dedupe: ${topExampleDiagnostics.afterDedupe}`,
    "",
    "Overall:",
    formatSummaryTable(summary.overall),
    "",
    "By entry spread bucket:",
    input.options.bucketBy === "spread" ? formatBucketSummaryTable(summary.byBucket) : "bucket | window | count | avgEntrySpread | avgFutureSpread | avgSpreadChange | tightenRate | missingExitCount\n------ | ------ | ----- | -------------- | --------------- | --------------- | ----------- | ----------------\nnone   | none   | none  | none           | none            | none            | none        | none",
    "",
    "By category:",
    formatCategorySummaryTable(summary.byCategory.slice(0, input.options.top)),
    "",
    "Strongest ticker/category tightening:",
    formatTickerSummaryTable(tickerSummaryRows),
    "",
    "Top tightening examples:",
    formatTopExamples(input.rows, input.options.top, input.options.dedupeBy)
  ].join("\n");
}

function formatSummaryTable(rows: SpreadTighteningSummaryRow[]): string {
  return formatTable(
    ["window", "count", "avgEntrySpread", "avgFutureSpread", "avgSpreadChange", "tightenRate", "missingExitCount"],
    rows.map((row) => [
      row.window,
      String(row.count),
      formatNumber(row.avgEntrySpread),
      formatNumber(row.avgFutureSpread),
      formatNumber(row.avgSpreadChange),
      formatPercent(row.tightenRate),
      String(row.missingExitCount)
    ])
  );
}

function formatBucketSummaryTable(rows: ReturnType<typeof summarizeSpreadTightening>["byBucket"]): string {
  return formatTable(
    ["bucket", "window", "count", "avgEntrySpread", "avgFutureSpread", "avgSpreadChange", "tightenRate", "missingExitCount"],
    rows.map((row) => [
      row.bucket,
      row.window,
      String(row.count),
      formatNumber(row.avgEntrySpread),
      formatNumber(row.avgFutureSpread),
      formatNumber(row.avgSpreadChange),
      formatPercent(row.tightenRate),
      String(row.missingExitCount)
    ])
  );
}

function formatCategorySummaryTable(rows: ReturnType<typeof summarizeSpreadTightening>["byCategory"]): string {
  return formatTable(
    ["category", "window", "count", "avgEntrySpread", "avgFutureSpread", "avgSpreadChange", "tightenRate", "missingExitCount"],
    rows.map((row) => [
      row.category,
      row.window,
      String(row.count),
      formatNumber(row.avgEntrySpread),
      formatNumber(row.avgFutureSpread),
      formatNumber(row.avgSpreadChange),
      formatPercent(row.tightenRate),
      String(row.missingExitCount)
    ])
  );
}

function formatTickerSummaryTable(rows: ReturnType<typeof summarizeSpreadTightening>["byTicker"]): string {
  return formatTable(
    ["ticker", "window", "count", "avgEntrySpread", "avgFutureSpread", "avgSpreadChange", "tightenRate", "title"],
    rows.map((row) => [
      row.ticker,
      row.window,
      String(row.count),
      formatNumber(row.avgEntrySpread),
      formatNumber(row.avgFutureSpread),
      formatNumber(row.avgSpreadChange),
      formatPercent(row.tightenRate),
      truncateTitle(row.title)
    ])
  );
}

function formatTopExamples(rows: SpreadTighteningResearchRow[], top: number, dedupeBy: SpreadTighteningDedupeMode): string {
  const examples = selectTopExamples(rows, dedupeBy).slice(0, top);

  return formatTable(
    ["rank", "ticker", "detectedAt", "entrySpread", "futureSpread", "spreadChange", "window", "title"],
    examples.map((row, index) => [
      String(index + 1),
      row.ticker,
      row.detectedAt.toISOString(),
      formatNumber(row.entrySpread),
      formatNumber(row.futureSpread),
      formatNumber(row.spreadChange),
      row.window,
      truncateTitle(row.title)
    ])
  );
}

function buildTopExampleDiagnostics(rows: SpreadTighteningResearchRow[], dedupeBy: SpreadTighteningDedupeMode): {
  beforeDedupe: number;
  afterDedupe: number;
} {
  const beforeDedupe = rows.filter((row) => row.spreadChange !== null).length;
  return {
    beforeDedupe,
    afterDedupe: selectTopExamples(rows, dedupeBy).length
  };
}

function selectTopExamples(rows: SpreadTighteningResearchRow[], dedupeBy: SpreadTighteningDedupeMode): SpreadTighteningResearchRow[] {
  const rankedRows = rows
    .filter((row): row is SpreadTighteningResearchRow & { spreadChange: number } => row.spreadChange !== null)
    .sort((left, right) => left.spreadChange - right.spreadChange);

  if (dedupeBy === "none") {
    return rankedRows;
  }

  const seen = new Set<string>();
  const deduped: SpreadTighteningResearchRow[] = [];
  for (const row of rankedRows) {
    const key = dedupeBy === "market" ? row.marketId : row.ticker;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

function dedupeTickerSummaryRows(
  rows: ReturnType<typeof summarizeSpreadTightening>["byTicker"]
): ReturnType<typeof summarizeSpreadTightening>["byTicker"] {
  const seen = new Set<string>();
  const deduped: ReturnType<typeof summarizeSpreadTightening>["byTicker"] = [];
  for (const row of rows) {
    const key = `${row.ticker}\u0000${row.window}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

export function parseSpreadTighteningOptions(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): SpreadTighteningOptions {
  const args = parseArgs(argv);
  const positional = resolveSpreadTighteningPositionals(args.positional);
  return {
    limit: readPositiveInteger(resolveOption(args, "limit", positional.limit, env.RESEARCH_SPREAD_TIGHTENING_LIMIT), "limit", DEFAULT_LIMIT),
    lookbackHours: readPositiveNumber(
      resolveOption(args, "lookback-hours", positional.lookbackHours, env.RESEARCH_SPREAD_TIGHTENING_LOOKBACK_HOURS),
      "lookback-hours",
      DEFAULT_LOOKBACK_HOURS
    ),
    minAgeMinutes: readNonNegativeNumber(
      resolveOption(
        args,
        "min-age-minutes",
        positional.minAgeMinutes,
        env.RESEARCH_SPREAD_TIGHTENING_MIN_AGE_MINUTES ?? env.RESEARCH_MIN_AGE_MINUTES
      ),
      "min-age-minutes",
      DEFAULT_MIN_AGE_MINUTES
    ),
    bucketBy: readBucketMode(resolveOption(args, "bucket-by", positional.bucketBy, env.RESEARCH_SPREAD_TIGHTENING_BUCKET_BY), DEFAULT_BUCKET_BY),
    dedupeBy: readDedupeMode(
      resolveOption(args, "dedupe-by", positional.dedupeBy, env.RESEARCH_SPREAD_TIGHTENING_DEDUPE_BY ?? env.RESEARCH_SPREAD_DEDUPE_BY),
      DEFAULT_DEDUPE_BY
    ),
    top: readPositiveInteger(resolveOption(args, "top", positional.top, env.RESEARCH_SPREAD_TIGHTENING_TOP), "top", DEFAULT_TOP),
    window: readWindow(resolveOption(args, "window", positional.window, env.RESEARCH_SPREAD_TIGHTENING_WINDOW), "all")
  };
}

interface SpreadTighteningPositionalOptions {
  limit?: string;
  lookbackHours?: string;
  minAgeMinutes?: string;
  bucketBy?: string;
  dedupeBy?: string;
  top?: string;
  window?: string;
}

function resolveSpreadTighteningPositionals(positional: string[]): SpreadTighteningPositionalOptions {
  const resolved: SpreadTighteningPositionalOptions = {
    limit: positional[0],
    lookbackHours: positional[1],
    minAgeMinutes: positional[2]
  };
  const optional = positional.slice(3);
  if (optional.length === 0) {
    return resolved;
  }

  const [first, second, third, fourth] = optional;
  if (first === "spread") {
    resolved.bucketBy = first;
    assignDedupeTopWindowPositionals(resolved, second, third, fourth);
    return resolved;
  }

  if (first === "none") {
    resolved.bucketBy = first;
    if (second && isDedupeModeValue(second)) {
      assignDedupeTopWindowPositionals(resolved, second, third, fourth);
    } else {
      assignTopWindowDedupePositionals(resolved, second, third, fourth);
    }
    return resolved;
  }

  if (first === "ticker" || first === "market") {
    resolved.dedupeBy = first;
    assignTopWindowDedupePositionals(resolved, second, third, fourth);
    return resolved;
  }

  resolved.bucketBy = first;
  assignTopWindowDedupePositionals(resolved, second, third, fourth);
  return resolved;
}

function assignDedupeTopWindowPositionals(
  resolved: SpreadTighteningPositionalOptions,
  dedupeBy?: string,
  top?: string,
  window?: string
): void {
  if (dedupeBy !== undefined) {
    resolved.dedupeBy = dedupeBy;
  }
  if (top !== undefined) {
    resolved.top = top;
  }
  if (window !== undefined) {
    resolved.window = window;
  }
}

function assignTopWindowDedupePositionals(
  resolved: SpreadTighteningPositionalOptions,
  top?: string,
  window?: string,
  dedupeBy?: string
): void {
  if (top !== undefined) {
    resolved.top = top;
  }
  if (window !== undefined) {
    resolved.window = window;
  }
  if (dedupeBy !== undefined) {
    resolved.dedupeBy = dedupeBy;
  }
}

function isDedupeModeValue(value: string): value is SpreadTighteningDedupeMode {
  return value === "none" || value === "ticker" || value === "market";
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

  throw new SpreadTighteningOptionsError(
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

  throw new SpreadTighteningOptionsError(
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

  throw new SpreadTighteningOptionsError(
    `Invalid ${optionName} from ${option.source}: expected a non-negative number, received ${String(option.value)}.`
  );
}

function readBucketMode(option: ResolvedOption, fallback: SpreadTighteningBucketMode): SpreadTighteningBucketMode {
  if (option.value === undefined) {
    return fallback;
  }
  if (option.value === "spread" || option.value === "none") {
    return option.value;
  }

  throw new SpreadTighteningOptionsError(
    `Invalid bucket-by from ${option.source}: expected spread or none, received ${String(option.value)}.`
  );
}

function readDedupeMode(option: ResolvedOption, fallback: SpreadTighteningDedupeMode): SpreadTighteningDedupeMode {
  if (option.value === undefined) {
    return fallback;
  }
  if (isDedupeModeValue(String(option.value))) {
    return option.value as SpreadTighteningDedupeMode;
  }

  throw new SpreadTighteningOptionsError(
    `Invalid dedupe-by from ${option.source}: expected none, ticker, or market, received ${String(option.value)}.`
  );
}

function readWindow(option: ResolvedOption, fallback: SpreadTighteningWindowOption): SpreadTighteningWindowOption {
  if (option.value === undefined) {
    return fallback;
  }
  if (option.value === "all" || option.value === "15m" || option.value === "30m" || option.value === "60m" || option.value === "240m") {
    return option.value;
  }

  throw new SpreadTighteningOptionsError(
    `Invalid window from ${option.source}: expected 15m, 30m, 60m, 240m, or all, received ${String(option.value)}.`
  );
}

function windowsForOption(window: SpreadTighteningWindowOption): ForwardReturnWindow[] {
  return window === "all" ? ALL_WINDOWS : [window];
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

function formatPercent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(2)}%`;
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
