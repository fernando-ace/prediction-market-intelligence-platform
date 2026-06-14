import type { ForwardReturnWindow } from "../types";

export type ForwardReturnNumeric = number | string | { toNumber(): number };

export interface ForwardReturnSignalInput {
  id?: string;
  signalId?: string;
  strategy?: string;
  signalType?: string;
  entryPrice?: ForwardReturnNumeric | null;
  rawJson?: unknown;
}

export interface ForwardReturnSnapshotInput {
  capturedAt?: Date | string;
  bestYesBid?: ForwardReturnNumeric | null;
  bestYesAsk?: ForwardReturnNumeric | null;
  bestNoBid?: ForwardReturnNumeric | null;
  bestNoAsk?: ForwardReturnNumeric | null;
  spread?: ForwardReturnNumeric | null;
}

export interface ForwardReturnCalculation {
  returnAbs: number | null;
  returnPct: number | null;
  wasProfitable: boolean | null;
}

export type ForwardReturnOrder = "oldest" | "newest";

export type ForwardReturnSignalStatusFilter = "accepted" | "rejected" | "all";

export type ForwardReturnMissingExitReason =
  | "signal_too_recent"
  | "no_future_snapshot_for_market"
  | "no_snapshot_at_or_after_window"
  | "missing_market_identifier"
  | "unsupported_strategy_shape";

export interface ForwardReturnResearchRow extends ForwardReturnCalculation {
  signalId: string;
  strategy: string;
  window: ForwardReturnWindow;
  entryPrice: number | null;
  exitPrice: number | null;
  missingEntry: boolean;
  missingExit: boolean;
  missingExitReason?: ForwardReturnMissingExitReason | null;
  bucketLabels?: Partial<Record<ForwardReturnBucketDimension, string>>;
}

export interface ForwardReturnSummaryRow {
  strategy?: string;
  window: ForwardReturnWindow;
  count: number;
  avgReturnAbs: number | null;
  avgReturnPct: number | null;
  winRate: number | null;
  missingExitCount: number;
}

export interface ForwardReturnSummary {
  byStrategy: ForwardReturnSummaryRow[];
  overall: ForwardReturnSummaryRow[];
}

export type ForwardReturnBucketDimension =
  | "entryCost"
  | "estimatedEdge"
  | "netEdge"
  | "spread"
  | "strategy"
  | "reason"
  | "nearMiss";

export interface NumericBucketDefinition {
  label: string;
  min?: number;
  max?: number;
}

export interface ForwardReturnBucketSummaryRow extends ForwardReturnSummaryRow {
  bucket: string;
}

export interface ForwardReturnBucketSummary {
  bucketBy: ForwardReturnBucketDimension;
  available: boolean;
  rows: ForwardReturnBucketSummaryRow[];
}

export interface ForwardReturnSelectionSignalInput {
  detectedAt: Date | string;
}

export interface ForwardReturnSignalStatusReasonInput {
  status?: string | null;
  reason?: string | null;
  rawJson?: unknown;
}

export interface SelectForwardReturnSignalsOptions {
  limit: number;
  minAgeMinutes: number;
  order: ForwardReturnOrder;
  referenceTime: Date | string;
}

export interface ForwardReturnSignalSelectionFilters {
  status: ForwardReturnSignalStatusFilter;
  rejectionReason?: string | null;
}

export interface ForwardReturnRejectionReasonSummaryRow {
  reason: string;
  count: number;
}

export interface ForwardReturnSignalSelectionSummary {
  acceptedCount: number;
  rejectedCount: number;
  topRejectionReasons: ForwardReturnRejectionReasonSummaryRow[];
}

export interface ForwardReturnCoverageMarketRef {
  marketId?: string | null;
  ticker?: string | null;
}

export interface ForwardReturnCoverageSignalInput {
  signalId: string;
  detectedAt: Date | string;
  marketRefs: ForwardReturnCoverageMarketRef[];
  hasLaterSnapshot: boolean;
}

export interface ForwardReturnCoverageWindowInput {
  window: ForwardReturnWindow;
  minutes: number;
}

export interface ForwardReturnCoverageWindowCount {
  window: ForwardReturnWindow;
  minutes: number;
  count: number;
}

