import { prisma } from "@prediction-market-scanner/db";
import { DbError, EmptyState, PageHeader, StatusBadge } from "../components";
import { friendlyDbError } from "../lib/db-error";
import { formatContracts, formatDate, formatPrice } from "../lib/format";

export const dynamic = "force-dynamic";

export default async function PaperTradesPage() {
  const { trades, error } = await readTrades();

  return (
    <>
      <PageHeader
        title="Paper Trades"
        description="Simulated paper trades use delayed snapshots and ask-side fills. No real orders are placed."
      />
      <DbError message={error} />
      {trades.length === 0 ? (
        <EmptyState label="No paper trades recorded yet." />
      ) : (
        <div className="overflow-x-auto border border-line bg-white">
          <table className="text-left text-sm">
            <thead className="bg-slate-100 text-xs uppercase text-slate-600">
              <tr>
                <th className="px-3 py-2">Created</th>
                <th className="px-3 py-2">Market</th>
                <th className="px-3 py-2">Grouped outcomes</th>
                <th className="px-3 py-2">Signal detected</th>
                <th className="px-3 py-2">Target execution</th>
                <th className="px-3 py-2">Actual snapshot</th>
                <th className="px-3 py-2">Delay</th>
                <th className="px-3 py-2">Signal asks</th>
                <th className="px-3 py-2">Fill averages</th>
                <th className="px-3 py-2">Contracts</th>
                <th className="px-3 py-2">Unpaired discarded</th>
                <th className="px-3 py-2">Fee estimate</th>
                <th className="px-3 py-2">Expected edge</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Realized estimated edge</th>
                <th className="px-3 py-2">Failure reason / notes</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((trade) => {
                return (
                  <tr key={trade.id} className="border-t border-line align-top">
                    <td className="px-3 py-2">{formatDate(trade.createdAt)}</td>
                    <td className="max-w-sm px-3 py-2">
                      <div>{trade.market.title}</div>
                      <div className="text-xs text-muted">{trade.market.ticker}</div>
                    </td>
                    <td className="min-w-96 px-3 py-2">
                      {trade.relatedGroup ? (
                        <>
                          <div className="font-medium">{trade.relatedGroup.groupKey}</div>
                          {trade.fills.length === 0 ? (
                            <div className="text-xs text-muted">{readStringArray(trade.relatedGroup.marketTickers).join(", ")}</div>
                          ) : (
                            trade.fills.map((fill) => (
                              <div key={fill.id} className="mt-1 text-xs">
                                {fill.marketTicker ?? fill.legRole ?? fill.outcome}: price {formatPrice(fill.price)}, contracts{" "}
                                {formatContracts(fill.contracts)}
                              </div>
                            ))
                          )}
                        </>
                      ) : (
                        <span className="text-muted">N/A</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div>{formatDate(trade.signal.detectedAt)}</div>
                      <div className="text-xs text-muted">{trade.signal.strategy}</div>
                    </td>
                    <td className="px-3 py-2">{formatDate(trade.targetExecutionTime)}</td>
                    <td className="px-3 py-2">{formatDate(trade.actualSnapshotExecutionTime)}</td>
                    <td className="px-3 py-2">{trade.executionDelaySeconds}s</td>
                    <td className="px-3 py-2">
                      YES {formatPrice(trade.yesAskAtSignal)}
                      <br />
                      NO {formatPrice(trade.noAskAtSignal)}
                    </td>
                    <td className="px-3 py-2">
                      YES {formatPrice(trade.yesFillAveragePrice)}
                      <br />
                      NO {formatPrice(trade.noFillAveragePrice)}
                    </td>
                    <td className="px-3 py-2">
                      YES {formatContracts(trade.yesContractsFilled)}
                      <br />
                      NO {formatContracts(trade.noContractsFilled)}
                      <br />
                      Paired {formatContracts(trade.pairedContracts)}
                    </td>
                    <td className="px-3 py-2">{formatContracts(trade.unpairedContractsDiscarded)}</td>
                    <td className="px-3 py-2">{formatPrice(trade.feeEstimate)}</td>
                    <td className="px-3 py-2">{formatPrice(trade.expectedNetEdge)}</td>
                    <td className="px-3 py-2"><StatusBadge status={trade.status} /></td>
                    <td className="px-3 py-2">{formatPrice(trade.realizedNetEdge)}</td>
                    <td className="min-w-80 px-3 py-2 text-slate-700">{trade.failureReason ?? trade.notes ?? "N/A"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

async function readTrades() {
  try {
    const trades = await prisma.paperTrade.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        market: true,
        signal: true,
        relatedGroup: true,
        fills: { orderBy: { filledAt: "asc" } }
      }
    });
    return { trades, error: null };
  } catch (error) {
    return { trades: [], error: friendlyDbError(error) };
  }
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}
