import { activeValidationFlags, getKalshiRawBidArrays } from "@prediction-market-scanner/core";
import { prisma, type Prisma } from "@prediction-market-scanner/db";
import { DbError, EmptyState, PageHeader, StatusBadge } from "../components";
import { friendlyDbError } from "../lib/db-error";
import { formatContracts, formatIsoDate, formatPrice } from "../lib/format";

export const dynamic = "force-dynamic";

export default async function SnapshotInspectorPage({
  searchParams
}: {
  searchParams: Promise<{ marketId?: string }>;
}) {
  const params = await searchParams;
  const { markets, selectedMarket, snapshot, error } = await readInspectorData(params.marketId);
  const rawProvider = readProviderJson(snapshot?.rawJson);
  const rawArrays = getKalshiRawBidArrays(rawProvider);
  const flags = readFlags(snapshot?.validationFlags);
  const activeFlags = activeValidationFlags(flags);

  return (
    <>
      <PageHeader
        title="Snapshot Inspector"
        description="Inspect latest raw Kalshi orderbook data beside normalized values and validation flags before trusting paper trading."
      />
      <DbError message={error} />
      {markets.length === 0 ? (
        <EmptyState label="No snapshots available yet. Run the worker or npm run collect:sample first." />
      ) : (
        <>
          <form className="mb-4 flex max-w-3xl flex-col gap-2 md:flex-row md:items-end" action="/snapshot-inspector">
            <label className="flex flex-1 flex-col gap-1 text-sm font-medium text-slate-700">
              Market
              <select name="marketId" defaultValue={selectedMarket?.id} className="border border-line bg-white px-3 py-2 text-sm">
                {markets.map((market) => (
                  <option key={market.id} value={market.id}>
                    {market.ticker} - {market.title}
                  </option>
                ))}
              </select>
            </label>
            <button className="border border-slate-400 bg-white px-4 py-2 text-sm font-medium text-slate-800" type="submit">
              Inspect
            </button>
          </form>

          {!snapshot || !selectedMarket ? (
            <EmptyState label="Selected market has no snapshot yet." />
          ) : (
            <div className="grid gap-4">
              <section className="border border-line bg-white p-4">
                <h2 className="text-lg font-semibold">{selectedMarket.title}</h2>
                <div className="mt-2 grid gap-2 text-sm md:grid-cols-3">
                  <Metric label="Ticker" value={selectedMarket.ticker} />
                  <Metric label="Captured at" value={formatIsoDate(snapshot.capturedAt)} />
                  <Metric label="Platform" value={snapshot.platform} />
                </div>
              </section>

              <section className="grid gap-4 lg:grid-cols-2">
                <Panel title="Raw Kalshi bid arrays">
                  <ArrayBlock label="raw yes_dollars / yes array" value={rawArrays.yes} />
                  <ArrayBlock label="raw no_dollars / no array" value={rawArrays.no} />
                </Panel>
                <Panel title="Normalized values and explicit calculations">
                  <div className="grid gap-2 text-sm md:grid-cols-2">
                    <Metric label="Best YES bid" value={formatPrice(snapshot.bestYesBid)} />
                    <Metric label="Best NO bid" value={formatPrice(snapshot.bestNoBid)} />
                    <Metric label="Derived YES ask" value={formatPrice(snapshot.bestYesAsk)} />
                    <Metric label="Derived NO ask" value={formatPrice(snapshot.bestNoAsk)} />
                    <Metric label="Spread" value={formatPrice(snapshot.spread)} />
                    <Metric label="Liquidity used by detector" value={formatContracts(snapshot.liquidityUsedByDetector)} />
                  </div>
                  <div className="mt-4 space-y-2 border-t border-line pt-3 text-sm">
                    <div>derived YES ask = 1.00 - best NO bid = {formatDerived(snapshot.bestNoBid, snapshot.bestYesAsk)}</div>
                    <div>derived NO ask = 1.00 - best YES bid = {formatDerived(snapshot.bestYesBid, snapshot.bestNoAsk)}</div>
                  </div>
                </Panel>
              </section>

              <section className="border border-line bg-white p-4">
                <h3 className="mb-3 text-base font-semibold">Validation flags</h3>
                {activeFlags.length === 0 ? (
                  <StatusBadge status="no_flags" />
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {activeFlags.map((flag) => (
                      <StatusBadge key={flag} status={flag} />
                    ))}
                  </div>
                )}
                <pre className="mt-3 whitespace-pre-wrap bg-slate-50 p-3 text-xs text-slate-700">
                  {snapshot.parseWarnings || "No parse warnings recorded."}
                </pre>
              </section>

              <Panel title="Raw JSON">
                <pre className="max-h-[520px] overflow-auto bg-slate-950 p-4 text-xs text-slate-100">
                  {JSON.stringify(snapshot.rawJson, null, 2)}
                </pre>
              </Panel>
            </div>
          )}
        </>
      )}
    </>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border border-line bg-white p-4">
      <h3 className="mb-3 text-base font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase text-muted">{label}</div>
      <div className="mt-1 break-words font-medium text-ink">{value}</div>
    </div>
  );
}

function ArrayBlock({ label, value }: { label: string; value: unknown[] }) {
  return (
    <div className="mb-4">
      <div className="mb-1 text-xs font-medium uppercase text-muted">{label}</div>
      <pre className="max-h-64 overflow-auto bg-slate-50 p-3 text-xs">{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

async function readInspectorData(marketId?: string) {
  try {
    const markets = await prisma.market.findMany({
      where: { orderbookSnapshots: { some: {} } },
      orderBy: [{ updatedAt: "desc" }],
      take: 250,
      select: { id: true, ticker: true, title: true }
    });
    const selectedMarketId = marketId ?? markets[0]?.id;
    const selectedMarket = markets.find((market) => market.id === selectedMarketId) ?? markets[0] ?? null;
    const snapshot = selectedMarket
      ? await prisma.orderbookSnapshot.findFirst({
          where: { marketId: selectedMarket.id },
          orderBy: { capturedAt: "desc" }
        })
      : null;

    return { markets, selectedMarket, snapshot, error: null };
  } catch (error) {
    return { markets: [], selectedMarket: null, snapshot: null, error: friendlyDbError(error) };
  }
}

function readProviderJson(rawJson: Prisma.JsonValue | undefined): unknown {
  if (!rawJson || typeof rawJson !== "object" || Array.isArray(rawJson)) {
    return rawJson;
  }
  return (rawJson as Record<string, unknown>).provider ?? rawJson;
}

function readFlags(value: Prisma.JsonValue | undefined): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, boolean>;
}

function formatDerived(bid: unknown, ask: unknown): string {
  const bidNumber = hasToNumber(bid) ? bid.toNumber() : Number(bid);
  if (!Number.isFinite(bidNumber)) {
    return `1.00 - N/A = ${formatPrice(ask)}`;
  }
  return `1.00 - ${bidNumber.toFixed(4)} = ${formatPrice(ask)}`;
}

function hasToNumber(value: unknown): value is { toNumber: () => number } {
  return Boolean(value && typeof value === "object" && "toNumber" in value && typeof value.toNumber === "function");
}