export interface ForwardReturnCoverageDiagnostics {
  selectedSignals: number;
  oldestSelectedSignalAt: Date | null;
  newestSelectedSignalAt: Date | null;
  newestAvailableSnapshotAt: Date | null;
  olderThanWindowCounts: ForwardReturnCoverageWindowCount[];
  signalsWithLaterSnapshotCount: number;
  signalsWithoutLaterSnapshotCount: number;
  missingMarketIdentifierCount: number;
}

export interface ClassifyForwardReturnMissingExitInput {
  signalDetectedAt: Date | string;
  targetTime: Date | string;
  newestSnapshotAt?: Date | string | null;
  marketRefs: ForwardReturnCoverageMarketRef[];
  strategy: string;
  hasAnyFutureSnapshot: boolean;
  hasSnapshotAtOrAfterWindow: boolean;
}

export interface ForwardReturnMissingExitReasonSummaryRow {
  window: ForwardReturnWindow;
  reason: ForwardReturnMissingExitReason;
  count: number;
}

export function selectForwardReturnSignals<T extends ForwardReturnSelectionSignalInput>(
  signals: T[],
  options: SelectForwardReturnSignalsOptions
): T[] {
  return orderForwardReturnSignals(filterForwardReturnSignalsByMinimumAge(signals, options), options.order).slice(0, options.limit);
}

export function filterForwardReturnSignalsByStatusAndReason<T extends ForwardReturnSignalStatusReasonInput>(
  signals: T[],
  filters: ForwardReturnSignalSelectionFilters
): T[] {
  const normalizedReasonFilter = normalizeReasonFilter(filters.rejectionReason);

  return signals.filter((signal) => {
    if (filters.status !== "all" && signal.status !== filters.status) {
      return false;
    }
    if (!normalizedReasonFilter) {
      return true;
    }
    return signalMatchesRejectionReason(signal, normalizedReasonFilter);
  });
}

export function summarizeForwardReturnSignalSelection<T extends ForwardReturnSignalStatusReasonInput>(
  signals: T[]
): ForwardReturnSignalSelectionSummary {
  const reasons = new Map<string, number>();

  for (const signal of signals) {
    if (signal.status !== "rejected") {
      continue;
    }
    const reason = classifyForwardReturnRejectionReason(signal) ?? "unknown";
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }

  return {
    acceptedCount: signals.filter((signal) => signal.status === "accepted").length,
    rejectedCount: signals.filter((signal) => signal.status === "rejected").length,
    topRejectionReasons: [...reasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason))
  };
}

export function classifyForwardReturnRejectionReason(signal: ForwardReturnSignalStatusReasonInput): string | null {
  const raw = readRecord(signal.rawJson);
  const rawCode = typeof raw?.rejectionCode === "string" ? raw.rejectionCode : null;
  if (rawCode && rawCode.trim().length > 0) {
    return normalizeReasonCode(rawCode);
  }

  const reason = signal.reason?.toLowerCase() ?? "";
  if (!reason) {
    return null;
  }
  if (reason.includes("orderbook is empty")) {
    return "empty_orderbook";
  }
  if (reason.includes("stale")) {
    return "stale_snapshot";
  }
  if (reason.includes("net edge") && reason.includes("below minimum")) {
    return "low_edge";
  }
  if (
    reason.includes("liquidity") ||
    reason.includes("no available ask") ||
    reason.includes("missing a yes ask") ||
    reason.includes("missing yes ask")
  ) {
    return "missing_liquidity";
  }

  return normalizeReasonCode(signal.reason ?? "");
}

export function filterForwardReturnSignalsByMinimumAge<T extends ForwardReturnSelectionSignalInput>(
  signals: T[],
  options: Pick<SelectForwardReturnSignalsOptions, "minAgeMinutes" | "referenceTime">
): T[] {
  const cutoff = signalDetectedAtCutoffForMinimumAge(options.referenceTime, options.minAgeMinutes);
  return signals.filter((signal) => coerceDate(signal.detectedAt).getTime() <= cutoff.getTime());
}

