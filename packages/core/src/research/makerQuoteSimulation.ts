import type { ForwardReturnWindow } from "../types";
import { classifySpreadBucket, computeSpreadChange, type SpreadTighteningBucket } from "./spreadTightening";

export type MakerQuoteNumeric = number | string | { toNumber(): number };
export type MakerQuoteMode = "midpoint" | "bid_plus_tick";
export type MakerQuoteDedupeMode = "none" | "ticker" | "market";
export type MakerQuoteSortField = "markout" | "markoutPct" | "spreadChange" | "entrySpread";
export type MakerQuoteSortDirection = "asc" | "desc";
export type FillProxySortField = "markout" | "markoutPct" | "timeToFill" | "quotePrice";
export const QUOTE_SWEEP_LEVELS = ["bid_plus_1_tick", "bid_plus_2_ticks", "bid_plus_3_ticks", "midpoint", "ask_minus_1_tick"] as const;
export type QuoteSweepLevel = (typeof QUOTE_SWEEP_LEVELS)[number];

export interface FillProxySnapshot {
  capturedAt: Date | string;
  bestYesAsk?: MakerQuoteNumeric | null;
}

export interface MakerQuoteSimulationRow {
  marketId: string;
  ticker: string;
  title?: string | null;
  capturedAt: Date;
  window: ForwardReturnWindow;
  bestBid: number;
  bestAsk: number;
  quotePrice: number;
  futureMidpoint: number;
  markout: number;
  markoutPct: number | null;
  favorable: boolean;
  entrySpread: number;
  futureSpread: number;
  spreadChange: number;
  tightened: boolean;
  bucket: SpreadTighteningBucket;
}

export interface MakerQuoteSummaryRow {
  count: number;
  avgEntrySpread: number | null;
  avgFutureSpread: number | null;
  tightenRate: number | null;
  avgQuotePrice: number | null;
  avgFutureMidpoint: number | null;
  avgMarkout: number | null;
  avgMarkoutPct: number | null;
  favorableRate: number | null;
}

export interface MakerQuoteBucketSummaryRow extends MakerQuoteSummaryRow {
  bucket: SpreadTighteningBucket;
}

export interface MakerQuoteSummary {
  overall: MakerQuoteSummaryRow;
  byEntrySpreadBucket: MakerQuoteBucketSummaryRow[];
}

export interface FillProxyRow extends MakerQuoteSimulationRow {
  firstFillAt: Date | null;
  timeToFillMinutes: number | null;
  possibleFill: boolean;
}

export interface FillProxySummaryRow {
  count: number;
  possibleFillRate: number | null;
  avgTimeToFillMinutes: number | null;
  favorableRate: number | null;
  favorableIfFillableRate: number | null;
  avgMarkout: number | null;
  avgMarkoutPct: number | null;
  avgFillableMarkout: number | null;
  avgFillableMarkoutPct: number | null;
  fillableCount: number;
  favorableFillableCount: number;
  unfillableFavorableCount: number;
}

export interface FillProxyBucketSummaryRow {
  bucket: SpreadTighteningBucket;
  count: number;
  possibleFillRate: number | null;
  favorableIfFillableRate: number | null;
  avgFillableMarkoutPct: number | null;
}

export interface FillProxySummary {
  overall: FillProxySummaryRow;
  byEntrySpreadBucket: FillProxyBucketSummaryRow[];
}

export interface QuoteSweepRow {
  marketId: string;
  ticker: string;
  title?: string | null;
  capturedAt: Date;
  window: ForwardReturnWindow;
  quoteLevel: QuoteSweepLevel;
  bestBid: number;
  bestAsk: number;
  quotePrice: number | null;
  futureMidpoint: number;
  markout: number | null;
  markoutPct: number | null;
  favorable: boolean | null;
  entrySpread: number;
  futureSpread: number;
  spreadChange: number;
  tightened: boolean;
  bucket: SpreadTighteningBucket;
  firstFillAt: Date | null;
  timeToFillMinutes: number | null;
  possibleFill: boolean;
  skipped: boolean;
}

