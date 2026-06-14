import "./env";

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildFillProxyRow,
  buildMakerQuoteSimulationRow,
  dedupeFillProxyRows,
  rankFillProxyRows,
  summarizeFillProxyRows,
  type FillProxyRow,
  type FillProxySortField,
  type ForwardReturnWindow,
  type MakerQuoteDedupeMode,
  type MakerQuoteMode,
  type MakerQuoteSortDirection
} from "@prediction-market-scanner/core";
import { Prisma, prisma } from "@prediction-market-scanner/db";

const DEFAULT_LIMIT = 50_000;
const DEFAULT_LOOKBACK_HOURS = 720;
const DEFAULT_MIN_AGE_MINUTES = 240;
type FillProxyWindow = "5m" | ForwardReturnWindow;
const DEFAULT_MARKOUT_WINDOW: ForwardReturnWindow = "240m";
const DEFAULT_FILL_WINDOW: FillProxyWindow = "60m";
const DEFAULT_MIN_ENTRY_SPREAD = 0.04;
const DEFAULT_MAX_ENTRY_SPREAD = 0.1;
const DEFAULT_QUOTE_MODE: MakerQuoteMode = "bid_plus_tick";
const DEFAULT_TICK_SIZE = 0.01;
const DEFAULT_DEDUPE_BY: MakerQuoteDedupeMode = "ticker";
const DEFAULT_SORT_BY: FillProxySortField = "markout";
const DEFAULT_DIRECTION: MakerQuoteSortDirection = "desc";
const DEFAULT_TOP = 20;
const WINDOW_MINUTES: Record<FillProxyWindow, number> = {
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "60m": 60,
  "240m": 240
};

type PersistedSnapshot = Prisma.OrderbookSnapshotGetPayload<{ select: ReturnType<typeof snapshotSelect> }>;

export interface FillProxyOptions {
  limit: number;
  lookbackHours: number;
  minAgeMinutes: number;
  markoutWindow: ForwardReturnWindow;
  fillWindow: FillProxyWindow;
  minEntrySpread: number;
  maxEntrySpread: number;
  quoteMode: MakerQuoteMode;
  tickSize: number;
  dedupeBy: MakerQuoteDedupeMode;
  sortBy: FillProxySortField;
  direction: MakerQuoteSortDirection;
  top: number;
}

class FillProxyOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FillProxyOptionsError";
  }
}