export function orderForwardReturnSignals<T extends ForwardReturnSelectionSignalInput>(
  signals: T[],
  order: ForwardReturnOrder
): T[] {
  const direction = order === "oldest" ? 1 : -1;
  return [...signals].sort((left, right) => {
    return (coerceDate(left.detectedAt).getTime() - coerceDate(right.detectedAt).getTime()) * direction;
  });
}

export function signalDetectedAtCutoffForMinimumAge(referenceTime: Date | string, minAgeMinutes: number): Date {
  return new Date(coerceDate(referenceTime).getTime() - minAgeMinutes * 60 * 1000);
}

export function buildForwardReturnCoverageDiagnostics(input: {
  signals: ForwardReturnCoverageSignalInput[];
  newestSnapshotAt?: Date | string | null;
  windows: ForwardReturnCoverageWindowInput[];
}): ForwardReturnCoverageDiagnostics {
  const signalTimes = input.signals.map((signal) => coerceDate(signal.detectedAt).getTime());
  const newestSnapshotAt = input.newestSnapshotAt ? coerceDate(input.newestSnapshotAt) : null;

  return {
    selectedSignals: input.signals.length,
    oldestSelectedSignalAt: signalTimes.length === 0 ? null : new Date(Math.min(...signalTimes)),
    newestSelectedSignalAt: signalTimes.length === 0 ? null : new Date(Math.max(...signalTimes)),
    newestAvailableSnapshotAt: newestSnapshotAt,
    olderThanWindowCounts: input.windows.map((window) => ({
      ...window,
      count:
        newestSnapshotAt === null
          ? 0
          : input.signals.filter((signal) => {
              const ageMs = newestSnapshotAt.getTime() - coerceDate(signal.detectedAt).getTime();
              return ageMs >= window.minutes * 60 * 1000;
            }).length
    })),
    signalsWithLaterSnapshotCount: input.signals.filter((signal) => signal.hasLaterSnapshot).length,
    signalsWithoutLaterSnapshotCount: input.signals.filter((signal) => !signal.hasLaterSnapshot).length,
    missingMarketIdentifierCount: input.signals.filter((signal) => !hasUsableMarketIdentifier(signal.marketRefs)).length
  };
}

export function classifyForwardReturnMissingExit(
  input: ClassifyForwardReturnMissingExitInput
): ForwardReturnMissingExitReason | null {
  if (!hasUsableMarketIdentifier(input.marketRefs)) {
    return "missing_market_identifier";
  }

  if (!isSupportedForwardReturnStrategy(input.strategy)) {
    return "unsupported_strategy_shape";
  }

  const newestSnapshotAt = input.newestSnapshotAt ? coerceDate(input.newestSnapshotAt) : null;
  if (newestSnapshotAt && coerceDate(input.targetTime).getTime() > newestSnapshotAt.getTime()) {
    return "signal_too_recent";
  }

  if (!input.hasAnyFutureSnapshot) {
    return "no_future_snapshot_for_market";
  }

  if (!input.hasSnapshotAtOrAfterWindow) {
    return "no_snapshot_at_or_after_window";
  }

  return null;
}

