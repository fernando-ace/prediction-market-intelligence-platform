import { prisma } from "@prediction-market-scanner/db";
import { DbError, EmptyState, PageHeader, StatusBadge } from "../components";
import { friendlyDbError } from "../lib/db-error";
import { formatDate, formatPrice } from "../lib/format";

export const dynamic = "force-dynamic";

export default async function RelatedGroupsPage() {
  const { groups, summary, error } = await readRelatedGroups();

  return (
    <>
      <PageHeader
        title="Related Groups"
        description="Conservative Kalshi market groups evaluated for multi-outcome YES arbitrage. Groups can be ineligible when settlement coverage is unclear."
      />
      <DbError message={error} />
      {groups.length === 0 ? (
        <EmptyState label={summary.emptyExplanation} />
      ) : (
        <>
          <section className="mb-4 grid gap-3 md:grid-cols-4">
            <GroupStat label="Groups" value={summary.total} />
            <GroupStat label="Eligible" value={summary.eligible} />
            <GroupStat label="Ineligible" value={summary.ineligible} />
            <GroupStat label="Cost below 1" value={summary.belowOne} />
          </section>
          <div className="overflow-x-auto border border-line bg-white">
            <table className="text-left text-sm">
              <thead className="bg-slate-100 text-xs uppercase text-slate-600">
                <tr>
                  <th className="px-3 py-2">Group</th>
                  <th className="px-3 py-2">Markets</th>
                  <th className="px-3 py-2">Close times</th>
                  <th className="px-3 py-2">Eligibility</th>
                  <th className="px-3 py-2">Confidence</th>
                  <th className="px-3 py-2">Total YES ask</th>
                  <th className="px-3 py-2">Gross edge</th>
                  <th className="px-3 py-2">Fees</th>
                  <th className="px-3 py-2">Net edge</th>
                  <th className="px-3 py-2">Latest snapshot</th>
                  <th className="px-3 py-2">Validation</th>
                  <th className="px-3 py-2">Evaluation</th>
                  <th className="px-3 py-2">Reason</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => {
                  const titles = readStringArray(group.marketTitles);
                  const tickers = readStringArray(group.marketTickers);
                  const closeTimes = readStringArray(group.closeTimes);
                  const raw = readJsonRecord(group.rawJson);
                  const latestSignal = readJsonRecord(raw.latestSignal);
                  const rejectionCode = readString(latestSignal.rejectionCode);
                  const signalStatus = readString(latestSignal.status) ?? (rejectionCode ? "rejected" : null);
                  const signalReason =
                    readString(latestSignal.reason) ??
                    (rejectionCode ? `Rejected: ${rejectionCode}` : null);
                  return (
                    <tr key={group.id} className="border-t border-line align-top">
                      <td className="px-3 py-2">
                        <div className="font-medium">{group.groupKey}</div>
                        <div className="text-xs text-muted">{group.eventTicker ?? "No event ticker"}</div>
                        <div className="text-xs text-muted">{group.groupingReason}</div>
                      </td>
                      <td className="min-w-96 px-3 py-2">
                        {tickers.map((ticker, index) => (
                          <div key={ticker} className="mb-2 last:mb-0">
                            <div className="font-medium">{titles[index] ?? ticker}</div>
                            <div className="text-xs text-muted">{ticker}</div>
                          </div>
                        ))}
                      </td>
                      <td className="px-3 py-2">
                        {closeTimes.map((closeTime, index) => (
                          <div key={`${closeTime}-${index}`}>{formatDate(closeTime)}</div>
                        ))}
                        <div className="text-xs text-muted">spread {group.closeTimeSpreadSeconds ?? "N/A"}s</div>
                      </td>
                      <td className="px-3 py-2">
                        <StatusBadge status={group.eligible ? "eligible" : "ineligible"} />
                      </td>
                      <td className="px-3 py-2">{formatPrice(group.confidenceScore)}</td>
                      <td className="px-3 py-2">{formatPrice(group.totalYesAskCost)}</td>
                      <td className="px-3 py-2">{formatPrice(group.grossEdge)}</td>
                      <td className="px-3 py-2">{formatPrice(group.estimatedFees)}</td>
                      <td className="px-3 py-2">{formatPrice(group.netEdge)}</td>
                      <td className="px-3 py-2">{formatDate(group.latestSnapshotTime)}</td>
                      <td className="px-3 py-2">{activeFlags(group.validationFlags).join(", ") || "clean"}</td>
                      <td className="min-w-80 px-3 py-2">
                        {signalStatus ? <StatusBadge status={signalStatus} /> : <span className="text-muted">N/A</span>}
                        <div className="mt-1 text-slate-700">{signalReason ?? "No evaluation signal recorded yet."}</div>
                      </td>
                      <td className="min-w-80 px-3 py-2 text-slate-700">{group.eligibilityReason}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

function GroupStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="border border-line bg-white p-3">
      <div className="text-xs font-medium uppercase text-muted">{label}</div>
      <div className="mt-1 text-xl font-semibold text-ink">{value}</div>
    </div>
  );
}

async function readRelatedGroups() {
  try {
    const [groups, total, eligible, belowOne, markets] = await Promise.all([
      prisma.relatedMarketGroup.findMany({
        orderBy: [{ updatedAt: "desc" }, { netEdge: "desc" }],
        take: 200
      }),
      prisma.relatedMarketGroup.count(),
      prisma.relatedMarketGroup.count({ where: { eligible: true } }),
      prisma.relatedMarketGroup.count({ where: { totalYesAskCost: { lt: 1 } } }),
      prisma.market.count({ where: { platform: "kalshi" } })
    ]);
    return {
      groups,
      summary: {
        total,
        eligible,
        ineligible: total - eligible,
        belowOne,
        emptyExplanation:
          markets === 0
            ? "No Kalshi markets are loaded yet. Run the worker or collect:sample first."
            : "Kalshi markets are loaded, but no persisted related groups with 2+ markets exist yet. Run collect:sample or the worker after related pairs are selected."
      },
      error: null
    };
  } catch (error) {
    return {
      groups: [],
      summary: { total: 0, eligible: 0, ineligible: 0, belowOne: 0, emptyExplanation: "Related groups could not be loaded." },
      error: friendlyDbError(error)
    };
  }
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function activeFlags(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return Object.entries(value as Record<string, unknown>)
    .filter(([, enabled]) => Boolean(enabled))
    .map(([flag]) => flag);
}

function readJsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