export interface QuoteSweepSummaryRow {
  quoteLevel: QuoteSweepLevel;
  count: number;
  possibleFillRate: number | null;
  avgTimeToFillMinutes: number | null;
  favorableRate: number | null;
  favorableIfFillableRate: number | null;
  avgMarkout: number | null;
  avgMarkoutPct: number | null;
  avgFillableMarkout: number | null;
  avgFillableMarkoutPct: number | null;
  skippedCount: number;
}

export function computeMidpoint(bestBid: MakerQuoteNumeric | null | undefined, bestAsk: MakerQuoteNumeric | null | undefined): number | null {
  const bid = toFiniteNumber(bestBid);
  const ask = toFiniteNumber(bestAsk);
  if (bid === null || ask === null || ask < bid) {
    return null;
  }
  return roundResearchNumber((bid + ask) / 2);
}

export function computeSimulatedQuote(
  bestBid: MakerQuoteNumeric | null | undefined,
  bestAsk: MakerQuoteNumeric | null | undefined,
  mode: MakerQuoteMode,
  tickSize = 0.01
): number | null {
  const bid = toFiniteNumber(bestBid);
  const ask = toFiniteNumber(bestAsk);
  const tick = toFiniteNumber(tickSize);
  if (bid === null || ask === null || ask < bid) {
    return null;
  }

  if (mode === "midpoint") {
    return computeMidpoint(bid, ask);
  }
  if (mode === "bid_plus_tick") {
    if (tick === null || tick <= 0) {
      return null;
    }
    return roundResearchNumber(Math.min(bid + tick, ask));
  }

  assertNever(mode);
}

export function computeQuoteForLevel(
  bestBid: MakerQuoteNumeric | null | undefined,
  bestAsk: MakerQuoteNumeric | null | undefined,
  level: QuoteSweepLevel,
  tickSize = 0.01
): number | null {
  const bid = toFiniteNumber(bestBid);
  const ask = toFiniteNumber(bestAsk);
  const tick = toFiniteNumber(tickSize);
  if (bid === null || ask === null || ask < bid || tick === null || tick <= 0) {
    return null;
  }

  let quotePrice: number;
  if (level === "bid_plus_1_tick") {
    quotePrice = bid + tick;
  } else if (level === "bid_plus_2_ticks") {
    quotePrice = bid + tick * 2;
  } else if (level === "bid_plus_3_ticks") {
    quotePrice = bid + tick * 3;
  } else if (level === "midpoint") {
    quotePrice = (bid + ask) / 2;
  } else if (level === "ask_minus_1_tick") {
    quotePrice = ask - tick;
  } else {
    assertNever(level);
  }

  const rounded = roundResearchNumber(quotePrice);
  if (rounded < bid || rounded > ask) {
    return null;
  }
  return rounded;
}

export function computeMarkout(
  simulatedPrice: MakerQuoteNumeric | null | undefined,
  futureMidpoint: MakerQuoteNumeric | null | undefined
): { markout: number | null; markoutPct: number | null; favorable: boolean | null } {
  const price = toFiniteNumber(simulatedPrice);
  const future = toFiniteNumber(futureMidpoint);
  if (price === null || future === null) {
    return { markout: null, markoutPct: null, favorable: null };
  }

  const markout = roundResearchNumber(future - price);
  return {
    markout,
    markoutPct: price === 0 ? null : roundResearchNumber(markout / price),
    favorable: markout > 0
  };
}

export function computePossibleFillByAsk(
  quotePrice: MakerQuoteNumeric | null | undefined,
  futureSnapshots: FillProxySnapshot[]
): { possibleFill: boolean; firstFillSnapshotTime: Date | null } {
  const quote = toFiniteNumber(quotePrice);
  if (quote === null) {
    return { possibleFill: false, firstFillSnapshotTime: null };
  }

  const firstFillSnapshot = [...futureSnapshots]
    .sort((left, right) => coerceDate(left.capturedAt).getTime() - coerceDate(right.capturedAt).getTime())
    .find((snapshot) => {
      const ask = toFiniteNumber(snapshot.bestYesAsk);
      return ask !== null && ask <= quote;
    });

  return {
    possibleFill: firstFillSnapshot !== undefined,
    firstFillSnapshotTime: firstFillSnapshot ? coerceDate(firstFillSnapshot.capturedAt) : null
  };
}

