import "./env";

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildMakerQuoteSimulationRow,
  dedupeMakerQuoteRows,
  rankMakerQuoteRows,
  summarizeMakerQuoteRows,
  type ForwardReturnWindow,
  type MakerQuoteDedupeMode,
  type MakerQuoteMode,
  type MakerQuoteSimulationRow,
  type MakerQuoteSortDirection,
  type MakerQuoteSortField
} from "@prediction-market-scanner/core";
import { Prisma, prisma } from "@prediction-market-scanner/db";

const DEFAULT_LIMIT = 50_000;
const DEFAULT_LOOKBACK_HOURS = 720;
const DEFAULT_MIN_AGE_MINUTES = 240;
const DEFAULT_WINDOW: ForwardReturnWindow = "240m";
const DEFAULT_MIN_ENTRY_SPREAD = 0.04;
const DEFAULT_MAX_ENTRY_SPREAD = 0.1;
const DEFAULT_QUOTE_MODE: MakerQuoteMode = "midpoint";
const DEFAULT_TICK_SIZE = 0.01;
const DEFAULT_DEDUPE_BY: MakerQuoteDedupeMode = "ticker";
const DEFAULT_SORT_BY: MakerQuoteSortField = "markout";
const DEFAULT_DIRECTION: MakerQuoteSortDirection = "desc";
const DEFAULT_TOP = 20;
const WINDOW_MINUTES: Record<ForwardReturnWindow, number> = {
  "15m": 15,
  "30m": 30,
  "60m": 60,
  "240m": 240
};

type PersistedSnapshot = Prisma.OrderbookSnapshotGetPayload<{ select: ReturnType<typeof snapshotSelect> }>;

interface MakerQuoteOptions {
  limit: number;
  lookbackHours: number;
  minAgeMinutes: number;
  window: ForwardReturnWindow;
  minEntrySpread: number;
  maxEntrySpread: number;
  quoteMode: MakerQuoteMode;
  tickSize: number;
  dedupeBy: MakerQuoteDedupeMode;
  sortBy: MakerQuoteSortField;
  direction: MakerQuoteSortDirection;
  top: number;
}

class MakerQuoteOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MakerQuoteOptionsError";
  }
}

