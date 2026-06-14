import type { ForwardReturnWindow } from "../types";
import { chooseEntryPrice, classifyForwardReturnRejectionReason, computeForwardReturn } from "./forwardReturns";

export type CandidateSortField = "netEdge" | "spread" | "entryCost" | "return15m" | "return60m" | "return240m";
export type CandidateSortDirection = "asc" | "desc";
export type CandidateDedupeMode = "none" | "ticker" | "market";

export interface CandidateMarketInput {
  id?: string | null;
  ticker?: string | null;
  title?: string | null;
}

export interface CandidateSignalInput {
  id: string;
  detectedAt: Date | string;
  strategy: string;
  status?: string | null;
  reason?: string | null;
  grossEdge?: unknown;
  netEdge?: unknown;
  maxContracts?: unknown;
  rawJson?: unknown;
  market?: CandidateMarketInput | null;
  relatedGroup?: {
    markets?: CandidateMarketInput[];
  } | null;
}

export interface CandidateExtractionContext {
  entryCost?: unknown;
  spread?: unknown;
  forwardReturns?: Partial<Record<ForwardReturnWindow, unknown>>;
}

export interface CandidateDiscoveryCandidate {
  signalId: string;
  shortId: string;
  detectedAt: Date;
  strategy: string;
  ticker: string;
  marketId: string;
  title: string;
  status: string;
  rejectionReason: string;
  entryCost: number | null;
  grossEdge: number | null;
  netEdge: number | null;
  spread: number | null;
  maxContracts: number | null;
  returns: Record<ForwardReturnWindow, number | null>;
}

export interface CandidateDiscoveryDiagnostics {
  minNetEdgeThreshold: number;
  bestNetEdge: number | null;
  distanceFromThreshold: number | null;
  usableNetEdgeCount: number;
  usableForwardReturnsCount: number;
  excludedMissingEntryOrEmptyOrderbookCount: number;
}

export interface CandidateDiscoveryReportInput {
  lookbackHours: number;
  status: string;
  rejectionReason: string;
  sortBy: CandidateSortField;
  direction: CandidateSortDirection;
  candidatesScanned: number;
  candidatesAfterFilters: number;
  dedupeBy: CandidateDedupeMode;
  candidatesAfterDedupe: number;
  candidates: CandidateDiscoveryCandidate[];
  top: number;
  diagnostics: CandidateDiscoveryDiagnostics;
}

const RETURN_WINDOWS: ForwardReturnWindow[] = ["15m", "30m", "60m", "240m"];

export function extractCandidate(
  signal: CandidateSignalInput,
  context: CandidateExtractionContext = {}
): CandidateDiscoveryCandidate {
  const raw = readRecord(signal.rawJson);
  const entryCost = firstFiniteNumber(context.entryCost, signalEntryCost(signal));
  const marketRefs = marketRefsForSignal(signal);
  const title = readTitle(signal, marketRefs);

  return {
    signalId: signal.id,
    shortId: shortSignalId(signal.id),
    detectedAt: coerceDate(signal.detectedAt),
    strategy: signal.strategy,
    ticker: formatTicker(marketRefs),
    marketId: formatMarketId(marketRefs),
    title,
    status: signal.status ?? "unknown",
    rejectionReason: classifyForwardReturnRejectionReason(signal) ?? signal.reason ?? "unknown",
    entryCost,
    grossEdge: firstFiniteNumber(signal.grossEdge, raw?.grossEdge, raw?.estimatedEdge),
    netEdge: firstFiniteNumber(signal.netEdge, raw?.netEdge),
    spread: firstFiniteNumber(context.spread, raw?.spread),
    maxContracts: firstFiniteNumber(signal.maxContracts, raw?.maxContracts, raw?.liquidityUsedByDetector, raw?.liquidity),
    returns: {
      "15m": firstFiniteNumber(context.forwardReturns?.["15m"]),
      "30m": firstFiniteNumber(context.forwardReturns?.["30m"]),
      "60m": firstFiniteNumber(context.forwardReturns?.["60m"]),
      "240m": firstFiniteNumber(context.forwardReturns?.["240m"])
    }
  };
}

