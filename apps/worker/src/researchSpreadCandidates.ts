import "./env";

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildSpreadCandidateDiagnostics,
  buildSpreadTighteningRow,
  dedupeSpreadCandidates,
  extractSpreadCandidates,
  rankSpreadCandidates,
  type ForwardReturnWindow,
  type SpreadCandidateDedupeMode,
  type SpreadCandidateSortDirection,
  type SpreadCandidateSortField,
  type SpreadTighteningResearchRow,
  type SpreadTighteningSnapshotInput
} from "@prediction-market-scanner/core";
import { Prisma, prisma } from "@prediction-market-scanner/db";

const DEFAULT_LIMIT = 10_000;
const DEFAULT_LOOKBACK_HOURS = 720;
const DEFAULT_MIN_AGE_MINUTES = 240;
const DEFAULT_WINDOW: ForwardReturnWindow = "240m";
const DEFAULT_MIN_ENTRY_SPREAD = 0.02;
const DEFAULT_MAX_ENTRY_SPREAD = 0.1;
const DEFAULT_DEDUPE_BY: SpreadCandidateDedupeMode = "ticker";
const DEFAULT_SORT_BY: SpreadCandidateSortField = "spreadChange";
const DEFAULT_DIRECTION: SpreadCandidateSortDirection = "asc";
const DEFAULT_TOP = 20;
const WINDOW_MINUTES: Record<ForwardReturnWindow, number> = {
  "15m": 15,
  "30m": 30,
  "60m": 60,
  "240m": 240
};

type PersistedSnapshot = Prisma.OrderbookSnapshotGetPayload<{ select: ReturnType<typeof snapshotSelect> }>;

interface SpreadCandidateOptions {
  limit: number;
  lookbackHours: number;
  minAgeMinutes: number;
  window: ForwardReturnWindow;
  minEntrySpread: number;
  maxEntrySpread: number;
  dedupeBy: SpreadCandidateDedupeMode;
  sortBy: SpreadCandidateSortField;
  direction: SpreadCandidateSortDirection;
  top: number;
}

class SpreadCandidateOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpreadCandidateOptionsError";
  }
}

