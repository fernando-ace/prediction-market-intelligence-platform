import type { ForwardReturnWindow } from "../types";
import type { SpreadTighteningResearchRow } from "./spreadTightening";

export type SpreadCandidateDedupeMode = "none" | "ticker" | "market";
export type SpreadCandidateSortField = "spreadChange" | "tightenPct" | "entrySpread" | "futureSpread";
export type SpreadCandidateSortDirection = "asc" | "desc";

export interface SpreadCandidateDiscoveryOptions {
  window: ForwardReturnWindow;
  minEntrySpread: number;
  maxEntrySpread: number;
  dedupeBy: SpreadCandidateDedupeMode;
  sortBy: SpreadCandidateSortField;
  direction: SpreadCandidateSortDirection;
  top: number;
}

export interface SpreadCandidateDiagnostics {
  averageEntrySpread: number | null;
  averageFutureSpread: number | null;
  averageSpreadChange: number | null;
  tightenRate: number | null;
  missingFutureSnapshotCount: number;
  strongestSpreadChangeFound: number | null;
}

export function extractSpreadCandidates(
  rows: SpreadTighteningResearchRow[],
  options: Pick<SpreadCandidateDiscoveryOptions, "window" | "minEntrySpread" | "maxEntrySpread">
): SpreadTighteningResearchRow[] {
  return rows.filter(
    (row) =>
      row.window === options.window &&
      isFiniteNumber(row.entrySpread) &&
      row.entrySpread >= options.minEntrySpread &&
      row.entrySpread <= options.maxEntrySpread &&
      isFiniteNumber(row.futureSpread) &&
      isFiniteNumber(row.spreadChange)
  );
}

export function rankSpreadCandidates(
  rows: SpreadTighteningResearchRow[],
  sortBy: SpreadCandidateSortField,
  direction: SpreadCandidateSortDirection
): SpreadTighteningResearchRow[] {
  return [...rows].sort((left, right) => {
    const leftValue = sortValue(left, sortBy);
    const rightValue = sortValue(right, sortBy);
    const valueCompare = compareNullableNumber(leftValue, rightValue);
    const directedCompare = direction === "asc" ? valueCompare : -valueCompare;
    return directedCompare || left.ticker.localeCompare(right.ticker) || left.detectedAt.getTime() - right.detectedAt.getTime();
  });
}

export function dedupeSpreadCandidates(
  rows: SpreadTighteningResearchRow[],
  dedupeBy: SpreadCandidateDedupeMode
): SpreadTighteningResearchRow[] {
  if (dedupeBy === "none") {
    return rows;
  }

  const seen = new Set<string>();
  const deduped: SpreadTighteningResearchRow[] = [];
  for (const row of rows) {
    const key = dedupeBy === "market" ? row.marketId : row.ticker;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

export function buildSpreadCandidateDiagnostics(rows: SpreadTighteningResearchRow[]): SpreadCandidateDiagnostics {
  const rowsWithFuture = rows.filter((row) => isFiniteNumber(row.entrySpread) && isFiniteNumber(row.futureSpread));
  const rowsWithSpreadChange = rows.filter((row) => isFiniteNumber(row.spreadChange));

  return {
    averageEntrySpread: average(rowsWithFuture.map((row) => row.entrySpread)),
    averageFutureSpread: average(rowsWithFuture.map((row) => row.futureSpread)),
    averageSpreadChange: average(rowsWithSpreadChange.map((row) => row.spreadChange)),
    tightenRate:
      rowsWithSpreadChange.length === 0
        ? null
        : roundResearchNumber(rowsWithSpreadChange.filter((row) => row.tightened).length / rowsWithSpreadChange.length),
    missingFutureSnapshotCount: rows.filter((row) => row.missingExit).length,
    strongestSpreadChangeFound:
      rowsWithSpreadChange.length === 0 ? null : Math.min(...rowsWithSpreadChange.map((row) => row.spreadChange as number))
  };
}

function sortValue(row: SpreadTighteningResearchRow, sortBy: SpreadCandidateSortField): number | null {
  if (sortBy === "spreadChange") {
    return row.spreadChange;
  }
  if (sortBy === "tightenPct") {
    return row.spreadChangePct;
  }
  if (sortBy === "entrySpread") {
    return row.entrySpread;
  }
  return row.futureSpread;
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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function roundResearchNumber(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