export function computeTimeToPossibleFill(entryTime: Date | string, firstFillSnapshotTime: Date | string | null | undefined): number | null {
  if (!firstFillSnapshotTime) {
    return null;
  }
  const minutes = (coerceDate(firstFillSnapshotTime).getTime() - coerceDate(entryTime).getTime()) / 60_000;
  return Number.isFinite(minutes) && minutes >= 0 ? roundResearchNumber(minutes) : null;
}

export function buildMakerQuoteSimulationRow(input: {
  marketId: string;
  ticker: string;
  title?: string | null;
  capturedAt: Date | string;
  window: ForwardReturnWindow;
  bestBid: MakerQuoteNumeric | null | undefined;
  bestAsk: MakerQuoteNumeric | null | undefined;
  futureBestBid: MakerQuoteNumeric | null | undefined;
  futureBestAsk: MakerQuoteNumeric | null | undefined;
  quoteMode: MakerQuoteMode;
  tickSize?: number;
}): MakerQuoteSimulationRow | null {
  const bestBid = toFiniteNumber(input.bestBid);
  const bestAsk = toFiniteNumber(input.bestAsk);
  if (bestBid === null || bestAsk === null || bestAsk < bestBid) {
    return null;
  }

  const quotePrice = computeSimulatedQuote(bestBid, bestAsk, input.quoteMode, input.tickSize ?? 0.01);
  const futureMidpoint = computeMidpoint(input.futureBestBid, input.futureBestAsk);
  const futureBestBid = toFiniteNumber(input.futureBestBid);
  const futureBestAsk = toFiniteNumber(input.futureBestAsk);
  if (quotePrice === null || futureMidpoint === null || futureBestBid === null || futureBestAsk === null) {
    return null;
  }

  const entrySpread = roundResearchNumber(bestAsk - bestBid);
  const futureSpread = roundResearchNumber(futureBestAsk - futureBestBid);
  const spreadChange = computeSpreadChange(entrySpread, futureSpread);
  const markout = computeMarkout(quotePrice, futureMidpoint);
  const bucket = classifySpreadBucket(entrySpread);
  if (spreadChange.spreadChange === null || spreadChange.tightened === null || markout.markout === null || markout.favorable === null || bucket === null) {
    return null;
  }

  return {
    marketId: input.marketId,
    ticker: input.ticker,
    title: input.title,
    capturedAt: coerceDate(input.capturedAt),
    window: input.window,
    bestBid: roundResearchNumber(bestBid),
    bestAsk: roundResearchNumber(bestAsk),
    quotePrice,
    futureMidpoint,
    markout: markout.markout,
    markoutPct: markout.markoutPct,
    favorable: markout.favorable,
    entrySpread,
    futureSpread,
    spreadChange: spreadChange.spreadChange,
    tightened: spreadChange.tightened,
    bucket
  };
}

export function summarizeMakerQuoteRows(rows: MakerQuoteSimulationRow[]): MakerQuoteSummary {
  return {
    overall: summarizeRows(rows),
    byEntrySpreadBucket: summarizeBuckets(rows)
  };
}

export function buildFillProxyRow(row: MakerQuoteSimulationRow, futureSnapshots: FillProxySnapshot[]): FillProxyRow {
  const fill = computePossibleFillByAsk(row.quotePrice, futureSnapshots);
  return {
    ...row,
    firstFillAt: fill.firstFillSnapshotTime,
    timeToFillMinutes: computeTimeToPossibleFill(row.capturedAt, fill.firstFillSnapshotTime),
    possibleFill: fill.possibleFill
  };
}

