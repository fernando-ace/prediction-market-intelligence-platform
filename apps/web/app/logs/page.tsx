import { prisma } from "@prediction-market-scanner/db";
import { DbError, EmptyState, PageHeader, StatusBadge } from "../components";
import { friendlyDbError } from "../lib/db-error";
import { formatDate } from "../lib/format";

export const dynamic = "force-dynamic";

export default async function LogsPage() {
  const { logs, error } = await readLogs();

  return (
    <>
      <PageHeader
        title="Logs"
        description="Recent worker runs, partial failures, and API or database errors."
      />
      <DbError message={error} />
      {logs.length === 0 ? (
        <EmptyState label="No worker logs yet." />
      ) : (
        <div className="overflow-x-auto border border-line bg-white">
          <table className="text-left text-sm">
            <thead className="bg-slate-100 text-xs uppercase text-slate-600">
              <tr>
                <th className="px-3 py-2">Run type</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Started</th>
                <th className="px-3 py-2">Finished</th>
                <th className="px-3 py-2">Markets</th>
                <th className="px-3 py-2">Snapshots</th>
                <th className="px-3 py-2">Signals</th>
                <th className="px-3 py-2">Paper trades</th>
                <th className="px-3 py-2">Message</th>
                <th className="px-3 py-2">Error</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id} className="border-t border-line align-top">
                  <td className="px-3 py-2 font-medium">{log.runType}</td>
                  <td className="px-3 py-2"><StatusBadge status={log.status} /></td>
                  <td className="px-3 py-2">{formatDate(log.startedAt)}</td>
                  <td className="px-3 py-2">{formatDate(log.finishedAt)}</td>
                  <td className="px-3 py-2">{log.marketsFetched}</td>
                  <td className="px-3 py-2">{log.snapshotsStored}</td>
                  <td className="px-3 py-2">{log.signalsCreated}</td>
                  <td className="px-3 py-2">{log.paperTradesCreated}</td>
                  <td className="min-w-72 px-3 py-2 text-slate-700">{log.message ?? "N/A"}</td>
                  <td className="min-w-72 whitespace-pre-wrap px-3 py-2 text-rose-800">{log.error ?? "N/A"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

async function readLogs() {
  try {
    const logs = await prisma.runLog.findMany({
      orderBy: { startedAt: "desc" },
      take: 200
    });
    return { logs, error: null };
  } catch (error) {
    return { logs: [], error: friendlyDbError(error) };
  }
}