async function main(): Promise<void> {
  const options = parseMakerQuoteOptions();
  const newestSnapshotAt = await readNewestSnapshotAt();
  const since = new Date(Date.now() - options.lookbackHours * 60 * 60 * 1000);
  const snapshotCapturedAtCutoff = new Date((newestSnapshotAt ?? new Date()).getTime() - options.minAgeMinutes * 60 * 1000);
  const snapshots = await readEntrySnapshots({ since, snapshotCapturedAtCutoff, limit: options.limit });
  const rows = await buildMakerQuoteRows(snapshots, options);

  console.log(
    formatMakerQuoteReport({
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

async function buildMakerQuoteRows(snapshots: PersistedSnapshot[], options: MakerQuoteOptions): Promise<MakerQuoteSimulationRow[]> {
  const rows: MakerQuoteSimulationRow[] = [];

  for (const snapshot of snapshots) {
    const entrySpread = spreadFromBidAsk(snapshot.bestYesBid, snapshot.bestYesAsk);
    if (entrySpread === null || entrySpread < options.minEntrySpread || entrySpread > options.maxEntrySpread) {
      continue;
    }

    const targetTime = new Date(snapshot.capturedAt.getTime() + WINDOW_MINUTES[options.window] * 60 * 1000);
    const futureSnapshot = await readFirstSnapshotAtOrAfter(snapshot.marketId, targetTime);
    if (!futureSnapshot) {
      continue;
    }

    const row = buildMakerQuoteSimulationRow({
      marketId: snapshot.marketId,
      ticker: snapshot.market.ticker,
      title: snapshot.market.title,
      capturedAt: snapshot.capturedAt,
      window: options.window,
      bestBid: snapshot.bestYesBid,
      bestAsk: snapshot.bestYesAsk,
      futureBestBid: futureSnapshot.bestYesBid,
      futureBestAsk: futureSnapshot.bestYesAsk,
      quoteMode: options.quoteMode,
      tickSize: options.tickSize
    });
    if (row) {
      rows.push(row);
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
    market: {
      select: {
        id: true,
        ticker: true,
        title: true
      }
    }
  } satisfies Prisma.OrderbookSnapshotSelect;
}

export function formatMakerQuoteReport(input: {
  options: MakerQuoteOptions;
  candidatesScanned: number;
  rows: MakerQuoteSimulationRow[];
}): string {
  const ranked = rankMakerQuoteRows(input.rows, input.options.sortBy, input.options.direction);
  const deduped = dedupeMakerQuoteRows(ranked, input.options.dedupeBy, input.options.sortBy, input.options.direction);
  const shown = deduped.slice(0, input.options.top);
  const summary = summarizeMakerQuoteRows(deduped);

  return [
    "Maker Quote Simulation Report",
    `Lookback hours: ${input.options.lookbackHours}`,
    `Minimum snapshot age minutes: ${input.options.minAgeMinutes}`,
    `Window: ${input.options.window}`,
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
    formatSummaryTable([summary.overall]),
    "",
    "By entry spread bucket:",
    formatBucketSummaryTable(summary.byEntrySpreadBucket),
    "",
    "Top examples:",
    formatTopExamples(shown)
  ].join("\n");
}

export function parseMakerQuoteOptions(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): MakerQuoteOptions {
  const args = parseArgs(argv);
  const positional = resolveMakerQuotePositionals(args.positional);
  const options = {
    limit: readPositiveInteger(resolveOption(args, "limit", positional.limit, env.RESEARCH_MAKER_QUOTE_LIMIT), "limit", DEFAULT_LIMIT),
    lookbackHours: readPositiveNumber(
      resolveOption(args, "lookback-hours", positional.lookbackHours, env.RESEARCH_MAKER_QUOTE_LOOKBACK_HOURS),
      "lookback-hours",
      DEFAULT_LOOKBACK_HOURS
    ),
    minAgeMinutes: readPositiveNumber(
      resolveOption(args, "min-age-minutes", positional.minAgeMinutes, env.RESEARCH_MAKER_QUOTE_MIN_AGE_MINUTES ?? env.RESEARCH_MIN_AGE_MINUTES),
      "min-age-minutes",
      DEFAULT_MIN_AGE_MINUTES
    ),
    window: readWindow(resolveOption(args, "window", positional.window, env.RESEARCH_MAKER_QUOTE_WINDOW), DEFAULT_WINDOW),
    minEntrySpread: readNonNegativeNumber(
      resolveOption(args, "min-entry-spread", positional.minEntrySpread, env.RESEARCH_MAKER_QUOTE_MIN_ENTRY_SPREAD),
      "min-entry-spread",
      DEFAULT_MIN_ENTRY_SPREAD
    ),
    maxEntrySpread: readNonNegativeNumber(
      resolveOption(args, "max-entry-spread", positional.maxEntrySpread, env.RESEARCH_MAKER_QUOTE_MAX_ENTRY_SPREAD),
      "max-entry-spread",
      DEFAULT_MAX_ENTRY_SPREAD
    ),
    quoteMode: readQuoteMode(resolveOption(args, "quote-mode", positional.quoteMode, env.RESEARCH_MAKER_QUOTE_MODE), DEFAULT_QUOTE_MODE),
    tickSize: readPositiveNumber(resolveOption(args, "tick-size", positional.tickSize, env.RESEARCH_MAKER_QUOTE_TICK_SIZE), "tick-size", DEFAULT_TICK_SIZE),
    dedupeBy: readDedupeMode(resolveOption(args, "dedupe-by", positional.dedupeBy, env.RESEARCH_MAKER_QUOTE_DEDUPE_BY), DEFAULT_DEDUPE_BY),
    sortBy: readSortField(resolveOption(args, "sort-by", positional.sortBy, env.RESEARCH_MAKER_QUOTE_SORT_BY), DEFAULT_SORT_BY),
    direction: readDirection(resolveOption(args, "direction", positional.direction, env.RESEARCH_MAKER_QUOTE_DIRECTION), DEFAULT_DIRECTION),
    top: readPositiveInteger(resolveOption(args, "top", positional.top, env.RESEARCH_MAKER_QUOTE_TOP), "top", DEFAULT_TOP)
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

interface MakerQuotePositionalOptions {
  limit?: string;
  lookbackHours?: string;
  minAgeMinutes?: string;
  window?: string;
  minEntrySpread?: string;
  maxEntrySpread?: string;
  quoteMode?: string;
  tickSize?: string;
  dedupeBy?: string;
  sortBy?: string;
  direction?: string;
  top?: string;
}

function resolveMakerQuotePositionals(positional: string[]): MakerQuotePositionalOptions {
  const resolved: MakerQuotePositionalOptions = {
    limit: positional[0],
    lookbackHours: positional[1],
    minAgeMinutes: positional[2],
    window: positional[3],
    minEntrySpread: positional[4],
    maxEntrySpread: positional[5],
    quoteMode: positional[6]
  };

  const optional = positional.slice(7);
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

function applyPostDedupePositionals(resolved: MakerQuotePositionalOptions, tokens: (string | undefined)[]): void {
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
    throw new MakerQuoteOptionsError(
      `Invalid positional argument after sort-by: expected direction asc|desc or top, received ${second}.`
    );
  }

  if (isNumericValue(next)) {
    resolved.top = next;
    return;
  }

  throw new MakerQuoteOptionsError(
    `Invalid positional argument after dedupe-by: expected sort-by markout|markoutPct|spreadChange|entrySpread or top, received ${next}.`
  );
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

  throw new MakerQuoteOptionsError(
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

  throw new MakerQuoteOptionsError(
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

  throw new MakerQuoteOptionsError(
    `Invalid ${optionName} from ${option.source}: expected a non-negative number, received ${String(option.value)}.`
  );
}

function readWindow(option: ResolvedOption, fallback: ForwardReturnWindow): ForwardReturnWindow {
  if (option.value === undefined) {
    return fallback;
  }
  if (option.value === "15m" || option.value === "30m" || option.value === "60m" || option.value === "240m") {
    return option.value;
  }

  throw new MakerQuoteOptionsError(
    `Invalid window from ${option.source}: expected 15m, 30m, 60m, or 240m, received ${String(option.value)}.`
  );
}

function readQuoteMode(option: ResolvedOption, fallback: MakerQuoteMode): MakerQuoteMode {
  if (option.value === undefined) {
    return fallback;
  }
  if (option.value === "midpoint" || option.value === "bid_plus_tick") {
    return option.value;
  }

  throw new MakerQuoteOptionsError(
    `Invalid quote-mode from ${option.source}: expected midpoint or bid_plus_tick, received ${String(option.value)}.`
  );
}

function readDedupeMode(option: ResolvedOption, fallback: MakerQuoteDedupeMode): MakerQuoteDedupeMode {
  if (option.value === undefined) {
    return fallback;
  }
  if (isDedupeModeValue(String(option.value))) {
    return String(option.value) as MakerQuoteDedupeMode;
  }

  throw new MakerQuoteOptionsError(
    `Invalid dedupe-by from ${option.source}: expected none, ticker, or market, received ${String(option.value)}.`
  );
}

function readSortField(option: ResolvedOption, fallback: MakerQuoteSortField): MakerQuoteSortField {
  if (option.value === undefined) {
    return fallback;
  }
  if (isSortFieldValue(String(option.value))) {
    return String(option.value) as MakerQuoteSortField;
  }

  throw new MakerQuoteOptionsError(
    `Invalid sort-by from ${option.source}: expected markout, markoutPct, spreadChange, or entrySpread, received ${String(option.value)}.`
  );
}

function readDirection(option: ResolvedOption, fallback: MakerQuoteSortDirection): MakerQuoteSortDirection {
  if (option.value === undefined) {
    return fallback;
  }
  if (isDirectionValue(String(option.value))) {
    return String(option.value) as MakerQuoteSortDirection;
  }

  throw new MakerQuoteOptionsError(
    `Invalid direction from ${option.source}: expected asc or desc, received ${String(option.value)}.`
  );
}

function isDedupeModeValue(value: string): value is MakerQuoteDedupeMode {
  return value === "none" || value === "ticker" || value === "market";
}

function isSortFieldValue(value: string): value is MakerQuoteSortField {
  return value === "markout" || value === "markoutPct" || value === "spreadChange" || value === "entrySpread";
}

function isDirectionValue(value: string): value is MakerQuoteSortDirection {
  return value === "asc" || value === "desc";
}

function isNumericValue(value: string): boolean {
  return value.trim() !== "" && Number.isFinite(Number(value));
}

function validateSpreadRange(minEntrySpread: number, maxEntrySpread: number): void {
  if (maxEntrySpread <= minEntrySpread) {
    throw new MakerQuoteOptionsError(
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

function formatSummaryTable(rows: ReturnType<typeof summarizeMakerQuoteRows>["byEntrySpreadBucket"] | ReturnType<typeof summarizeMakerQuoteRows>["overall"][]): string {
  return formatTable(
    [
      "count",
      "avgEntrySpread",
      "avgFutureSpread",
      "tightenRate",
      "avgQuotePrice",
      "avgFutureMidpoint",
      "avgMarkout",
      "avgMarkoutPct",
      "favorableRate"
    ],
    rows.map((row) => [
      String(row.count),
      formatNumber(row.avgEntrySpread),
      formatNumber(row.avgFutureSpread),
      formatPercent(row.tightenRate),
      formatNumber(row.avgQuotePrice),
      formatNumber(row.avgFutureMidpoint),
      formatNumber(row.avgMarkout),
      formatPercent(row.avgMarkoutPct),
      formatPercent(row.favorableRate)
    ])
  );
}

function formatBucketSummaryTable(rows: ReturnType<typeof summarizeMakerQuoteRows>["byEntrySpreadBucket"]): string {
  return formatTable(
    ["bucket", "count", "avgEntrySpread", "avgMarkout", "avgMarkoutPct", "favorableRate", "tightenRate"],
    rows.map((row) => [
      row.bucket,
      String(row.count),
      formatNumber(row.avgEntrySpread),
      formatNumber(row.avgMarkout),
      formatPercent(row.avgMarkoutPct),
      formatPercent(row.favorableRate),
      formatPercent(row.tightenRate)
    ])
  );
}

function formatTopExamples(rows: MakerQuoteSimulationRow[]): string {
  return formatTable(
    [
      "rank",
      "ticker",
      "capturedAt",
      "bestBid",
      "bestAsk",
      "quotePrice",
      "futureMidpoint",
      "markout",
      "markoutPct",
      "entrySpread",
      "futureSpread",
      "spreadChange",
      "title"
    ],
    rows.map((row, index) => [
      String(index + 1),
      row.ticker,
      row.capturedAt.toISOString(),
      formatNumber(row.bestBid),
      formatNumber(row.bestAsk),
      formatNumber(row.quotePrice),
      formatNumber(row.futureMidpoint),
      formatNumber(row.markout),
      formatPercent(row.markoutPct),
      formatNumber(row.entrySpread),
      formatNumber(row.futureSpread),
      formatNumber(row.spreadChange),
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