async function main(): Promise<void> {
  const options = parseSpreadCandidateOptions();
  const newestSnapshotAt = await readNewestSnapshotAt();
  const since = new Date(Date.now() - options.lookbackHours * 60 * 60 * 1000);
  const snapshotCapturedAtCutoff = new Date((newestSnapshotAt ?? new Date()).getTime() - options.minAgeMinutes * 60 * 1000);
  const snapshots = await readEntrySnapshots({ since, snapshotCapturedAtCutoff, limit: options.limit });
  const rows = await buildSpreadCandidateRows(snapshots, options.window);

  console.log(
    formatSpreadCandidateReport({
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

async function buildSpreadCandidateRows(snapshots: PersistedSnapshot[], window: ForwardReturnWindow): Promise<SpreadTighteningResearchRow[]> {
  const rows: SpreadTighteningResearchRow[] = [];

  for (const snapshot of snapshots) {
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

export function formatSpreadCandidateReport(input: {
  options: SpreadCandidateOptions;
  candidatesScanned: number;
  rows: SpreadTighteningResearchRow[];
}): string {
  const filtered = extractSpreadCandidates(input.rows, input.options);
  const ranked = rankSpreadCandidates(filtered, input.options.sortBy, input.options.direction);
  const deduped = dedupeSpreadCandidates(ranked, input.options.dedupeBy);
  const shown = deduped.slice(0, input.options.top);
  const diagnostics = buildSpreadCandidateDiagnostics(input.rows);

  return [
    "Spread Tightening Candidate Discovery Report",
    `Lookback hours: ${input.options.lookbackHours}`,
    `Minimum snapshot age minutes: ${input.options.minAgeMinutes}`,
    `Window: ${input.options.window}`,
    `Entry spread range: ${formatPlainNumber(input.options.minEntrySpread)} to ${formatPlainNumber(input.options.maxEntrySpread)}`,
    `Dedupe by: ${input.options.dedupeBy}`,
    `Sort: ${input.options.sortBy} ${input.options.direction}`,
    `Candidates scanned: ${input.candidatesScanned}`,
    `Candidates after filters: ${filtered.length}`,
    `Candidates after dedupe: ${deduped.length}`,
    `Candidates shown: ${shown.length}`,
    "",
    "Diagnostics:",
    `average entry spread: ${formatNumber(diagnostics.averageEntrySpread)}`,
    `average future spread: ${formatNumber(diagnostics.averageFutureSpread)}`,
    `average spread change: ${formatNumber(diagnostics.averageSpreadChange)}`,
    `tighten rate: ${formatPercent(diagnostics.tightenRate)}`,
    `count with missing future snapshot: ${diagnostics.missingFutureSnapshotCount}`,
    `strongest spread change found: ${formatNumber(diagnostics.strongestSpreadChangeFound)}`,
    "",
    "Candidates:",
    formatCandidateTable(shown)
  ].join("\n");
}

export function parseSpreadCandidateOptions(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): SpreadCandidateOptions {
  const args = parseArgs(argv);
  const positional = resolveSpreadCandidatePositionals(args.positional);
  const options = {
    limit: readPositiveInteger(resolveOption(args, "limit", positional.limit, env.RESEARCH_SPREAD_CANDIDATE_LIMIT), "limit", DEFAULT_LIMIT),
    lookbackHours: readPositiveNumber(
      resolveOption(args, "lookback-hours", positional.lookbackHours, env.RESEARCH_SPREAD_CANDIDATE_LOOKBACK_HOURS),
      "lookback-hours",
      DEFAULT_LOOKBACK_HOURS
    ),
    minAgeMinutes: readNonNegativeNumber(
      resolveOption(
        args,
        "min-age-minutes",
        positional.minAgeMinutes,
        env.RESEARCH_SPREAD_CANDIDATE_MIN_AGE_MINUTES ?? env.RESEARCH_MIN_AGE_MINUTES
      ),
      "min-age-minutes",
      DEFAULT_MIN_AGE_MINUTES
    ),
    window: readWindow(resolveOption(args, "window", positional.window, env.RESEARCH_SPREAD_CANDIDATE_WINDOW), DEFAULT_WINDOW),
    minEntrySpread: readNonNegativeNumber(
      resolveOption(args, "min-entry-spread", positional.minEntrySpread, env.RESEARCH_SPREAD_CANDIDATE_MIN_ENTRY_SPREAD),
      "min-entry-spread",
      DEFAULT_MIN_ENTRY_SPREAD
    ),
    maxEntrySpread: readNonNegativeNumber(
      resolveOption(args, "max-entry-spread", positional.maxEntrySpread, env.RESEARCH_SPREAD_CANDIDATE_MAX_ENTRY_SPREAD),
      "max-entry-spread",
      DEFAULT_MAX_ENTRY_SPREAD
    ),
    dedupeBy: readDedupeMode(resolveOption(args, "dedupe-by", positional.dedupeBy, env.RESEARCH_SPREAD_CANDIDATE_DEDUPE_BY), DEFAULT_DEDUPE_BY),
    sortBy: readSortField(resolveOption(args, "sort-by", positional.sortBy, env.RESEARCH_SPREAD_CANDIDATE_SORT_BY), DEFAULT_SORT_BY),
    direction: readDirection(resolveOption(args, "direction", positional.direction, env.RESEARCH_SPREAD_CANDIDATE_DIRECTION), DEFAULT_DIRECTION),
    top: readPositiveInteger(resolveOption(args, "top", positional.top, env.RESEARCH_SPREAD_CANDIDATE_TOP), "top", DEFAULT_TOP)
  };
  validateSpreadRange(options.minEntrySpread, options.maxEntrySpread);
  return options;
}

function formatCandidateTable(rows: SpreadTighteningResearchRow[]): string {
  return formatTable(
    ["rank", "ticker", "capturedAt", "entrySpread", "futureSpread", "spreadChange", "tightenPct", "window", "title"],
    rows.map((row, index) => [
      String(index + 1),
      row.ticker,
      row.detectedAt.toISOString(),
      formatNumber(row.entrySpread),
      formatNumber(row.futureSpread),
      formatNumber(row.spreadChange),
      formatPercent(row.spreadChangePct),
      row.window,
      truncateTitle(row.title)
    ])
  );
}

interface ParsedArgs {
  named: Record<string, string | boolean>;
  positional: string[];
}

interface ResolvedOption {
  value: string | boolean | undefined;
  source: "named flag" | "positional argument" | "environment variable" | "default";
}

interface SpreadCandidatePositionalOptions {
  limit?: string;
  lookbackHours?: string;
  minAgeMinutes?: string;
  window?: string;
  minEntrySpread?: string;
  maxEntrySpread?: string;
  dedupeBy?: string;
  sortBy?: string;
  direction?: string;
  top?: string;
}

function resolveSpreadCandidatePositionals(positional: string[]): SpreadCandidatePositionalOptions {
  const resolved: SpreadCandidatePositionalOptions = {
    limit: positional[0],
    lookbackHours: positional[1],
    minAgeMinutes: positional[2],
    window: positional[3],
    minEntrySpread: positional[4],
    maxEntrySpread: positional[5],
    dedupeBy: positional[6]
  };
  const optional = positional.slice(7);
  if (optional.length === 1) {
    resolved.top = optional[0];
    return resolved;
  }
  if (optional.length >= 3) {
    resolved.sortBy = optional[0];
    resolved.direction = optional[1];
    resolved.top = optional[2];
    return resolved;
  }
  if (optional.length === 2) {
    resolved.sortBy = optional[0];
    resolved.top = optional[1];
  }
  return resolved;
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

  throw new SpreadCandidateOptionsError(
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

  throw new SpreadCandidateOptionsError(
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

  throw new SpreadCandidateOptionsError(
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

  throw new SpreadCandidateOptionsError(
    `Invalid window from ${option.source}: expected 15m, 30m, 60m, or 240m, received ${String(option.value)}.`
  );
}

function readDedupeMode(option: ResolvedOption, fallback: SpreadCandidateDedupeMode): SpreadCandidateDedupeMode {
  if (option.value === undefined) {
    return fallback;
  }
  if (option.value === "none" || option.value === "ticker" || option.value === "market") {
    return option.value;
  }

  throw new SpreadCandidateOptionsError(
    `Invalid dedupe-by from ${option.source}: expected none, ticker, or market, received ${String(option.value)}.`
  );
}

function readSortField(option: ResolvedOption, fallback: SpreadCandidateSortField): SpreadCandidateSortField {
  if (option.value === undefined) {
    return fallback;
  }
  if (option.value === "spreadChange" || option.value === "tightenPct" || option.value === "entrySpread" || option.value === "futureSpread") {
    return option.value;
  }

  throw new SpreadCandidateOptionsError(
    `Invalid sort-by from ${option.source}: expected spreadChange, tightenPct, entrySpread, or futureSpread, received ${String(option.value)}.`
  );
}

function readDirection(option: ResolvedOption, fallback: SpreadCandidateSortDirection): SpreadCandidateSortDirection {
  if (option.value === undefined) {
    return fallback;
  }
  if (option.value === "asc" || option.value === "desc") {
    return option.value;
  }

  throw new SpreadCandidateOptionsError(
    `Invalid direction from ${option.source}: expected asc or desc, received ${String(option.value)}.`
  );
}

function validateSpreadRange(minEntrySpread: number, maxEntrySpread: number): void {
  if (maxEntrySpread <= minEntrySpread) {
    throw new SpreadCandidateOptionsError(
      `Invalid entry spread range: max-entry-spread must be greater than min-entry-spread, received ${maxEntrySpread} <= ${minEntrySpread}.`
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
