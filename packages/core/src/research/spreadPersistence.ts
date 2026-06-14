import { computeSpreadChange } from "./spreadTightening";

export type SpreadPersistenceNumeric = number | string | { toNumber(): number };
export type SpreadEpisodeDurationBucket = "<1m" | "1-5m" | "5-15m" | "15-60m" | "> 60m";
export type SpreadPersistenceDedupeMode = "none" | "ticker" | "market";

export interface SpreadPersistenceSnapshotInput {
  marketId?: string | null;
  ticker: string;
  title?: string | null;
  capturedAt: Date | string;
  spread: SpreadPersistenceNumeric | null;
}

export interface BuildSpreadEpisodesOptions {
  minSpread: number;
  maxSpread: number;
  maxGapMinutes?: number;
}

export interface SpreadEpisode {
  marketId?: string | null;
  ticker: string;
  title?: string | null;
  start: Date;
  end: Date;
  durationMinutes: number;
  snapshotCount: number;
  avgSpread: number;
  maxSpread: number;
  tightened: boolean | null;
}

export interface SpreadPersistenceOverallSummary {
  avgEpisodeMinutes: number | null;
  medianEpisodeMinutes: number | null;
  maxEpisodeMinutes: number | null;
  avgSnapshotsPerEpisode: number | null;
}

export interface SpreadPersistenceBucketSummary {
  bucket: SpreadEpisodeDurationBucket;
  count: number;
  avgDurationMinutes: number | null;
  avgSpread: number | null;
  maxSpread: number | null;
}

export interface SpreadPersistenceSummary {
  overall: SpreadPersistenceOverallSummary;
  byDurationBucket: SpreadPersistenceBucketSummary[];
}

interface ActiveEpisode {
  marketId?: string | null;
  ticker: string;
  title?: string | null;
  snapshots: Array<{ capturedAt: Date; spread: number }>;
}

const DURATION_BUCKETS: SpreadEpisodeDurationBucket[] = ["<1m", "1-5m", "5-15m", "15-60m", "> 60m"];
const DEFAULT_MAX_GAP_MINUTES = 2;

export function isSpreadInRange(spread: unknown, min: number, max: number): boolean {
  const value = toFiniteNumber(spread);
  return value !== null && value >= min && value <= max;
}

export function buildSpreadEpisodes(
  snapshots: SpreadPersistenceSnapshotInput[],
  options: BuildSpreadEpisodesOptions
): SpreadEpisode[] {
  const maxGapMinutes = options.maxGapMinutes ?? DEFAULT_MAX_GAP_MINUTES;
  const sorted = [...snapshots]
    .map((snapshot) => ({ ...snapshot, capturedAt: coerceDate(snapshot.capturedAt), spread: toFiniteNumber(snapshot.spread) }))
    .filter((snapshot): snapshot is SpreadPersistenceSnapshotInput & { capturedAt: Date; spread: number } => snapshot.spread !== null)
    .sort((left, right) => {
      const groupCompare = episodeGroupKey(left).localeCompare(episodeGroupKey(right));
      return groupCompare === 0 ? left.capturedAt.getTime() - right.capturedAt.getTime() : groupCompare;
    });

  const episodes: SpreadEpisode[] = [];
  let active: ActiveEpisode | null = null;
  let previous: (typeof sorted)[number] | null = null;

  for (const snapshot of sorted) {
    const inRange = isSpreadInRange(snapshot.spread, options.minSpread, options.maxSpread);
    const changedGroup = previous ? episodeGroupKey(previous) !== episodeGroupKey(snapshot) : false;
    const gapMinutes = previous ? minutesBetween(previous.capturedAt, snapshot.capturedAt) : 0;
    const exceededGap = active !== null && previous !== null && gapMinutes > maxGapMinutes;

    if (active && (changedGroup || exceededGap || !inRange)) {
      episodes.push(finalizeEpisode(active, snapshot.spread));
      active = null;
    }

    if (inRange) {
      if (!active) {
        active = {
          marketId: snapshot.marketId,
          ticker: snapshot.ticker,
          title: snapshot.title,
          snapshots: []
        };
      }
      active.snapshots.push({ capturedAt: snapshot.capturedAt, spread: snapshot.spread });
    }

    previous = snapshot;
  }

  if (active) {
    episodes.push(finalizeEpisode(active, null));
  }

  return episodes;
}

