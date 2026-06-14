# 90-120 Second Demo Script

This is the Prediction Market Intelligence Platform. It is a read-only TypeScript monorepo for researching Kalshi prediction market orderbooks, not a trading bot.

The project collects public market and orderbook snapshots, normalizes Kalshi's YES/NO bid-only books into derived bid and ask views, stores the data in Postgres through Prisma, and exposes both a local dashboard and research commands.

The first idea I tested was a simple binary complement arbitrage baseline: if YES ask plus NO ask is meaningfully below one dollar after fees and liquidity checks, there may be an inefficiency. That baseline turned out to be weak. The rejected low-edge signals were consistently negative, and the evidence did not support loosening thresholds.

The stronger research direction came from spread tightening. Wider-spread markets in the sample tended to tighten later, and some wide spreads persisted long enough to be more than one-snapshot noise. I then tested passive quote markout, especially bid-plus-tick style quotes, to see whether those entries had favorable future midpoint movement.

The important caveat is fillability. Conservative quotes had the best markout, but the fill proxy suggested they might not fill often. More aggressive quotes filled more often in the proxy, but tended to give up the edge. That is the main research conclusion: the descriptive signal is promising, but execution realism is the bottleneck.

If I continued the project, I would collect or integrate trade history, improve the fill model, and build a true event-driven backtester before treating the signal as tradable. The value of this project is the full research workflow: data ingestion, normalization, TypeScript architecture, reproducible commands, tests, and honest reporting of where the strategy does and does not hold up.