async function main(): Promise<void> {
  const options = parseFillProxyOptions();
  const newestSnapshotAt = await readNewestSnapshotAt();
  const since = new Date(Date.now() - options.lookbackHours * 60 * 60 * 1000);
  const snapshotCapturedAtCutoff = new Date((newestSnapshotAt ?? new Date()).getTime() - options.minAgeMinutes * 60 * 1000);
  const snapshots = await readEntrySnapshots({ since, snapshotCapturedAtCutoff, limit: options.limit });
  const rows = await buildFillProxyRows(snapshots, options);

  console.log(
    formatFillProxyReport({
      options,
      candidatesScanned: snapshots.length,
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

async function buildFillProxyRows(snapshots: PersistedSnapshot[], options: FillProxyOptions): Promise<FillProxyRow[]> {
  const rows: FillProxyRow[] = [];

  for (const snapshot of snapshots) {
    const entrySpread = spreadFromBidAsk(snapshot.bestYesBid, snapshot.bestYesAsk);
    if (entrySpread === null || entrySpread < options.minEntrySpread || entrySpread > options.maxEntrySpread) {
      continue;
    }

    const markoutTargetTime = new Date(snapshot.capturedAt.getTime() + WINDOW_MINUTES[options.markoutWindow] * 60 * 1000);
    const markoutSnapshot = await readFirstSnapshotAtOrAfter(snapshot.marketId, markoutTargetTime);
    if (!markoutSnapshot) {
      continue;
    }

    const simulationRow = buildMakerQuoteSimulationRow({
      marketId: snapshot.marketId,
      ticker: snapshot.market.ticker,
      title: snapshot.market.title,
      capturedAt: snapshot.capturedAt,
      window: options.markoutWindow,
      bestBid: snapshot.bestYesBid,
      bestAsk: snapshot.bestYesAsk,
      futureBestBid: markoutSnapshot.bestYesBid,
      futureBestAsk: markoutSnapshot.bestYesAsk,
      quoteMode: options.quoteMode,
      tickSize: options.tickSize
    });
    if (!simulationRow) {
      continue;
    }

    const fillWindowEnd = new Date(snapshot.capturedAt.getTime() + WINDOW_MINUTES[options.fillWindow] * 60 * 1000);
    const fillSnapshots = await readSnapshotsAfterUntil(snapshot.marketId, snapshot.capturedAt, fillWindowEnd);
    rows.push(buildFillProxyRow(simulationRow, fillSnapshots));
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

function readSnapshotsAfterUntil(marketId: string, entryTime: Date, fillWindowEnd: Date) {
  return prisma.orderbookSnapshot.findMany({
    where: {
      marketId,
      capturedAt: {
        gt: entryTime,
        lte: fillWindowEnd
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
    market: {
      select: {
        id: true,
        ticker: true,
        title: true
      }
    }
  } satisfies Prisma.OrderbookSnapshotSelect;
}

export function formatFillProxyReport(input: {
  options: FillProxyOptions;
  candidatesScanned: number;
  rows: FillProxyRow[];
}): string {
  const ranked = rankFillProxyRows(input.rows, input.options.sortBy, input.options.direction);
  const deduped = dedupeFillProxyRows(ranked, input.options.dedupeBy, input.options.sortBy, input.options.direction);
  const shown = deduped.slice(0, input.options.top);
  const summary = summarizeFillProxyRows(deduped);

  return [
    "Fill Proxy Research Report",
    `Lookback hours: ${input.options.lookbackHours}`,
    `Markout window: ${input.options.markoutWindow}`,
    `Fill window: ${input.options.fillWindow}`,
    `Entry spread range: ${formatPlainNumber(input.options.minEntrySpread)} to ${formatPlainNumber(input.options.maxEntrySpread)}`,
    `Quote mode: ${input.options.quoteMode}`,
    `Tick size: ${formatPlainNumber(input.options.tickSize)}`,
    `Dedupe by: ${input.options.dedupeBy}`,
    `Sort: ${input.options.sortBy} ${input.options.direction}`,
    `Candidates scanned: ${input.candidatesScanned}`,
    `Candidates after filters: ${input.rows.length}`,
    `Candidates after dedupe: ${deduped.length}`,
    "",
    "Overall:",
    formatOverallSummaryTable([summary.overall]),
    "",
    "By entry spread bucket:",
    formatBucketSummaryTable(summary.byEntrySpreadBucket),
    "",
    "Top examples:",
    formatTopExamples(shown)
  ].join("\n");
}

export function parseFillProxyOptions(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): FillProxyOptions {
  const args = parseArgs(argv);
  const positional = resolveFillProxyPositionals(args.positional);
  const options = {
    limit: readPositiveInteger(resolveOption(args, "limit", positional.limit, env.RESEARCH_FILL_PROXY_LIMIT), "limit", DEFAULT_LIMIT),
    lookbackHours: readPositiveNumber(
      resolveOption(args, "lookback-hours", positional.lookbackHours, env.RESEARCH_FILL_PROXY_LOOKBACK_HOURS),
      "lookback-hours",
      DEFAULT_LOOKBACK_HOURS
    ),
    minAgeMinutes: readPositiveNumber(
      resolveOption(args, "min-age-minutes", positional.minAgeMinutes, env.RESEARCH_FILL_PROXY_MIN_AGE_MINUTES ?? env.RESEARCH_MIN_AGE_MINUTES),
      "min-age-minutes",
      DEFAULT_MIN_AGE_MINUTES
    ),
    markoutWindow: readMarkoutWindow(resolveOption(args, "markout-window", positional.markoutWindow, env.RESEARCH_FILL_PROXY_MARKOUT_WINDOW), DEFAULT_MARKOUT_WINDOW),
    fillWindow: readFillWindow(resolveOption(args, "fill-window", positional.fillWindow, env.RESEARCH_FILL_PROXY_FILL_WINDOW), DEFAULT_FILL_WINDOW),
    minEntrySpread: readNonNegativeNumber(
      resolveOption(args, "min-entry-spread", positional.minEntrySpread, env.RESEARCH_FILL_PROXY_MIN_ENTRY_SPREAD),
      "min-entry-spread",
      DEFAULT_MIN_ENTRY_SPREAD
    ),
    maxEntrySpread: readNonNegativeNumber(
      resolveOption(args, "max-entry-spread", positional.maxEntrySpread, env.RESEARCH_FILL_PROXY_MAX_ENTRY_SPREAD),
      "max-entry-spread",
      DEFAULT_MAX_ENTRY_SPREAD
    ),
    quoteMode: readQuoteMode(resolveOption(args, "quote-mode", positional.quoteMode, env.RESEARCH_FILL_PROXY_QUOTE_MODE), DEFAULT_QUOTE_MODE),
    tickSize: readPositiveNumber(resolveOption(args, "tick-size", positional.tickSize, env.RESEARCH_FILL_PROXY_TICK_SIZE), "tick-size", DEFAULT_TICK_SIZE),
    dedupeBy: readDedupeMode(resolveOption(args, "dedupe-by", positional.dedupeBy, env.RESEARCH_FILL_PROXY_DEDUPE_BY), DEFAULT_DEDUPE_BY),
    sortBy: readSortField(resolveOption(args, "sort-by", positional.sortBy, env.RESEARCH_FILL_PROXY_SORT_BY), DEFAULT_SORT_BY),
    direction: readDirection(resolveOption(args, "direction", positional.direction, env.RESEARCH_FILL_PROXY_DIRECTION), DEFAULT_DIRECTION),
    top: readPositiveInteger(resolveOption(args, "top", positional.top, env.RESEARCH_FILL_PROXY_TOP), "top", DEFAULT_TOP)
  };
  validateSpreadRange(options.minEntrySpread, options.maxEntrySpread);
  return options;
}

interface ParsedArgs {
  named: Record<string, string | boolean>;
  positional: string[];
}

interface ResolvedOption {
  value: string | boolean | undefined;
  source: "named flag" | "positional argument" | "environment variable" | "default";
}

interface FillProxyPositionalOptions {
  limit?: string;
  lookbackHours?: string;
  minAgeMinutes?: string;
  markoutWindow?: string;
  fillWindow?: string;
  minEntrySpread?: string;
  maxEntrySpread?: string;
  quoteMode?: string;
  tickSize?: string;
  dedupeBy?: string;
  sortBy?: string;
  direction?: string;
  top?: string;
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

function resolveFillProxyPositionals(positional: string[]): FillProxyPositionalOptions {
  const resolved: FillProxyPositionalOptions = {
    limit: positional[0],
    lookbackHours: positional[1],
    minAgeMinutes: positional[2],
    markoutWindow: positional[3],
    fillWindow: positional[4],
    minEntrySpread: positional[5],
    maxEntrySpread: positional[6],
    quoteMode: positional[7]
  };

  const optional = positional.slice(8);
  if (optional.length === 0) {
    return resolved;
  }

  const [first, second, third, fourth, fifth] = optional;
  if (isDedupeModeValue(first)) {
    resolved.dedupeBy = first;
    applyPostDedupePositionals(resolved, [second, third, fourth]);
    return resolved;
  }

  resolved.tickSize = first;
  resolved.dedupeBy = second;
  applyPostDedupePositionals(resolved, [third, fourth, fifth]);
  return resolved;
}

function applyPostDedupePositionals(resolved: FillProxyPositionalOptions, tokens: (string | undefined)[]): void {
  const [next, second, third] = tokens;
  if (next === undefined) {
    return;
  }

  if (isSortFieldValue(next)) {
    resolved.sortBy = next;
    if (second === undefined) {
      return;
    }
    if (isDirectionValue(second)) {
      resolved.direction = second;
      resolved.top = third;
      return;
    }
    if (isNumericValue(second)) {
      resolved.top = second;
      return;
    }
    throw new FillProxyOptionsError(`Invalid positional argument after sort-by: expected direction asc|desc or top, received ${second}.`);
  }

  if (isNumericValue(next)) {
    resolved.top = next;
    return;
  }

  throw new FillProxyOptionsError(
    `Invalid positional argument after dedupe-by: expected sort-by markout|markoutPct|timeToFill|quotePrice or top, received ${next}.`
  );
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

  throw new FillProxyOptionsError(`Invalid ${optionName} from ${option.source}: expected a positive integer, received ${String(option.value)}.`);
}

function readPositiveNumber(option: ResolvedOption, optionName: string, fallback: number): number {
  if (option.value === undefined) {
    return fallback;
  }

  const parsed = typeof option.value === "boolean" ? Number.NaN : Number(option.value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  throw new FillProxyOptionsError(`Invalid ${optionName} from ${option.source}: expected a positive number, received ${String(option.value)}.`);
}

function readNonNegativeNumber(option: ResolvedOption, optionName: string, fallback: number): number {
  if (option.value === undefined) {
    return fallback;
  }

  const parsed = typeof option.value === "boolean" ? Number.NaN : Number(option.value);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed;
  }

  throw new FillProxyOptionsError(`Invalid ${optionName} from ${option.source}: expected a non-negative number, received ${String(option.value)}.`);
}

function readMarkoutWindow(option: ResolvedOption, fallback: ForwardReturnWindow): ForwardReturnWindow {
  if (option.value === undefined) {
    return fallback;
  }
  if (option.value === "15m" || option.value === "30m" || option.value === "60m" || option.value === "240m") {
    return option.value;
  }

  throw new FillProxyOptionsError(`Invalid markout-window from ${option.source}: expected 15m, 30m, 60m, or 240m, received ${String(option.value)}.`);
}

function readFillWindow(option: ResolvedOption, fallback: FillProxyWindow): FillProxyWindow {
  if (option.value === undefined) {
    return fallback;
  }
  if (option.value === "5m" || option.value === "15m" || option.value === "30m" || option.value === "60m" || option.value === "240m") {
    return option.value;
  }

  throw new FillProxyOptionsError(`Invalid fill-window from ${option.source}: expected 5m, 15m, 30m, 60m, or 240m, received ${String(option.value)}.`);
}

function readQuoteMode(option: ResolvedOption, fallback: MakerQuoteMode): MakerQuoteMode {
  if (option.value === undefined) {
    return fallback;
  }
  if (option.value === "midpoint" || option.value === "bid_plus_tick") {
    return option.value;
  }

  throw new FillProxyOptionsError(`Invalid quote-mode from ${option.source}: expected midpoint or bid_plus_tick, received ${String(option.value)}.`);
}

function readDedupeMode(option: ResolvedOption, fallback: MakerQuoteDedupeMode): MakerQuoteDedupeMode {
  if (option.value === undefined) {
    return fallback;
  }
  if (isDedupeModeValue(String(option.value))) {
    return String(option.value) as MakerQuoteDedupeMode;
  }

  throw new FillProxyOptionsError(`Invalid dedupe-by from ${option.source}: expected none, ticker, or market, received ${String(option.value)}.`);
}

function readSortField(option: ResolvedOption, fallback: FillProxySortField): FillProxySortField {
  if (option.value === undefined) {
    return fallback;
  }
  if (isSortFieldValue(String(option.value))) {
    return String(option.value) as FillProxySortField;
  }

  throw new FillProxyOptionsError(`Invalid sort-by from ${option.source}: expected markout, markoutPct, timeToFill, or quotePrice, received ${String(option.value)}.`);
}

function readDirection(option: ResolvedOption, fallback: MakerQuoteSortDirection): MakerQuoteSortDirection {
  if (option.value === undefined) {
    return fallback;
  }
  if (isDirectionValue(String(option.value))) {
    return String(option.value) as MakerQuoteSortDirection;
  }

  throw new FillProxyOptionsError(`Invalid direction from ${option.source}: expected asc or desc, received ${String(option.value)}.`);
}

function isDedupeModeValue(value: string | undefined): value is MakerQuoteDedupeMode {
  return value === "none" || value === "ticker" || value === "market";
}

function isSortFieldValue(value: string): value is FillProxySortField {
  return value === "markout" || value === "markoutPct" || value === "timeToFill" || value === "quotePrice";
}

function isDirectionValue(value: string): value is MakerQuoteSortDirection {
  return value === "asc" || value === "desc";
}

function isNumericValue(value: string): boolean {
  return value.trim() !== "" && Number.isFinite(Number(value));
}

function validateSpreadRange(minEntrySpread: number, maxEntrySpread: number): void {
  if (maxEntrySpread <= minEntrySpread) {
    throw new FillProxyOptionsError(
      `Invalid entry spread range: max-entry-spread must be greater than min-entry-spread, received ${maxEntrySpread} <= ${minEntrySpread}.`
    );
  }
}

function spreadFromBidAsk(bid: unknown, ask: unknown): number | null {
  const bidValue = toFiniteNumber(bid);
  const askValue = toFiniteNumber(ask);
  if (bidValue === null || askValue === null || askValue < bidValue) {
    return null;
  }
  return roundResearchNumber(askValue - bidValue);
}

function formatOverallSummaryTable(rows: ReturnType<typeof summarizeFillProxyRows>["overall"][]): string {
  return formatTable(
    [
      "count",
      "possibleFillRate",
      "avgTimeToFillMinutes",
      "favorableRate",
      "favorableIfFillableRate",
      "avgMarkout",
      "avgMarkoutPct",
      "avgFillableMarkout",
      "avgFillableMarkoutPct"
    ],
    rows.map((row) => [
      String(row.count),
      formatPercent(row.possibleFillRate),
      formatNumber(row.avgTimeToFillMinutes),
      formatPercent(row.favorableRate),
      formatPercent(row.favorableIfFillableRate),
      formatNumber(row.avgMarkout),
      formatPercent(row.avgMarkoutPct),
      formatNumber(row.avgFillableMarkout),
      formatPercent(row.avgFillableMarkoutPct)
    ])
  );
}

function formatBucketSummaryTable(rows: ReturnType<typeof summarizeFillProxyRows>["byEntrySpreadBucket"]): string {
  return formatTable(
    ["bucket", "count", "possibleFillRate", "favorableIfFillableRate", "avgFillableMarkoutPct"],
    rows.map((row) => [
      row.bucket,
      String(row.count),
      formatPercent(row.possibleFillRate),
      formatPercent(row.favorableIfFillableRate),
      formatPercent(row.avgFillableMarkoutPct)
    ])
  );
}

function formatTopExamples(rows: FillProxyRow[]): string {
  return formatTable(
    [
      "rank",
      "ticker",
      "capturedAt",
      "quotePrice",
      "firstFillAt",
      "timeToFillMinutes",
      "futureMidpoint",
      "markout",
      "markoutPct",
      "possibleFill",
      "title"
    ],
    rows.map((row, index) => [
      String(index + 1),
      row.ticker,
      row.capturedAt.toISOString(),
      formatNumber(row.quotePrice),
      row.firstFillAt ? row.firstFillAt.toISOString() : "n/a",
      formatNumber(row.timeToFillMinutes),
      formatNumber(row.futureMidpoint),
      formatNumber(row.markout),
      formatPercent(row.markoutPct),
      String(row.possibleFill),
      truncateTitle(row.title)
    ])
  );
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

function formatPercent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(2)}%`;
}

function truncateTitle(value: string | null | undefined): string {
  if (!value) {
    return "";
  }
  return value.length <= 80 ? value : `${value.slice(0, 77)}...`;
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

function roundResearchNumber(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
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