export function summarizeMissingExitReasons(
  rows: ForwardReturnResearchRow[]
): ForwardReturnMissingExitReasonSummaryRow[] {
  const groups = new Map<string, ForwardReturnMissingExitReasonSummaryRow>();

  for (const row of rows) {
    if (!row.missingExit || !row.missingExitReason) {
      continue;
    }
    const key = `${row.window}\u0000${row.missingExitReason}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      groups.set(key, { window: row.window, reason: row.missingExitReason, count: 1 });
    }
  }

  return [...groups.values()].sort((left, right) => {
    const windowCompare = left.window.localeCompare(right.window);
    return windowCompare === 0 ? left.reason.localeCompare(right.reason) : windowCompare;
  });
}

// Persisted Signal rows do not currently carry an explicit side/outcome. For the
// supported arb strategies, treat the signal as a long basket entered at asks.
export function chooseEntryPrice(
  signal: ForwardReturnSignalInput,
  nearestSnapshot?: ForwardReturnSnapshotInput | ForwardReturnSnapshotInput[] | null
): number | null {
  const raw = readRecord(signal.rawJson);
  const directEntry = firstFiniteNumber(signal.entryPrice, raw?.entryPrice, raw?.entryCost);
  if (directEntry !== null) {
    return directEntry;
  }

  if (isMultiOutcomeSignal(signal)) {
    const rawTotal = firstFiniteNumber(raw?.totalYesAskCost);
    if (rawTotal !== null) {
      return rawTotal;
    }

    const legCost = sumLegPrices(raw?.legs, "yesAsk");
    if (legCost !== null) {
      return legCost;
    }

    return sumSnapshotPrices(asSnapshotArray(nearestSnapshot), "bestYesAsk");
  }

  const rawYesAsk = toFiniteNumber(raw?.yesAsk);
  const rawNoAsk = toFiniteNumber(raw?.noAsk);
  if (rawYesAsk !== null && rawNoAsk !== null) {
    return roundReturn(rawYesAsk + rawNoAsk);
  }

  const snapshot = asSnapshotArray(nearestSnapshot)[0];
  if (!snapshot) {
    return null;
  }

  const yesAsk = toFiniteNumber(snapshot.bestYesAsk);
  const noAsk = toFiniteNumber(snapshot.bestNoAsk);
  return yesAsk === null || noAsk === null ? null : roundReturn(yesAsk + noAsk);
}

// Exits are marked conservatively at bid-side liquidation value after the window.
export function chooseExitPrice(
  signal: ForwardReturnSignalInput,
  futureSnapshot?: ForwardReturnSnapshotInput | ForwardReturnSnapshotInput[] | null
): number | null {
  const snapshots = asSnapshotArray(futureSnapshot);
  if (snapshots.length === 0) {
    return null;
  }

  if (isMultiOutcomeSignal(signal)) {
    return sumSnapshotPrices(snapshots, "bestYesBid");
  }

  const snapshot = snapshots[0];
  const yesBid = toFiniteNumber(snapshot.bestYesBid);
  const noBid = toFiniteNumber(snapshot.bestNoBid);
  return yesBid === null || noBid === null ? null : roundReturn(yesBid + noBid);
}

export function computeForwardReturn(
  entryPrice: number | null | undefined,
  exitPrice: number | null | undefined
): ForwardReturnCalculation {
  if (!isFiniteNumber(entryPrice) || !isFiniteNumber(exitPrice)) {
    return { returnAbs: null, returnPct: null, wasProfitable: null };
  }

  const returnAbs = roundReturn(exitPrice - entryPrice);
  return {
    returnAbs,
    returnPct: entryPrice === 0 ? null : roundReturn(returnAbs / entryPrice),
    wasProfitable: returnAbs > 0
  };
}

export function summarizeForwardReturns(rows: ForwardReturnResearchRow[]): ForwardReturnSummary {
  const byStrategy = summarizeGroups(rows, (row) => `${row.strategy}\u0000${row.window}`, (row) => ({
    strategy: row.strategy,
    window: row.window
  }));
  const overall = summarizeGroups(rows, (row) => row.window, (row) => ({ window: row.window }));

  return { byStrategy, overall };
}

export function bucketNumericValue(value: unknown, buckets: NumericBucketDefinition[]): string | null {
  const numericValue = toFiniteNumber(value);
  if (numericValue === null) {
    return null;
  }

  const bucket = buckets.find((candidate) => {
    const aboveMin = candidate.min === undefined || numericValue >= candidate.min;
    const belowMax = candidate.max === undefined || numericValue < candidate.max;
    return aboveMin && belowMax;
  });
  return bucket?.label ?? null;
}

export function formatBucketLabel(definition: NumericBucketDefinition): string {
  if (definition.min === undefined && definition.max !== undefined) {
    return `< ${formatBucketBoundary(definition.max)}`;
  }
  if (definition.min !== undefined && definition.max === undefined) {
    return `> ${formatBucketBoundary(definition.min)}`;
  }
  if (definition.min !== undefined && definition.max !== undefined) {
    return `${formatBucketBoundary(definition.min)}-${formatBucketBoundary(definition.max)}`;
  }
  return definition.label;
}

export function bucketForwardReturnValue(dimension: ForwardReturnBucketDimension, value: unknown): string | null {
  if (dimension === "entryCost") {
    return bucketNumericValue(value, ENTRY_COST_BUCKETS);
  }
  if (dimension === "estimatedEdge" || dimension === "netEdge") {
    return bucketNumericValue(value, EDGE_BUCKETS);
  }
  if (dimension === "spread") {
    return bucketNumericValue(value, SPREAD_BUCKETS);
  }
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function calculateNearMissDistanceToThreshold(netEdge: unknown, minNetEdge: unknown): number | null {
  const netEdgeValue = toFiniteNumber(netEdge);
  const minNetEdgeValue = toFiniteNumber(minNetEdge);
  if (netEdgeValue === null || minNetEdgeValue === null) {
    return null;
  }
  return roundReturn(Math.max(0, minNetEdgeValue - netEdgeValue));
}

export function classifyNearMissBucket(distanceToThreshold: unknown): string | null {
  const distance = toFiniteNumber(distanceToThreshold);
  if (distance === null) {
    return null;
  }
  if (distance <= 0.005) {
    return "within 0.005";
  }
  if (distance <= 0.01) {
    return "within 0.010";
  }
  if (distance <= 0.02) {
    return "within 0.020";
  }
  return "farther than 0.020";
}

export function classifyNearMissBucketFromNetEdge(netEdge: unknown, minNetEdge: unknown): string | null {
  return classifyNearMissBucket(calculateNearMissDistanceToThreshold(netEdge, minNetEdge));
}

export function summarizeForwardReturnsByBucket(
  rows: ForwardReturnResearchRow[],
  bucketBy: ForwardReturnBucketDimension
): ForwardReturnBucketSummary {
  const bucketedRows = rows.filter((row) => row.bucketLabels?.[bucketBy]);
  if (bucketedRows.length === 0) {
    return { bucketBy, available: false, rows: [] };
  }

  const summaryRows = summarizeGroups(bucketedRows, (row) => `${row.bucketLabels?.[bucketBy]}\u0000${row.window}`, (row) => ({
    bucket: row.bucketLabels?.[bucketBy] ?? "unknown",
    window: row.window
  })).sort((left, right) => {
    const bucketCompare = compareBucketLabels(bucketBy, left.bucket, right.bucket);
    return bucketCompare === 0 ? left.window.localeCompare(right.window) : bucketCompare;
  });

  return { bucketBy, available: true, rows: summaryRows };
}

const ENTRY_COST_BUCKETS: NumericBucketDefinition[] = [
  { label: "< 0.95", max: 0.95 },
  { label: "0.95-0.98", min: 0.95, max: 0.98 },
  { label: "0.98-1.00", min: 0.98, max: 1 },
  { label: "1.00-1.02", min: 1, max: 1.02 },
  { label: "> 1.02", min: 1.02 }
];

const EDGE_BUCKETS: NumericBucketDefinition[] = [
  { label: "< -0.10", max: -0.1 },
  { label: "-0.10--0.05", min: -0.1, max: -0.05 },
  { label: "-0.05--0.02", min: -0.05, max: -0.02 },
  { label: "-0.02-0", min: -0.02, max: 0 },
  { label: "0-0.005", min: 0, max: 0.005 },
  { label: "> 0.005", min: 0.005 }
];

const SPREAD_BUCKETS: NumericBucketDefinition[] = [
  { label: "< 0.02", max: 0.02 },
  { label: "0.02-0.05", min: 0.02, max: 0.05 },
  { label: "0.05-0.10", min: 0.05, max: 0.1 },
  { label: "> 0.10", min: 0.1 }
];

const NEAR_MISS_BUCKET_ORDER = ["within 0.005", "within 0.010", "within 0.020", "farther than 0.020"];

function compareBucketLabels(dimension: ForwardReturnBucketDimension, left: string, right: string): number {
  if (dimension !== "nearMiss") {
    return left.localeCompare(right);
  }
  const leftIndex = NEAR_MISS_BUCKET_ORDER.indexOf(left);
  const rightIndex = NEAR_MISS_BUCKET_ORDER.indexOf(right);
  if (leftIndex !== -1 || rightIndex !== -1) {
    return (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex);
  }
  return left.localeCompare(right);
}

function summarizeGroups<T extends { strategy?: string; window: ForwardReturnWindow }>(
  rows: ForwardReturnResearchRow[],
  keyFor: (row: ForwardReturnResearchRow) => string,
  baseFor: (row: ForwardReturnResearchRow) => T
): Array<T & ForwardReturnSummaryRow> {
  const groups = new Map<string, { base: T; rows: ForwardReturnResearchRow[] }>();

  for (const row of rows) {
    const key = keyFor(row);
    const existing = groups.get(key);
    if (existing) {
      existing.rows.push(row);
    } else {
      groups.set(key, { base: baseFor(row), rows: [row] });
    }
  }

  return [...groups.values()]
    .map(({ base, rows: groupRows }) => {
      const validRows = groupRows.filter((row) => isFiniteNumber(row.returnAbs) && isFiniteNumber(row.returnPct));
      return {
        ...base,
        count: validRows.length,
        avgReturnAbs: average(validRows.map((row) => row.returnAbs)),
        avgReturnPct: average(validRows.map((row) => row.returnPct)),
        winRate: validRows.length === 0 ? null : roundReturn(validRows.filter((row) => row.wasProfitable).length / validRows.length),
        missingExitCount: groupRows.filter((row) => row.missingExit).length
      };
    })
    .sort((left, right) => {
      const strategyCompare = (left.strategy ?? "").localeCompare(right.strategy ?? "");
      return strategyCompare === 0 ? left.window.localeCompare(right.window) : strategyCompare;
    });
}

function isMultiOutcomeSignal(signal: ForwardReturnSignalInput): boolean {
  return (signal.strategy ?? signal.signalType ?? "").toLowerCase() === "multi_outcome_arb";
}

function signalMatchesRejectionReason(signal: ForwardReturnSignalStatusReasonInput, normalizedFilter: string): boolean {
  const classifiedReason = classifyForwardReturnRejectionReason(signal);
  if (classifiedReason && reasonTokenMatches(classifiedReason, normalizedFilter)) {
    return true;
  }

  return reasonTokenMatches(signal.reason ?? "", normalizedFilter);
}

function normalizeReasonFilter(value: string | null | undefined): string | null {
  if (!value || value.trim().length === 0) {
    return null;
  }
  return normalizeReasonCode(value);
}

function normalizeReasonCode(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^rejected:\s*/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function reasonTokenMatches(value: string, normalizedFilter: string): boolean {
  const normalizedValue = normalizeReasonCode(value);
  return normalizedValue === normalizedFilter || normalizedValue.includes(normalizedFilter);
}

function sumLegPrices(value: unknown, field: string): number | null {
  if (!Array.isArray(value)) {
    return null;
  }

  let sum = 0;
  for (const entry of value) {
    const record = readRecord(entry);
    const price = toFiniteNumber(record?.[field]);
    if (price === null) {
      return null;
    }
    sum += price;
  }

  return value.length === 0 ? null : roundReturn(sum);
}

function sumSnapshotPrices(snapshots: ForwardReturnSnapshotInput[], field: keyof ForwardReturnSnapshotInput): number | null {
  if (snapshots.length === 0) {
    return null;
  }

  let sum = 0;
  for (const snapshot of snapshots) {
    const price = toFiniteNumber(snapshot[field]);
    if (price === null) {
      return null;
    }
    sum += price;
  }

  return roundReturn(sum);
}

function asSnapshotArray(
  snapshot: ForwardReturnSnapshotInput | ForwardReturnSnapshotInput[] | null | undefined
): ForwardReturnSnapshotInput[] {
  if (!snapshot) {
    return [];
  }
  return Array.isArray(snapshot) ? snapshot.filter(Boolean) : [snapshot];
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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function formatBucketBoundary(value: number): string {
  return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function average(values: Array<number | null>): number | null {
  const finite = values.filter(isFiniteNumber);
  if (finite.length === 0) {
    return null;
  }
  return roundReturn(finite.reduce((sum, value) => sum + value, 0) / finite.length);
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function hasUsableMarketIdentifier(marketRefs: ForwardReturnCoverageMarketRef[]): boolean {
  return marketRefs.length > 0 && marketRefs.every((marketRef) => typeof marketRef.marketId === "string" && marketRef.marketId.length > 0);
}

function isSupportedForwardReturnStrategy(strategy: string): boolean {
  return strategy === "binary_complement_arb" || strategy === "multi_outcome_arb";
}

function coerceDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function roundReturn(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