export function rankCandidates(
  candidates: CandidateDiscoveryCandidate[],
  sortBy: CandidateSortField,
  direction: CandidateSortDirection
): CandidateDiscoveryCandidate[] {
  return [...candidates].sort((left, right) => {
    const leftValue = candidateSortValue(left, sortBy);
    const rightValue = candidateSortValue(right, sortBy);
    const leftMissing = leftValue === null;
    const rightMissing = rightValue === null;
    if (leftMissing || rightMissing) {
      if (leftMissing && rightMissing) {
        return left.detectedAt.getTime() - right.detectedAt.getTime();
      }
      return leftMissing ? 1 : -1;
    }

    const directionMultiplier = direction === "asc" ? 1 : -1;
    const valueCompare = (leftValue - rightValue) * directionMultiplier;
    return valueCompare === 0 ? left.detectedAt.getTime() - right.detectedAt.getTime() : valueCompare;
  });
}

export function dedupeCandidates(
  rankedCandidates: CandidateDiscoveryCandidate[],
  dedupeBy: CandidateDedupeMode
): CandidateDiscoveryCandidate[] {
  if (dedupeBy === "none") {
    return rankedCandidates;
  }

  const seen = new Set<string>();
  const deduped: CandidateDiscoveryCandidate[] = [];
  for (const candidate of rankedCandidates) {
    const key = dedupeBy === "market" ? candidate.marketId : candidate.ticker;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped;
}

export function buildCandidateDiagnostics(
  candidates: CandidateDiscoveryCandidate[],
  minNetEdgeThreshold: number
): CandidateDiscoveryDiagnostics {
  let usableNetEdgeCount = 0;
  let bestNetEdge: number | null = null;
  for (const candidate of candidates) {
    if (candidate.netEdge === null) {
      continue;
    }
    usableNetEdgeCount += 1;
    bestNetEdge = bestNetEdge === null ? candidate.netEdge : Math.max(bestNetEdge, candidate.netEdge);
  }

  return {
    minNetEdgeThreshold,
    bestNetEdge,
    distanceFromThreshold: bestNetEdge === null ? null : roundReturn(minNetEdgeThreshold - bestNetEdge),
    usableNetEdgeCount,
    usableForwardReturnsCount: candidates.filter((candidate) => RETURN_WINDOWS.some((window) => candidate.returns[window] !== null)).length,
    excludedMissingEntryOrEmptyOrderbookCount: candidates.filter(
      (candidate) => candidate.entryCost === null || candidate.rejectionReason === "empty_orderbook"
    ).length
  };
}

export function formatCandidateDiscoveryReport(input: CandidateDiscoveryReportInput): string {
  const shown = input.candidates.slice(0, input.top);
  return [
    "Candidate Discovery Report",
    `Lookback hours: ${input.lookbackHours}`,
    `Status: ${input.status}`,
    `Rejection reason: ${input.rejectionReason}`,
    `Sort: ${input.sortBy} ${input.direction}`,
    `Candidates scanned: ${input.candidatesScanned}`,
    `Candidates after filters: ${input.candidatesAfterFilters}`,
    `Dedupe by: ${input.dedupeBy}`,
    `Candidates after dedupe: ${input.candidatesAfterDedupe}`,
    `Candidates shown: ${shown.length}`,
    "",
    "Diagnostics:",
    `Min net edge threshold used: ${formatNumber(input.diagnostics.minNetEdgeThreshold)}`,
    `Best netEdge found: ${formatNumber(input.diagnostics.bestNetEdge)}`,
    `Distance from threshold: ${formatNumber(input.diagnostics.distanceFromThreshold)}`,
    `Count with usable netEdge: ${input.diagnostics.usableNetEdgeCount}`,
    `Count with usable forward returns: ${input.diagnostics.usableForwardReturnsCount}`,
    `Count excluded because missing entry price or empty orderbook: ${input.diagnostics.excludedMissingEntryOrEmptyOrderbookCount}`,
    "",
    formatTable(
      ["rank", "detectedAt", "strategy", "ticker", "netEdge", "grossEdge", "entryCost", "spread", "maxContracts", "r15m", "r30m", "r60m", "r240m", "title"],
      shown.map((candidate, index) => [
        String(index + 1),
        candidate.detectedAt.toISOString(),
        candidate.strategy,
        candidate.ticker,
        formatNumber(candidate.netEdge),
        formatNumber(candidate.grossEdge),
        formatNumber(candidate.entryCost),
        formatNumber(candidate.spread),
        formatNumber(candidate.maxContracts),
        formatPercent(candidate.returns["15m"]),
        formatPercent(candidate.returns["30m"]),
        formatPercent(candidate.returns["60m"]),
        formatPercent(candidate.returns["240m"]),
        truncateTitle(candidate.title)
      ])
    )
  ].join("\n");
}

export function truncateTitle(title: string, maxLength = 72): string {
  if (title.length <= maxLength) {
    return title;
  }
  return `${title.slice(0, Math.max(0, maxLength - 3))}...`;
}

function candidateSortValue(candidate: CandidateDiscoveryCandidate, sortBy: CandidateSortField): number | null {
  if (sortBy === "return15m") {
    return candidate.returns["15m"];
  }
  if (sortBy === "return60m") {
    return candidate.returns["60m"];
  }
  if (sortBy === "return240m") {
    return candidate.returns["240m"];
  }
  return candidate[sortBy];
}

function signalEntryCost(signal: CandidateSignalInput): number | null {
  return chooseEntryPrice({
    id: signal.id,
    strategy: signal.strategy,
    rawJson: signal.rawJson
  });
}

function marketRefsForSignal(signal: CandidateSignalInput): CandidateMarketInput[] {
  const groupMarkets = signal.relatedGroup?.markets ?? [];
  if (signal.strategy === "multi_outcome_arb" && groupMarkets.length > 0) {
    return groupMarkets;
  }
  return signal.market ? [signal.market] : [];
}

function readTitle(signal: CandidateSignalInput, marketRefs: CandidateMarketInput[]): string {
  const raw = readRecord(signal.rawJson);
  const rawTitle = firstString(raw?.title, raw?.marketTitle);
  if (rawTitle) {
    return rawTitle;
  }
  const titles = marketRefs.map((market) => market.title).filter((title): title is string => Boolean(title));
  if (titles.length > 0) {
    return titles.join(" + ");
  }
  return "n/a";
}

function formatTicker(marketRefs: CandidateMarketInput[]): string {
  const tickers = marketRefs.map((market) => market.ticker).filter((ticker): ticker is string => Boolean(ticker));
  return tickers.length === 0 ? "n/a" : tickers.join("+");
}

function formatMarketId(marketRefs: CandidateMarketInput[]): string {
  const ids = marketRefs.map((market) => market.id).filter((id): id is string => Boolean(id));
  return ids.length === 0 ? "n/a" : ids.join("+");
}

function shortSignalId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 6)}...${id.slice(-4)}`;
}

function formatTable(headers: string[], rows: string[][]): string {
  const allRows = rows.length > 0 ? rows : [headers.map(() => "none")];
  const widths = headers.map((header, index) => {
    let width = header.length;
    for (const row of allRows) {
      width = Math.max(width, row[index]?.length ?? 0);
    }
    return width;
  });
  const formatRow = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index])).join(" | ");
  return [formatRow(headers), widths.map((width) => "-".repeat(width)).join("-|-"), ...allRows.map(formatRow)].join("\n");
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

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function coerceDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function formatNumber(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(6);
}

function formatPercent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(2)}%`;
}

function roundReturn(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