export function summarizeFillProxyRows(rows: FillProxyRow[]): FillProxySummary {
  return {
    overall: summarizeFillRows(rows),
    byEntrySpreadBucket: summarizeFillBuckets(rows)
  };
}

export function buildQuoteSweepRows(row: MakerQuoteSimulationRow, futureSnapshots: FillProxySnapshot[], tickSize = 0.01): QuoteSweepRow[] {
  return QUOTE_SWEEP_LEVELS.map((quoteLevel) => {
    const quotePrice = computeQuoteForLevel(row.bestBid, row.bestAsk, quoteLevel, tickSize);
    if (quotePrice === null) {
      return buildSkippedQuoteSweepRow(row, quoteLevel);
    }

    const markout = computeMarkout(quotePrice, row.futureMidpoint);
    if (markout.markout === null || markout.favorable === null) {
      return buildSkippedQuoteSweepRow(row, quoteLevel);
    }

    const fill = computePossibleFillByAsk(quotePrice, futureSnapshots);
    return {
      ...copyBaseQuoteSweepFields(row, quoteLevel),
      quotePrice,
      markout: markout.markout,
      markoutPct: markout.markoutPct,
      favorable: markout.favorable,
      firstFillAt: fill.firstFillSnapshotTime,
      timeToFillMinutes: computeTimeToPossibleFill(row.capturedAt, fill.firstFillSnapshotTime),
      possibleFill: fill.possibleFill,
      skipped: false
    };
  });
}

export function summarizeQuoteSweepRows(rows: QuoteSweepRow[]): QuoteSweepSummaryRow[] {
  return QUOTE_SWEEP_LEVELS.map((quoteLevel) => {
    const levelRows = rows.filter((row) => row.quoteLevel === quoteLevel);
    const validRows = levelRows.filter((row) => !row.skipped);
    const fillableRows = validRows.filter((row) => row.possibleFill);
    const favorableRows = validRows.filter((row) => row.favorable === true);
    const favorableFillableRows = fillableRows.filter((row) => row.favorable === true);

    return {
      quoteLevel,
      count: validRows.length,
      possibleFillRate: validRows.length === 0 ? null : roundResearchNumber(fillableRows.length / validRows.length),
      avgTimeToFillMinutes: average(fillableRows.map((row) => row.timeToFillMinutes)),
      favorableRate: validRows.length === 0 ? null : roundResearchNumber(favorableRows.length / validRows.length),
      favorableIfFillableRate: fillableRows.length === 0 ? null : roundResearchNumber(favorableFillableRows.length / fillableRows.length),
      avgMarkout: average(validRows.map((row) => row.markout)),
      avgMarkoutPct: average(validRows.map((row) => row.markoutPct)),
      avgFillableMarkout: average(fillableRows.map((row) => row.markout)),
      avgFillableMarkoutPct: average(fillableRows.map((row) => row.markoutPct)),
      skippedCount: levelRows.filter((row) => row.skipped).length
    };
  });
}

export function rankMakerQuoteRows(
  rows: MakerQuoteSimulationRow[],
  sortBy: MakerQuoteSortField,
  direction: MakerQuoteSortDirection
): MakerQuoteSimulationRow[] {
  return [...rows].sort((left, right) => {
    const leftValue = sortValue(left, sortBy);
    const rightValue = sortValue(right, sortBy);
    const valueCompare = compareNullableNumber(leftValue, rightValue);
    const directedCompare = direction === "asc" ? valueCompare : -valueCompare;
    return directedCompare || left.ticker.localeCompare(right.ticker) || left.capturedAt.getTime() - right.capturedAt.getTime();
  });
}

