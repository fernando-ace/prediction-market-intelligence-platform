import type { ForwardReturnWindow } from "../types";

export type SpreadTighteningNumeric = number | string | { toNumber(): number };

export interface SpreadTighteningSnapshotInput {
  capturedAt?: Date | string;
  bestYesBid?: SpreadTighteningNumeric | null;
  bestYesAsk?: SpreadTighteningNumeric | null;
  bestNoBid?: SpreadTighteningNumeric | null;
  bestNoAsk?: SpreadTighteningNumeric | null;
  spread?: SpreadTighteningNumeric | null;
}

export interface SpreadTighteningResearchRow {
  marketId: string;
  ticker: string;
  title?: string | null;
  category?: string | null;
  detectedAt: Date;
  window: ForwardReturnWindow;
  entrySpread: number | null;
  futureSpread: number | null;
  spreadChange: number | null;
  spreadChangePct: number | null;
  tightened: boolean | null;
  missingExit: boolean;
  bucket: SpreadTighteningBucket | null;
}

export type SpreadTighteningBucket = "< 0.02" | "0.02-0.05" | "0.05-0.10" | "> 0.10";

export interface SpreadTighteningSummaryRow {
  window: ForwardReturnWindow;
  count: number;
  avgEntrySpread: number | null;
  avgFutureSpread: number | null;
  avgSpreadChange: number | null;
  tightenRate: number | null;
  missingExitCount: number;
}

export interface SpreadTighteningBucketSummaryRow extends SpreadTighteningSummaryRow {
  bucket: SpreadTighteningBucket;
}

export interface SpreadTighteningCategorySummaryRow extends SpreadTighteningSummaryRow {
  category: string;
}

export interface SpreadTighteningTickerSummaryRow extends SpreadTighteningSummaryRow {
  ticker: string;
  title?: string | null;
}

export interface SpreadTighteningSummary {
  overall: SpreadTighteningSummaryRow[];
  byBucket: SpreadTighteningBucketSummaryRow[];
  byCategory: SpreadTighteningCategorySummaryRow[];
  byTicker: SpreadTighteningTickerSummaryRow[];
}

export interface SpreadChangeCalculation {
  spreadChange: number | null;
  spreadChangePct: number | null;
  tightened: boolean | null;
}

export function getSnapshotSpread(snapshot: SpreadTighteningSnapshotInput | null | undefined): number | null {
  if (!snapshot) {
    return null;
  }

  const storedSpread = toFiniteNumber(snapshot.spread);
  if (storedSpread !== null && storedSpread >= 0) {
    return roundResearchNumber(storedSpread);
  }

  const yesSpread = spreadFromBidAsk(snapshot.bestYesBid, snapshot.bestYesAsk);
  if (yesSpread !== null) {
    return yesSpread;
  }

  return spreadFromBidAsk(snapshot.bestNoBid, snapshot.bestNoAsk);
}

export function computeSpreadChange(
  entrySpread: number | null | undefined,
  futureSpread: number | null | undefined
): SpreadChangeCalculation {
  if (!isFiniteNumber(entrySpread) || !isFiniteNumber(futureSpread)) {
    return { spreadChange: null, spreadChangePct: null, tightened: null };
  }

  const spreadChange = roundResearchNumber(futureSpread - entrySpread);
  return {
    spreadChange,
    spreadChangePct: entrySpread === 0 ? null : roundResearchNumber(spreadChange / entrySpread),
    tightened: spreadChange < 0
  };
}

export function classifySpreadBucket(entrySpread: number | null | undefined): SpreadTighteningBucket | null {
  if (!isFiniteNumber(entrySpread)) {
    return null;
  }
  if (entrySpread < 0.02) {
    return "< 0.02";
  }
  if (entrySpread < 0.05) {
    return "0.02-0.05";
  }
  if (entrySpread < 0.1) {
    return "0.05-0.10";
  }
  return "> 0.10";
}

export function buildSpreadTighteningRow(input: {
  marketId: string;
  ticker: string;
  title?: string | null;
  category?: string | null;
  detectedAt: Date | string;
  window: ForwardReturnWindow;
  entrySnapshot: SpreadTighteningSnapshotInput | null | undefined;
  futureSnapshot: SpreadTighteningSnapshotInput | null | undefined;
}): SpreadTighteningResearchRow {
  const entrySpread = getSnapshotSpread(input.entrySnapshot);
  const futureSpread = getSnapshotSpread(input.futureSnapshot);
  const calculation = computeSpreadChange(entrySpread, futureSpread);

  return {
    marketId: input.marketId,
    ticker: input.ticker,
    title: input.title,
    category: input.category,
    detectedAt: coerceDate(input.detectedAt),
    window: input.window,
    entrySpread,
    futureSpread,
    bucket: classifySpreadBucket(entrySpread),
    missingExit: futureSpread === null,
    ...calculation
  };
}

