export interface SnapshotSignalCsvRow {
  timestamp: Date | string;
  platform: string;
  ticker: string;
  title: string;
  bestYesBid: unknown;
  bestYesAsk: unknown;
  bestNoBid: unknown;
  bestNoAsk: unknown;
  spread: unknown;
  grossEdge: unknown;
  estimatedFees: unknown;
  netEdge: unknown;
  signalStatus: string | null;
  reason: string | null;
  strategy?: string | null;
  groupKey?: string | null;
  groupMarketTickers?: string | null;
  groupMarketTitles?: string | null;
  groupEligibility?: string | null;
  groupConfidence?: unknown;
  groupReason?: string | null;
  totalYesAskCost?: unknown;
  rejectionReason?: string | null;
  marketCount?: unknown;
  closeTimeSpreadSeconds?: unknown;
}

const headers = [
  "timestamp",
  "platform",
  "ticker",
  "title",
  "bestYesBid",
  "bestYesAsk",
  "bestNoBid",
  "bestNoAsk",
  "spread",
  "grossEdge",
  "estimatedFees",
  "netEdge",
  "signalStatus",
  "reason",
  "strategy",
  "groupKey",
  "groupMarketTickers",
  "groupMarketTitles",
  "groupEligibility",
  "groupConfidence",
  "groupReason",
  "totalYesAskCost",
  "rejectionReason",
  "marketCount",
  "closeTimeSpreadSeconds"
] as const;

export function snapshotsSignalsToCsv(rows: SnapshotSignalCsvRow[]): string {
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => escapeCsv(formatValue(row[header]))).join(","))
  ].join("\n");
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object" && "toString" in value && typeof value.toString === "function") {
    return value.toString();
  }
  return String(value);
}

function escapeCsv(value: string): string {
  if (!/[",\n\r]/.test(value)) {
    return value;
  }
  return `"${value.replaceAll('"', '""')}"`;
}
