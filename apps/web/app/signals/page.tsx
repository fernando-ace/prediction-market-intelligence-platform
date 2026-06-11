import { prisma } from "@prediction-market-scanner/db";
import { DbError, EmptyState, PageHeader, StatusBadge } from "../components";
import { friendlyDbError } from "../lib/db-error";
import { formatContracts, formatDate, formatPrice } from "../lib/format";

export const dynamic = "force-dynamic";

export default async function SignalsPage() {
  const { signals, summary, error } = await readSignals();

  return (
    <>
      <PageHeader
        title="Signals"
        description="Detected signals include both accepted and rejected opportunities, with explicit reasons and estimated edge after fees."
      />
      <DbError message={error} />
      {signals.length === 0 ? (
        <EmptyState label="No signals detected yet." />
      ) : (
        <>
          <section className="mb-4 grid gap-3 md:grid-cols-4">
            <SignalStat label="Total signals" value={summary.total} />
            <SignalStat label="Accepted" value={summary.accepted} />
            <SignalStat label="Rejected" value={summary.rejected} />
            <SignalStat label="Missing liquidity" value={summary.rejectedForMissingLiquidity} />
          </section>
          <div className="overflow-x-auto border border-line bg-white">
            <table className="text-left text-sm">
              <thead className="bg-slate-100 text-xs uppercase text-slate-600">
                <tr>
                  <th className="px-3 py-2">Detected</th>
                  <th className="px-3 py-2">Strategy</th>
                  <th className="px-3 py-2">Market</th>
                  <th className="px-3 py-2">Group</th>
                  <th className="px-3 py-2">Gross edge</th>
                  <th className="px-3 py-2">Estimated fees</th>
                  <th className="px-3 py-2">Total YES ask</th>
                  <th className="px-3 py-2">Net edge</th>
                  <th className="px-3 py-2">Confidence</th>
                  <th className="px-3 py-2">Liquidity</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Reason</th>
                </tr>
              </thead>
              <tbody>
                {signals.map((signal) => {
                  const raw = readJsonRecord(signal.rawJson);
                  const groupTickers = readStringArray(raw.groupMarketTickers ?? signal.relatedGroup?.marketTickers);
                  return (
                    <tr key={signal.id} className="border-t border-line align-top">
                      <td className="px-3 py-2">{formatDate(signal.detectedAt)}</td>
                      <td className="px-3 py-2 font-medium">{signal.strategy}</td>
                      <td className="max-w-sm px-3 py-2">
                        <div>{signal.market.title}</div>
                        <div className="text-xs text-muted">{signal.market.ticker}</div>
                      </td>
                      <td className="min-w-72 px-3 py-2">
                        {signal.relatedGroup ? (
                          <>
                            <div className="font-medium">{signal.relatedGroup.groupKey}</div>
                            <div className="text-xs text-muted">{groupTickers.join(", ")}</div>
                          </>
                        ) : (
                          <span className="text-muted">N/A</span>
                        )}
                      </td>
                      <td className="px-3 py-2">{formatPrice(signal.grossEdge)}</td>
                      <td className="px-3 py-2">{formatPrice(signal.estimatedFees)}</td>
                      <td className="px-3 py-2">{formatPrice(raw.totalYesAskCost)}</td>
                      <td className="px-3 py-2">{formatPrice(signal.netEdge)}</td>
                      <td className="px-3 py-2">{formatPrice(signal.confidenceScore)}</td>
                      <td className="px-3 py-2">{formatContracts(signal.liquidityScore)}</td>
                      <td className="px-3 py-2"><StatusBadge status={signal.status} /></td>
                      <td className="min-w-80 px-3 py-2 text-slate-700">{raw.rejectionCode ? `${raw.rejectionCode}: ` : ""}{signal.reason}</td>
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

function SignalStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="border border-line bg-white p-3">
      <div className="text-xs font-medium uppercase text-muted">{label}</div>
      <div className="mt-1 text-xl font-semibold text-ink">{value}</div>
    </div>
  );
}

async function readSignals() {
  try {
    const [signals, total, accepted, rejected, rejectedForMissingLiquidity] = await Promise.all([
      prisma.signal.findMany({
        orderBy: { detectedAt: "desc" },
        take: 200,
        include: { market: true, relatedGroup: true }
      }),
      prisma.signal.count(),
      prisma.signal.count({ where: { status: "accepted" } }),
      prisma.signal.count({ where: { status: "rejected" } }),
      prisma.signal.count({
        where: {
          status: "rejected",
          OR: [
            { reason: { contains: "liquidity", mode: "insensitive" } },
            { reason: { contains: "no available ask", mode: "insensitive" } },
            { reason: { contains: "orderbook is empty", mode: "insensitive" } }
          ]
        }
      })
    ]);
    return { signals, summary: { total, accepted, rejected, rejectedForMissingLiquidity }, error: null };
  } catch (error) {
    return {
      signals: [],
      summary: { total: 0, accepted: 0, rejected: 0, rejectedForMissingLiquidity: 0 },
      error: friendlyDbError(error)
    };
  }
}

function readJsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}
