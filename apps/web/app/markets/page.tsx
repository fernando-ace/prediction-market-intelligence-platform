import { prisma } from "@prediction-market-scanner/db";
import { DbError, EmptyState, PageHeader, StatusBadge } from "../components";
import { friendlyDbError } from "../lib/db-error";
import { formatDate, formatPrice } from "../lib/format";

export const dynamic = "force-dynamic";

export default async function MarketsPage() {
  const { markets, error } = await readMarkets();

  return (
    <>
      <PageHeader
        title="Live Markets"
        description="Latest normalized orderbook snapshot per tracked market. Prices are decimals from 0 to 1."
      />
      <DbError message={error} />
      {markets.length === 0 ? (
        <EmptyState label="No markets tracked yet. Start the worker to collect Kalshi market data." />
      ) : (
        <div className="overflow-x-auto border border-line bg-white">
          <table className="text-left text-sm">
            <thead className="bg-slate-100 text-xs uppercase text-slate-600">
              <tr>
                <th className="px-3 py-2">Market</th>
                <th className="px-3 py-2">Platform</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Close time</th>
                <th className="px-3 py-2">YES bid</th>
                <th className="px-3 py-2">YES ask</th>
                <th className="px-3 py-2">NO bid</th>
                <th className="px-3 py-2">NO ask</th>
                <th className="px-3 py-2">Spread</th>
                <th className="px-3 py-2">Last snapshot</th>
              </tr>
            </thead>
            <tbody>
              {markets.map((market) => {
                const snapshot = market.orderbookSnapshots[0];
                return (
                  <tr key={market.id} className="border-t border-line align-top">
                    <td className="max-w-md px-3 py-2">
                      <div className="font-medium text-ink">{market.title}</div>
                      <div className="text-xs text-muted">{market.ticker}</div>
                    </td>
                    <td className="px-3 py-2">{market.platform}</td>
                    <td className="px-3 py-2"><StatusBadge status={market.status} /></td>
                    <td className="px-3 py-2">{formatDate(market.closeTime)}</td>
                    <td className="px-3 py-2">{formatPrice(snapshot?.bestYesBid)}</td>
                    <td className="px-3 py-2">{formatPrice(snapshot?.bestYesAsk)}</td>
                    <td className="px-3 py-2">{formatPrice(snapshot?.bestNoBid)}</td>
                    <td className="px-3 py-2">{formatPrice(snapshot?.bestNoAsk)}</td>
                    <td className="px-3 py-2">{formatPrice(snapshot?.spread)}</td>
                    <td className="px-3 py-2">{formatDate(snapshot?.capturedAt)}</td>
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

async function readMarkets() {
  try {
    const markets = await prisma.market.findMany({
      orderBy: [{ status: "asc" }, { closeTime: "asc" }, { updatedAt: "desc" }],
      take: 200,
      include: {
        orderbookSnapshots: {
          orderBy: { capturedAt: "desc" },
          take: 1
        }
      }
    });
    return { markets, error: null };
  } catch (error) {
    return { markets: [], error: friendlyDbError(error) };
  }
}