export function dedupeMakerQuoteRows(
  rows: MakerQuoteSimulationRow[],
  dedupeBy: MakerQuoteDedupeMode,
  sortBy: MakerQuoteSortField,
  direction: MakerQuoteSortDirection
): MakerQuoteSimulationRow[] {
  if (dedupeBy === "none") {
    return rows;
  }

  const ranked = rankMakerQuoteRows(rows, sortBy, direction);
  const seen = new Set<string>();
  const deduped: MakerQuoteSimulationRow[] = [];
  for (const row of ranked) {
    const key = dedupeBy === "market" ? row.marketId : row.ticker;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

export function dedupeQuoteSweepBaseRows(rows: MakerQuoteSimulationRow[], dedupeBy: MakerQuoteDedupeMode): MakerQuoteSimulationRow[] {
  if (dedupeBy === "none") {
    return rows;
  }

  const ranked = rankMakerQuoteRows(rows, "markout", "desc");
  const seen = new Set<string>();
  const deduped: MakerQuoteSimulationRow[] = [];
  for (const row of ranked) {
    const key = dedupeBy === "market" ? row.marketId : row.ticker;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

export function rankFillProxyRows(rows: FillProxyRow[], sortBy: FillProxySortField, direction: MakerQuoteSortDirection): FillProxyRow[] {
  return [...rows].sort((left, right) => {
    const leftValue = fillSortValue(left, sortBy);
    const rightValue = fillSortValue(right, sortBy);
    const valueCompare = compareNullableNumber(leftValue, rightValue);
    const directedCompare = direction === "asc" ? valueCompare : -valueCompare;
    return directedCompare || left.ticker.localeCompare(right.ticker) || left.capturedAt.getTime() - right.capturedAt.getTime();
  });
}

export function dedupeFillProxyRows(
  rows: FillProxyRow[],
  dedupeBy: MakerQuoteDedupeMode,
  sortBy: FillProxySortField,
  direction: MakerQuoteSortDirection
): FillProxyRow[] {
  if (dedupeBy === "none") {
    return rows;
  }

  const ranked = rankFillProxyRows(rows, sortBy, direction);
  const seen = new Set<string>();
  const deduped: FillProxyRow[] = [];
  for (const row of ranked) {
    const key = dedupeBy === "market" ? row.marketId : row.ticker;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

export function bucketByEntrySpread(rows: MakerQuoteSimulationRow[]): MakerQuoteBucketSummaryRow[] {
  return summarizeBuckets(rows);
}

const BUCKET_ORDER: SpreadTighteningBucket[] = ["< 0.02", "0.02-0.05", "0.05-0.10", "> 0.10"];

function summarizeBuckets(rows: MakerQuoteSimulationRow[]): MakerQuoteBucketSummaryRow[] {
  return BUCKET_ORDER.map((bucket) => ({ bucket, ...summarizeRows(rows.filter((row) => row.bucket === bucket)) })).filter((row) => row.count > 0);
}

function summarizeFillBuckets(rows: FillProxyRow[]): FillProxyBucketSummaryRow[] {
  return BUCKET_ORDER.map((bucket) => {
    const bucketRows = rows.filter((row) => row.bucket === bucket);
    const fillableRows = bucketRows.filter((row) => row.possibleFill);
    return {
      bucket,
      count: bucketRows.length,
      possibleFillRate: bucketRows.length === 0 ? null : roundResearchNumber(fillableRows.length / bucketRows.length),
      favorableIfFillableRate: fillableRows.length === 0 ? null : roundResearchNumber(fillableRows.filter((row) => row.favorable).length / fillableRows.length),
      avgFillableMarkoutPct: average(fillableRows.map((row) => row.markoutPct))
    };
  }).filter((row) => row.count > 0);
}

function summarizeRows(rows: MakerQuoteSimulationRow[]): MakerQuoteSummaryRow {
  return {
    count: rows.length,
    avgEntrySpread: average(rows.map((row) => row.entrySpread)),
    avgFutureSpread: average(rows.map((row) => row.futureSpread)),
    tightenRate: rows.length === 0 ? null : roundResearchNumber(rows.filter((row) => row.tightened).length / rows.length),
    avgQuotePrice: average(rows.map((row) => row.quotePrice)),
    avgFutureMidpoint: average(rows.map((row) => row.futureMidpoint)),
    avgMarkout: average(rows.map((row) => row.markout)),
    avgMarkoutPct: average(rows.map((row) => row.markoutPct)),
    favorableRate: rows.length === 0 ? null : roundResearchNumber(rows.filter((row) => row.favorable).length / rows.length)
  };
}

function summarizeFillRows(rows: FillProxyRow[]): FillProxySummaryRow {
  const fillableRows = rows.filter((row) => row.possibleFill);
  const favorableFillableRows = fillableRows.filter((row) => row.favorable);
  const unfillableFavorableRows = rows.filter((row) => !row.possibleFill && row.favorable);

  return {
    count: rows.length,
    possibleFillRate: rows.length === 0 ? null : roundResearchNumber(fillableRows.length / rows.length),
    avgTimeToFillMinutes: average(fillableRows.map((row) => row.timeToFillMinutes)),
    favorableRate: rows.length === 0 ? null : roundResearchNumber(rows.filter((row) => row.favorable).length / rows.length),
    favorableIfFillableRate: fillableRows.length === 0 ? null : roundResearchNumber(favorableFillableRows.length / fillableRows.length),
    avgMarkout: average(rows.map((row) => row.markout)),
    avgMarkoutPct: average(rows.map((row) => row.markoutPct)),
    avgFillableMarkout: average(fillableRows.map((row) => row.markout)),
    avgFillableMarkoutPct: average(fillableRows.map((row) => row.markoutPct)),
    fillableCount: fillableRows.length,
    favorableFillableCount: favorableFillableRows.length,
    unfillableFavorableCount: unfillableFavorableRows.length
  };
}

function sortValue(row: MakerQuoteSimulationRow, sortBy: MakerQuoteSortField): number | null {
  if (sortBy === "markout") {
    return row.markout;
  }
  if (sortBy === "markoutPct") {
    return row.markoutPct;
  }
  if (sortBy === "spreadChange") {
    return row.spreadChange;
  }
  return row.entrySpread;
}

function fillSortValue(row: FillProxyRow, sortBy: FillProxySortField): number | null {
  if (sortBy === "markout") {
    return row.markout;
  }
  if (sortBy === "markoutPct") {
    return row.markoutPct;
  }
  if (sortBy === "timeToFill") {
    return row.timeToFillMinutes;
  }
  return row.quotePrice;
}

function buildSkippedQuoteSweepRow(row: MakerQuoteSimulationRow, quoteLevel: QuoteSweepLevel): QuoteSweepRow {
  return {
    ...copyBaseQuoteSweepFields(row, quoteLevel),
    quotePrice: null,
    markout: null,
    markoutPct: null,
    favorable: null,
    firstFillAt: null,
    timeToFillMinutes: null,
    possibleFill: false,
    skipped: true
  };
}

function copyBaseQuoteSweepFields(row: MakerQuoteSimulationRow, quoteLevel: QuoteSweepLevel): Omit<
  QuoteSweepRow,
  "quotePrice" | "markout" | "markoutPct" | "favorable" | "firstFillAt" | "timeToFillMinutes" | "possibleFill" | "skipped"
> {
  return {
    marketId: row.marketId,
    ticker: row.ticker,
    title: row.title,
    capturedAt: row.capturedAt,
    window: row.window,
    quoteLevel,
    bestBid: row.bestBid,
    bestAsk: row.bestAsk,
    futureMidpoint: row.futureMidpoint,
    entrySpread: row.entrySpread,
    futureSpread: row.futureSpread,
    spreadChange: row.spreadChange,
    tightened: row.tightened,
    bucket: row.bucket
  };
}

function average(values: Array<number | null>): number | null {
  const finite = values.filter(isFiniteNumber);
  if (finite.length === 0) {
    return null;
  }
  return roundResearchNumber(finite.reduce((sum, value) => sum + value, 0) / finite.length);
}

function compareNullableNumber(left: number | null, right: number | null): number {
  if (left === null && right === null) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  return left - right;
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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function coerceDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function roundResearchNumber(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported quote mode: ${String(value)}`);
}
