# LinkedIn Outline

## Hook

I built a read-only prediction market research platform to test whether apparent orderbook inefficiencies survive basic market microstructure and execution checks.

## What It Does

- Collects public Kalshi market and orderbook snapshots.
- Normalizes YES/NO bid-only books into research-friendly bid/ask views.
- Stores snapshots with Prisma and Postgres.
- Runs spread-tightening, passive quote markout, fill-proxy, and quote-aggressiveness research.
- Exposes a local dashboard for inspecting markets, snapshots, signals, related groups, and logs.

## What I Learned

- Naive binary complement arbitrage was not enough.
- Wider-spread markets showed more promising spread-tightening behavior.
- Passive quote markout looked encouraging before execution constraints.
- Fillability is the bottleneck: more aggressive quotes filled more often in the proxy but tended to reduce the edge.

## Engineering Angle

- TypeScript monorepo with `apps/web`, `apps/worker`, `packages/core`, and `packages/db`.
- Prisma/Postgres data model for snapshots and research state.
- Reproducible CLI research commands.
- Tests around normalization, validation, detectors, research reports, and worker configuration.

## Honest Caveat

This is not a trading bot and does not place trades. The current results are descriptive research observations from public orderbook snapshots, not proof of a live tradable strategy.

## Next Step

The next serious step would be trade-history-backed fill modeling or an event-driven replay backtester before making any stronger claim about tradability.