export function summarizeSpreadEpisodes(episodes: SpreadEpisode[]): SpreadPersistenceSummary {
  return {
    overall: {
      avgEpisodeMinutes: average(episodes.map((episode) => episode.durationMinutes)),
      medianEpisodeMinutes: median(episodes.map((episode) => episode.durationMinutes)),
      maxEpisodeMinutes: max(episodes.map((episode) => episode.durationMinutes)),
      avgSnapshotsPerEpisode: average(episodes.map((episode) => episode.snapshotCount))
    },
    byDurationBucket: DURATION_BUCKETS.map((bucket) => {
      const bucketEpisodes = episodes.filter((episode) => bucketEpisodeDuration(episode.durationMinutes) === bucket);
      return {
        bucket,
        count: bucketEpisodes.length,
        avgDurationMinutes: average(bucketEpisodes.map((episode) => episode.durationMinutes)),
        avgSpread: average(bucketEpisodes.map((episode) => episode.avgSpread)),
        maxSpread: max(bucketEpisodes.map((episode) => episode.maxSpread))
      };
    })
  };
}

export function bucketEpisodeDuration(durationMinutes: number): SpreadEpisodeDurationBucket {
  if (durationMinutes < 1) {
    return "<1m";
  }
  if (durationMinutes < 5) {
    return "1-5m";
  }
  if (durationMinutes < 15) {
    return "5-15m";
  }
  if (durationMinutes <= 60) {
    return "15-60m";
  }
  return "> 60m";
}

export function selectTopSpreadEpisodes(
  episodes: SpreadEpisode[],
  dedupeBy: SpreadPersistenceDedupeMode
): SpreadEpisode[] {
  const ranked = [...episodes].sort(comparePersistentEpisodes);
  if (dedupeBy === "none") {
    return ranked;
  }

  const seen = new Set<string>();
  const deduped: SpreadEpisode[] = [];
  for (const episode of ranked) {
    const key = dedupeBy === "market" ? episode.marketId ?? episode.ticker : episode.ticker;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(episode);
  }
  return deduped;
}

function finalizeEpisode(active: ActiveEpisode, nextSpread: number | null): SpreadEpisode {
  const first = active.snapshots[0];
  const last = active.snapshots[active.snapshots.length - 1];
  return {
    marketId: active.marketId,
    ticker: active.ticker,
    title: active.title,
    start: first.capturedAt,
    end: last.capturedAt,
    durationMinutes: roundResearchNumber(minutesBetween(first.capturedAt, last.capturedAt)),
    snapshotCount: active.snapshots.length,
    avgSpread: average(active.snapshots.map((snapshot) => snapshot.spread)) ?? 0,
    maxSpread: max(active.snapshots.map((snapshot) => snapshot.spread)) ?? 0,
    tightened: computeSpreadChange(first.spread, nextSpread).tightened
  };
}

function episodeGroupKey(snapshot: Pick<SpreadPersistenceSnapshotInput, "marketId" | "ticker">): string {
  return `${snapshot.ticker}\u0000${snapshot.marketId ?? snapshot.ticker}`;
}

function comparePersistentEpisodes(left: SpreadEpisode, right: SpreadEpisode): number {
  const durationCompare = right.durationMinutes - left.durationMinutes;
  if (durationCompare !== 0) {
    return durationCompare;
  }
  const snapshotCompare = right.snapshotCount - left.snapshotCount;
  if (snapshotCompare !== 0) {
    return snapshotCompare;
  }
  return left.start.getTime() - right.start.getTime();
}

function minutesBetween(start: Date, end: Date): number {
  return (end.getTime() - start.getTime()) / 60_000;
}

function average(values: Array<number | null>): number | null {
  const finite = values.filter(isFiniteNumber);
  if (finite.length === 0) {
    return null;
  }
  return roundResearchNumber(finite.reduce((sum, value) => sum + value, 0) / finite.length);
}

function median(values: number[]): number | null {
  const finite = values.filter(isFiniteNumber).sort((left, right) => left - right);
  if (finite.length === 0) {
    return null;
  }
  const midpoint = Math.floor(finite.length / 2);
  return finite.length % 2 === 0 ? roundResearchNumber((finite[midpoint - 1] + finite[midpoint]) / 2) : finite[midpoint];
}

function max(values: number[]): number | null {
  const finite = values.filter(isFiniteNumber);
  return finite.length === 0 ? null : roundResearchNumber(Math.max(...finite));
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
