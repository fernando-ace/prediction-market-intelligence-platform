import type { SignalComparisonEntry, SignalOutputComparisonResult } from "@prediction-market-scanner/core";

export interface NormalizedParityOptions {
  limit: number;
  lookbackHours: number;
  verbose: boolean;
  debugCounts: boolean;
}

export interface NormalizedParityDebugCounts {
  totalMarkets: number;
  totalOrderbookSnapshots: number;
  newestMarketTimestamp: Date | null;
  newestOrderbookSnapshotTimestamp: Date | null;
  snapshotsInsideLookback: number;
}

export interface NormalizedParityReport {
  lookbackHours: number;
  marketsEvaluated: number;
  snapshotsEvaluated: number;
  existingDetectorSignals: number;
  normalizedEvaluatorSignals: number;
  matchedSignals: number;
  missingFromNormalized: number;
  extraFromNormalized: number;
  missingSamples: SignalComparisonEntry[];
  extraSamples: SignalComparisonEntry[];
  notes: string[];
}

const DEFAULT_LIMIT = 50;
const DEFAULT_LOOKBACK_HOURS = 24;
const DEFAULT_SAMPLE_SIZE = 5;

export class NormalizedParityOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NormalizedParityOptionsError";
  }
}

export function parseNormalizedParityOptions(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): NormalizedParityOptions {
  const args = parseArgs(argv);
  return {
    limit: readPositiveInteger(resolveOption(args, "limit", 0, env.PARITY_LIMIT), "limit", DEFAULT_LIMIT),
    lookbackHours: readPositiveNumber(resolveOption(args, "lookback-hours", 1, env.PARITY_LOOKBACK_HOURS), "lookback-hours", DEFAULT_LOOKBACK_HOURS),
    verbose: readBoolean(args.named.verbose, env.PARITY_VERBOSE, false),
    debugCounts: readBoolean(args.named["debug-counts"], env.PARITY_DEBUG_COUNTS, false)
  };
}

export function buildNormalizedParityReport(input: {
  lookbackHours: number;
  marketsEvaluated: number;
  snapshotsEvaluated: number;
  comparison: SignalOutputComparisonResult;
  sampleSize?: number;
}): NormalizedParityReport {
  const sampleSize = input.sampleSize ?? DEFAULT_SAMPLE_SIZE;
  return {
    lookbackHours: input.lookbackHours,
    marketsEvaluated: input.marketsEvaluated,
    snapshotsEvaluated: input.snapshotsEvaluated,
    existingDetectorSignals: input.comparison.existingCount,
    normalizedEvaluatorSignals: input.comparison.normalizedCount,
    matchedSignals: input.comparison.matchedCount,
    missingFromNormalized: input.comparison.missingFromNormalized.length,
    extraFromNormalized: input.comparison.extraFromNormalized.length,
    missingSamples: selectSignalSamples(input.comparison.missingFromNormalized, sampleSize),
    extraSamples: selectSignalSamples(input.comparison.extraFromNormalized, sampleSize),
    notes: input.comparison.notes
  };
}

export function selectSignalSamples(entries: SignalComparisonEntry[], sampleSize = DEFAULT_SAMPLE_SIZE): SignalComparisonEntry[] {
  return entries.slice(0, Math.max(0, sampleSize));
}

export function formatNormalizedParityReport(report: NormalizedParityReport, options: { verbose?: boolean } = {}): string {
  const lines = [
    "Normalized Signal Parity Dry Run",
    `Lookback hours: ${report.lookbackHours}`,
    `Markets evaluated: ${report.marketsEvaluated}`,
    `Snapshots evaluated: ${report.snapshotsEvaluated}`,
    `Existing detector signals: ${report.existingDetectorSignals}`,
    `Normalized evaluator signals: ${report.normalizedEvaluatorSignals}`,
    `Matched signals: ${report.matchedSignals}`,
    `Missing from normalized: ${report.missingFromNormalized}`,
    `Extra from normalized: ${report.extraFromNormalized}`
  ];

  if (options.verbose) {
    lines.push("", "Missing from normalized sample:");
    lines.push(...formatSignalSamples(report.missingSamples));
    lines.push("", "Extra from normalized sample:");
    lines.push(...formatSignalSamples(report.extraSamples));
  }

  return lines.join("\n");
}

export function formatNormalizedParityDebugCounts(counts: NormalizedParityDebugCounts): string {
  return [
    "Normalized Signal Parity Debug Counts",
    `Total Market rows: ${counts.totalMarkets}`,
    `Total OrderbookSnapshot rows: ${counts.totalOrderbookSnapshots}`,
    `Newest Market updated/created timestamp: ${formatDateTime(counts.newestMarketTimestamp)}`,
    `Newest OrderbookSnapshot timestamp: ${formatDateTime(counts.newestOrderbookSnapshotTimestamp)}`,
    `Snapshots inside selected lookback window: ${counts.snapshotsInsideLookback}`
  ].join("\n");
}

function formatSignalSamples(entries: SignalComparisonEntry[]): string[] {
  if (entries.length === 0) {
    return ["  none"];
  }

  return entries.map((entry) => {
    const parts = [
      `market=${entry.marketId}`,
      `type=${entry.signalType}`,
      `edge=${formatEdge(entry.estimatedEdge)}`
    ];
    if (entry.reason) {
      parts.push(`reason=${entry.reason}`);
    }
    return `  - ${parts.join(" | ")}`;
  });
}

interface ParsedArgs {
  named: Record<string, string | boolean>;
  positional: string[];
}

interface ResolvedOption {
  value: string | boolean | undefined;
  source: "named flag" | "positional argument" | "environment variable" | "default";
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
  positionalIndex: number,
  envValue: string | undefined
): ResolvedOption {
  if (args.named[flagName] !== undefined) {
    return { value: args.named[flagName], source: "named flag" };
  }
  if (args.positional[positionalIndex] !== undefined) {
    return { value: args.positional[positionalIndex], source: "positional argument" };
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

  throw new NormalizedParityOptionsError(
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

  throw new NormalizedParityOptionsError(
    `Invalid ${optionName} from ${option.source}: expected a positive number, received ${String(option.value)}.`
  );
}

function readBoolean(cliValue: string | boolean | undefined, envValue: string | undefined, fallback: boolean): boolean {
  if (typeof cliValue === "boolean") {
    return cliValue;
  }
  if (typeof cliValue === "string") {
    return ["1", "true", "yes", "on"].includes(cliValue.trim().toLowerCase());
  }
  if (envValue) {
    return ["1", "true", "yes", "on"].includes(envValue.trim().toLowerCase());
  }
  return fallback;
}

function formatEdge(value: number | undefined): string {
  return value === undefined ? "n/a" : value.toFixed(6);
}

function formatDateTime(value: Date | null): string {
  return value ? value.toISOString() : "none";
}
