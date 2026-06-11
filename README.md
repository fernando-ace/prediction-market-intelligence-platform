# Prediction Market Arbitrage Scanner

A read-only research tool for scanning prediction market orderbooks, identifying potential pricing inefficiencies, and evaluating them with paper-trading simulations.

**Project Status: MVP / Research Prototype**

This project is functional as a local read-only scanner and paper-trading research tool. It is not a production trading system.

## Overview

Prediction Market Arbitrage Scanner collects public Kalshi market and orderbook data, normalizes bid-only binary orderbooks into derived bid/ask views, and evaluates simple pricing inefficiencies with conservative validation rules.

The app currently:

- Collects public Kalshi market and orderbook data.
- Normalizes Kalshi YES/NO bid-only orderbooks into derived bid/ask views.
- Detects simple binary complement opportunities.
- Groups related markets and evaluates multi-outcome YES basket pricing.
- Simulates paper trades using delayed snapshots and conservative fee buffers.
- Provides a local dashboard for inspecting markets, snapshots, signals, related groups, paper trades, logs, and CSV exports.

## Why I Built This

I wanted to explore how market microstructure, orderbook data, and automated validation could apply to prediction markets. I focused on building a safe read-only scanner before considering any live trading so that the data collection, normalization, detection, and simulation layers could be inspected on their own.

This project helped me practice data engineering, API integration, Prisma/Postgres modeling, TypeScript architecture, and realistic simulation against imperfect live market data.

## Features

- Kalshi read-only market collector.
- Orderbook snapshot storage.
- YES/NO bid-to-ask normalization.
- Snapshot validation flags for missing books, invalid prices, stale data, and crossed markets.
- Binary complement arbitrage detector.
- Related-market / multi-outcome detector.
- Conservative paper trading simulator.
- Dashboard pages:
  - Home
  - Live Markets
  - Snapshot Inspector
  - Related Groups
  - Signals
  - Paper Trades
  - Logs
  - CSV export
- CLI/sample collection tools.
- Overnight related-market reporting command.
- Tests for parsing, grouping, detection, validation, configuration, CSV export, and paper trading behavior.

## Architecture

This repository is organized as a small TypeScript monorepo:

- `apps/web`: Next.js dashboard for local inspection of markets, snapshots, related groups, signals, paper trades, logs, and CSV exports.
- `apps/worker`: Node.js worker that collects Kalshi data, stores snapshots, runs detectors, records signals, and creates simulated paper trades.
- `packages/core`: Shared normalization, validation, detection, grouping, CSV, fee-buffer, and paper-trading logic.
- `packages/db`: Prisma schema, generated client setup, and database migrations for Postgres.

```text
Kalshi API -> Worker -> Normalizer -> Postgres -> Detectors -> Paper Trader -> Dashboard
```

## Safety and Scope

This project is intentionally scoped as a research and software engineering demonstration.

- It is read-only.
- It uses public Kalshi market and orderbook data.
- It does not place trades.
- It does not use authenticated order placement.
- It does not connect wallets.
- It does not use private information.
- It does not store private keys.
- It does not guarantee profit.
- It uses simulated paper trades only.
- Paper-trading results are not equivalent to live trading results.

## How It Works

1. Fetch active Kalshi markets.
2. Select liquid and active markets.
3. Fetch orderbook snapshots.
4. Normalize YES/NO bid-only orderbooks.
5. Store snapshots in Postgres.
6. Run detectors.
7. Record accepted and rejected signals with reasons.
8. Simulate paper trades only when signals pass validation.
9. Show results in the dashboard.

## Detectors

### Binary Complement Detector

For a binary market, YES ask plus NO ask should normally be around `1`. If the combined cost is below `1` after fees and liquidity checks, it may indicate a possible pricing inefficiency.

The detector uses derived ask prices from Kalshi's bid-only orderbooks:

- `bestYesAsk = 1 - bestNoBid`
- `bestNoAsk = 1 - bestYesBid`

Signals are rejected when markets are closed or expired, liquidity is missing, validation flags are present, or the estimated edge is too small after fee buffers.

### Related-Market / Multi-Outcome Detector

The system groups related Kalshi markets, such as two head-to-head winner markets, and checks whether buying YES on all mutually exclusive outcomes would cost less than `1` after fees.

The detector is intentionally conservative. It rejects props, thresholds, spreads, stat markets, multivariate combo markets, unclear settlement rules, mismatched close times, and unclear groups.

