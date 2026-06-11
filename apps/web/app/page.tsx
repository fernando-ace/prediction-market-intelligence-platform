import { prisma } from "@prediction-market-scanner/db";
import { DbError, EmptyState, PageHeader, StatusBadge } from "./components";
import { friendlyDbError } from "./lib/db-error";
import { formatDate, formatSimulatedPnl } from "./lib/format";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const { data, error } = await readHomeData();

  return (
    <>
      <PageHeader
        title="Scanner Overview"
        description="Local read-only dashboard for tracked markets, normalized snapshots, detected signals, paper trades, and estimated simulated PnL."
      />
      <DbError message={error} />
      <section className="grid gap-3 md:grid-cols-6">
        <Stat label="Markets tracked" value={data.markets} />
        <Stat label="Snapshots collected" value={data.snapshots} />
        <Stat label="Signals accepted" value={data.signalsAccepted} />
        <Stat label="Signals rejected" value={data.signalsRejected} />
        <Stat label="Paper trades" value={data.paperTrades} />
        <Stat label="Estimated simulated PnL" value={formatSimulatedPnl(data.simulatedPnl)} />
      </section>
      <section className="mt-6">
        <h2 className="mb-3 text-base font-semibold text-ink">Recent worker runs</h2>
        {data.logs.length === 0 ? (
          <EmptyState label="No worker runs recorded yet." />
        ) : (
          <div className="overflow-x-auto border border-line bg-white">
            <table className="text-left text-sm">
              <thead className="bg-slate-100 text-xs uppercase text-slate-600">
                <tr>
                  <th className="px-3 py-2">Run type</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Started</th>
                  <th className="px-3 py-2">Message</th>
                </tr>
              </thead>
              <tbody>
                {data.logs.map((log) => (
                  <tr key={log.id} className="border-t border-line">
                    <td className="px-3 py-2 font-medium">{log.runType}</td>
                    <td className="px-3 py-2"><StatusBadge status={log.status} /></td>
                    <td className="px-3 py-2">{formatDate(log.startedAt)}</td>
                    <td className="px-3 py-2 text-slate-700">{log.message ?? log.error ?? "N/A"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="border border-line bg-white p-4">
      <div className="text-xs font-medium uppercase text-muted">{label}</div>
      <div className="mt-2 text-2xl font-semibold text-ink">{value}</div>
    </div>
  );
}

async function readHomeData() {
  try {
    const [markets, snapshots, signalsAccepted, signalsRejected, paperTrades, paperPnl, logs] = await Promise.all([
      prisma.market.count(),
      prisma.orderbookSnapshot.count(),
      prisma.signal.count({ where: { status: "accepted" } }),
      prisma.signal.count({ where: { status: "rejected" } }),
      prisma.paperTrade.count(),
      prisma.paperTrade.aggregate({ _sum: { realizedNetEdge: true } }),
      prisma.runLog.findMany({ orderBy: { startedAt: "desc" }, take: 8 })
    ]);

    return {
      data: {
        markets,
        snapshots,
        signalsAccepted,
        signalsRejected,
        paperTrades,
        simulatedPnl: paperPnl._sum.realizedNetEdge,
        logs
      },
      error: null
    };
  } catch (error) {
    return {
      data: { markets: 0, snapshots: 0, signalsAccepted: 0, signalsRejected: 0, paperTrades: 0, simulatedPnl: 0, logs: [] },
      error: friendlyDbError(error)
    };
  }
}