export function findFirstSnapshotAtOrAfter<T extends SpreadTighteningSnapshotInput>(
  snapshots: T[],
  targetTime: Date | string
): T | null {
  const target = coerceDate(targetTime).getTime();
  return (
    [...snapshots]
      .filter((snapshot) => snapshot.capturedAt && coerceDate(snapshot.capturedAt).getTime() >= target)
      .sort((left, right) => coerceDate(left.capturedAt as Date | string).getTime() - coerceDate(right.capturedAt as Date | string).getTime())[0] ??
    null
  );
}

export function summarizeSpreadTightening(rows: SpreadTighteningResearchRow[]): SpreadTighteningSummary {
  return {
    overall: summarizeGroups(rows, (row) => row.window, (row) => ({ window: row.window })),
    byBucket: summarizeGroups(
      rows.filter((row) => row.bucket !== null),
      (row) => `${row.bucket}\u0000${row.window}`,
      (row) => ({ bucket: row.bucket as SpreadTighteningBucket, window: row.window })
    ).sort(compareBucketRows),
    byCategory: summarizeGroups(
      rows.filter((row) => normalizedCategory(row.category) !== null),
      (row) => `${normalizedCategory(row.category)}\u0000${row.window}`,
      (row) => ({ category: normalizedCategory(row.category) ?? "unknown", window: row.window })
    ).sort(compareNamedRows("category")),
    byTicker: summarizeGroups(
      rows,
      (row) => `${row.ticker}\u0000${row.window}`,
      (row) => ({ ticker: row.ticker, title: row.title, window: row.window })
    ).sort((left, right) => {
      const changeCompare = compareNullableNumber(left.avgSpreadChange, right.avgSpreadChange);
      return changeCompare === 0 ? left.ticker.localeCompare(right.ticker) || left.window.localeCompare(right.window) : changeCompare;
    })
  };
}

const BUCKET_ORDER: SpreadTighteningBucket[] = ["< 0.02", "0.02-0.05", "0.05-0.10", "> 0.10"];

function spreadFromBidAsk(bid: unknown, ask: unknown): number | null {
  const bidValue = toFiniteNumber(bid);
  const askValue = toFiniteNumber(ask);
  if (bidValue === null || askValue === null) {
    return null;
  }
  const spread = askValue - bidValue;
  return spread < 0 ? null : roundResearchNumber(spread);
}

function summarizeGroups<T extends { window: ForwardReturnWindow }>(
  rows: SpreadTighteningResearchRow[],
  keyFor: (row: SpreadTighteningResearchRow) => string,
  baseFor: (row: SpreadTighteningResearchRow) => T
): Array<T & SpreadTighteningSummaryRow> {
  const groups = new Map<string, { base: T; rows: SpreadTighteningResearchRow[] }>();

  for (const row of rows) {
    const key = keyFor(row);
    const existing = groups.get(key);
    if (existing) {
      existing.rows.push(row);
    } else {
      groups.set(key, { base: baseFor(row), rows: [row] });
    }
  }

  return [...groups.values()].map(({ base, rows: groupRows }) => {
    const validRows = groupRows.filter((row) => isFiniteNumber(row.entrySpread) && isFiniteNumber(row.futureSpread));
    return {
      ...base,
      count: validRows.length,
      avgEntrySpread: average(validRows.map((row) => row.entrySpread)),
      avgFutureSpread: average(validRows.map((row) => row.futureSpread)),
      avgSpreadChange: average(validRows.map((row) => row.spreadChange)),
      tightenRate: validRows.length === 0 ? null : roundResearchNumber(validRows.filter((row) => row.tightened).length / validRows.length),
      missingExitCount: groupRows.filter((row) => row.missingExit).length
    };
  });
}

function compareBucketRows(left: SpreadTighteningBucketSummaryRow, right: SpreadTighteningBucketSummaryRow): number {
  const bucketCompare = BUCKET_ORDER.indexOf(left.bucket) - BUCKET_ORDER.indexOf(right.bucket);
  return bucketCompare === 0 ? left.window.localeCompare(right.window) : bucketCompare;
}

function compareNamedRows<T extends { window: ForwardReturnWindow }>(field: keyof T): (left: T, right: T) => number {
  return (left, right) => {
    const nameCompare = String(left[field]).localeCompare(String(right[field]));
    return nameCompare === 0 ? left.window.localeCompare(right.window) : nameCompare;
  };
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

function average(values: Array<number | null>): number | null {
  const finite = values.filter(isFiniteNumber);
  if (finite.length === 0) {
    return null;
  }
  return roundResearchNumber(finite.reduce((sum, value) => sum + value, 0) / finite.length);
}

function normalizedCategory(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
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