## Paper Trading Model

The simulator is designed to be conservative and inspectable:

- Uses delayed execution snapshots.
- Never fills at midpoint.
- Buys at ask.
- Applies conservative fee buffers.
- Handles partial fills.
- Records rejected signals.
- Records leg risk and discarded unpaired contracts when liquidity is uneven.

The simulator does not yet model queue position, cancellations, adverse selection, or exact exchange fee accounting.

## Tech Stack

- TypeScript
- Next.js
- Node.js
- Postgres
- Prisma
- Tailwind CSS
- Vitest
- Docker Compose for local Postgres

## Local Setup

```powershell
npm install
Copy-Item .env.example .env -Force
docker compose up -d
npm run db:generate
npm run db:migrate
npm test
npm run lint
npm run build
npm run dev
```

In another terminal, start the worker:

```powershell
$env:MAX_MARKETS="50"
$env:KALSHI_CANDIDATE_MARKET_LIMIT="1000"
$env:INCLUDE_MVE_MARKETS="false"
$env:POLL_INTERVAL_SECONDS="60"
$env:PAPER_EXECUTION_DELAY_SECONDS="30"
$env:MIN_NET_EDGE="0.01"
npm run worker
```

Collect a bounded live-data validation sample:

```powershell
$env:MAX_MARKETS="100"
$env:KALSHI_CANDIDATE_MARKET_LIMIT="2000"
$env:SAMPLE_DURATION_SECONDS="600"
npm run collect:sample
```

Generate an overnight related-market report:

```powershell
npm run report:overnight
```

## Environment Variables

The project uses safe local defaults and public Kalshi endpoints. Do not commit a real `.env` file.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string for Prisma. |
| `KALSHI_BASE_URL` | Public Kalshi trade API base URL. |
| `MAX_MARKETS` | Maximum selected markets to collect per cycle. |
| `KALSHI_CANDIDATE_MARKET_LIMIT` | Number of Kalshi markets to consider before selecting active candidates. |
| `INCLUDE_MVE_MARKETS` | Opt-in flag for including multivariate Kalshi markets. Defaults to `false`. |
| `POLL_INTERVAL_SECONDS` | Worker orderbook polling interval. |
| `SAMPLE_DURATION_SECONDS` | Duration for bounded sample collection. |
| `SAMPLE_POLL_INTERVAL_SECONDS` | Polling interval for sample collection. |
| `PAPER_EXECUTION_DELAY_SECONDS` | Delay between signal detection and simulated execution. |
| `MIN_NET_EDGE` | Minimum estimated net edge required for an accepted signal. |
| `MIN_LIQUIDITY_CONTRACTS` | Minimum available paired liquidity for detector acceptance. |
| `FEE_BUFFER_PER_CONTRACT` | Conservative per-contract fee buffer. |
| `FEE_BUFFER_PERCENT_OF_NOTIONAL` | Conservative percentage-of-notional fee buffer. |

## Validation Results

During local validation, the scanner successfully collected thousands of Kalshi orderbook snapshots, rejected invalid or low-edge signals, and avoided creating paper trades from incomplete liquidity. The current detectors are conservative and did not identify a validated positive-edge opportunity during the latest sample runs.

These results should be treated as validation of the software workflow, not as evidence of a profitable strategy.

## Limitations

- Kalshi only.
- Read-only market data.
- Conservative fee buffer, not exact fee modeling.
- Polling instead of WebSockets.
- No queue position modeling.
- No cancellation or adverse selection modeling.
- Related-market grouping is intentionally conservative.
- Paper trading results are not equivalent to live trading results.
- The local dashboard does not include production authentication or deployment hardening.

## Potential Extensions

These are optional research and engineering directions, not required work for the current MVP:

- More exact fee modeling.
- WebSocket orderbook updates.
- Better edge distribution reporting.
- More related-market detectors.
- Threshold ladder consistency checks.
- Polymarket read-only comparison.
- Alerting.
- Better historical replay tools.

## Screenshots

Screenshot placeholders live under `docs/screenshots/`.

- Dashboard overview: `docs/screenshots/dashboard-overview.png`
- Snapshot Inspector: `docs/screenshots/snapshot-inspector.png`
- Related Groups: `docs/screenshots/related-groups.png`
- Signals: `docs/screenshots/signals.png`
- Paper Trades: `docs/screenshots/paper-trades.png`

