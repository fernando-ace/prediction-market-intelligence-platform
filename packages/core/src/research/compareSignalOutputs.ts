import type { NormalizedSignal, Platform, SignalStrategy, SignalType } from "../types";

export interface ExistingSignalComparisonInput {
  platform?: Platform;
  marketId: string;
  outcomeId?: string;
  signalType?: SignalType;
  strategy?: SignalStrategy;
  estimatedEdge?: number | null;
  netEdge?: number | null;
  reason?: string;
  raw?: unknown;
}

export interface SignalComparisonEntry {
  platform?: Platform;
  marketId: string;
  outcomeId?: string;
  signalType: SignalType;
  estimatedEdge?: number;
  reason?: string;
}

export interface SignalOutputComparisonResult {
  existingCount: number;
  normalizedCount: number;
  matchedCount: number;
  missingFromNormalized: SignalComparisonEntry[];
  extraFromNormalized: SignalComparisonEntry[];
  notes: string[];
}

export interface CompareSignalOutputsOptions {
  edgeTolerance?: number;
}

export function compareSignalOutputs(
  existing: ExistingSignalComparisonInput[],
  normalized: NormalizedSignal[],
  options: CompareSignalOutputsOptions = {}
): SignalOutputComparisonResult {
  const edgeTolerance = options.edgeTolerance ?? 0.000001;
  const normalizedEntries = normalized.map(normalizedToEntry);
  const matchedNormalizedIndexes = new Set<number>();
  const missingFromNormalized: SignalComparisonEntry[] = [];

  for (const existingSignal of existing) {
    const existingEntry = existingToEntry(existingSignal);
    const matchIndex = normalizedEntries.findIndex((normalizedEntry, index) => {
      return !matchedNormalizedIndexes.has(index) && signalsMatch(existingEntry, normalizedEntry, edgeTolerance);
    });

    if (matchIndex === -1) {
      missingFromNormalized.push(existingEntry);
    } else {
      matchedNormalizedIndexes.add(matchIndex);
    }
  }

  const extraFromNormalized = normalizedEntries.filter((_, index) => !matchedNormalizedIndexes.has(index));
  const notes = [
    `Matched by signalType, platform when available, marketId, outcomeId when available, and estimated edge within ${edgeTolerance}.`,
    "Existing detector outputs do not always carry market identifiers directly, so callers should pass stable market metadata alongside detector results."
  ];

  return {
    existingCount: existing.length,
    normalizedCount: normalized.length,
    matchedCount: matchedNormalizedIndexes.size,
    missingFromNormalized,
    extraFromNormalized,
    notes
  };
}

function existingToEntry(signal: ExistingSignalComparisonInput): SignalComparisonEntry {
  return {
    platform: signal.platform,
    marketId: signal.marketId,
    outcomeId: signal.outcomeId,
    signalType: signal.signalType ?? signal.strategy ?? "binary_complement_arb",
    estimatedEdge: normalizeEdge(signal.estimatedEdge ?? signal.netEdge),
    reason: signal.reason
  };
}

function normalizedToEntry(signal: NormalizedSignal): SignalComparisonEntry {
  return {
    platform: signal.platform,
    marketId: signal.marketId,
    outcomeId: signal.outcomeId,
    signalType: signal.signalType,
    estimatedEdge: normalizeEdge(signal.estimatedEdge),
    reason: signal.reason
  };
}

function signalsMatch(existing: SignalComparisonEntry, normalized: SignalComparisonEntry, edgeTolerance: number): boolean {
  return (
    existing.signalType === normalized.signalType &&
    fieldsMatch(existing.platform, normalized.platform) &&
    existing.marketId === normalized.marketId &&
    fieldsMatch(existing.outcomeId, normalized.outcomeId) &&
    edgesMatch(existing.estimatedEdge, normalized.estimatedEdge, edgeTolerance)
  );
}

function fieldsMatch(left: string | undefined, right: string | undefined): boolean {
  return left === undefined || right === undefined || left === right;
}

function edgesMatch(left: number | undefined, right: number | undefined, tolerance: number): boolean {
  if (left === undefined || right === undefined) {
    return true;
  }
  return Math.abs(left - right) <= tolerance;
}

function normalizeEdge(value: number | null | undefined): number | undefined {
  return Number.isFinite(value) && value !== null && value !== undefined ? value : undefined;
}
