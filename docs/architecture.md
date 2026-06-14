# Architecture

Prediction Market Intelligence Platform is being refactored from a read-only Kalshi scanner into a unified prediction market research system. The current Kalshi scanner remains the working implementation while shared abstractions are introduced in small, reviewable steps.

## Package Roles

- `apps/web` renders the local Next.js dashboard for inspecting markets, snapshots, related groups, signals, paper trades, and logs.
- `apps/worker` runs the live Kalshi collection loop, stores snapshots, runs detectors, records signals, and updates paper-trade simulations.
- `packages/core` owns shared market normalization, validation, detection, grouping, fee, paper-trading, CSV, and future normalized research types.
- `packages/db` owns Prisma schema, migrations, and database client setup.

## Direction

Platform-specific API logic should live behind adapters. Shared market, orderbook, signal, and research types live in core so future detectors can operate on normalized data instead of platform-specific payloads.

Kalshi remains the only active live data source in this phase. Future work can add read-only Polymarket ingestion, shared signal evaluation over normalized markets, and forward-return tracking for signal research without changing the existing scanner behavior first.

## Normalized Kalshi Adapter

`NormalizedKalshiAdapter` wraps the existing `KalshiReadOnlyAdapter` behind the shared `PredictionMarketAdapter` interface. It is read-only, normalizes Kalshi markets and orderbook snapshots for future research paths, and does not replace the current live scanner, worker persistence path, or dashboard behavior.

The current wrapper uses `KalshiReadOnlyAdapter.fetchOpenMarkets` and `KalshiReadOnlyAdapter.fetchOrderbook`; normalized pagination cursors are intentionally not exposed yet because the existing adapter consumes Kalshi pagination internally. The next safe step is to run normalized signal evaluation in parallel against existing persisted snapshots and compare results before switching any production path.

## Parallel Normalized Signal Evaluation

`packages/core` now includes a normalized signal evaluation path for research and parity checks. It converts `NormalizedMarket` and `NormalizedOrderBookSnapshot` inputs into the minimal detector inputs needed by the current binary complement and multi-outcome arbitrage detectors, then returns `NormalizedSignal` records for comparison.

This path is not wired into the production worker or dashboard and does not replace persisted signal creation. The comparison utilities under `packages/core/src/research` compare existing detector outputs with normalized evaluator outputs by practical stable fields such as signal type, platform, market id, outcome id when present, and approximate edge.

The next safe migration step is a CLI or worker-only dry run that reads persisted Kalshi markets and snapshots, evaluates both paths side by side, and reports matched, missing, and extra signals without changing production behavior.

## Normalized Signal Parity Dry Run

Run the read-only parity check manually with:

```sh
npm run parity:normalized
```

The command reads already persisted Kalshi `Market` and `OrderbookSnapshot` rows from the configured database, reconstructs the current detector inputs, evaluates the normalized signal path over the same recent data, compares the outputs with `compareSignalOutputs`, and prints a summary of matched, missing, and extra signals.

It does not fetch live data, does not call the production worker loop, and does not write `Signal`, `PaperTrade`, `RelatedMarketGroup`, `RunLog`, or snapshot rows. It is intentionally a dry run for research parity only.

Optional controls:

```sh
npm run parity:normalized -- --limit 50 --lookback-hours 720
npm run parity:normalized -- --verbose
npm run parity:normalized -- --limit 50 --lookback-hours 720 --debug-counts
```

Environment variables are also supported. In PowerShell, for example:

```powershell
$env:PARITY_VERBOSE="true"
npm run parity:normalized -- --limit 50 --lookback-hours 720
Remove-Item Env:\PARITY_VERBOSE
```

`--limit` and `--lookback-hours` can also be passed as positional fallback values when invoking the worker script directly, where the first positional argument is the market limit and the second is the lookback window in hours. `PARITY_LIMIT`, `PARITY_LOOKBACK_HOURS`, `PARITY_VERBOSE=true`, and `PARITY_DEBUG_COUNTS=true` are supported when no CLI value is provided.

Use `--debug-counts` or `PARITY_DEBUG_COUNTS=true` to print read-only database counts before the parity run: total `Market` rows, total `OrderbookSnapshot` rows, newest market timestamp, newest orderbook snapshot timestamp, and snapshots inside the selected lookback window.

`Matched signals` are outputs that align by signal type, platform, market id, optional outcome id, and estimated edge tolerance. `Missing from normalized` means the existing detector path produced an output that the normalized evaluator did not match. `Extra from normalized` means the normalized evaluator produced an unmatched output. Use `--verbose` or `PARITY_VERBOSE=true` to print a small sample with market id, signal type, estimated edge, and reason.

Production migration should only happen after parity is consistently strong across representative persisted Kalshi data. Until then, the worker continues to use the existing detector and persistence path.

## Forward Return Research Report

Run the read-only forward-return report manually with:

```sh
npm run research:forward-returns -- --limit 500 --lookback-hours 720 --min-age-minutes 240 --order newest
```

The command reads persisted `Signal` rows that are old enough to have future snapshots and already stored `OrderbookSnapshot` rows from the configured database, then estimates how each signal's basket price changed after fixed windows: 15 minutes, 30 minutes, 60 minutes, and 240 minutes. It groups results by persisted signal strategy and prints overall summary rows with count, average absolute return, average percent return, win rate, and missing-exit counts.

`Signal.status` stores `accepted` or `rejected`, and `Signal.reason` stores the human-readable acceptance or rejection reason created by the worker. The report defaults to `--status all`, preserving the original behavior of evaluating accepted and rejected signals together. You can also set `RESEARCH_SIGNAL_STATUS` and `RESEARCH_REJECTION_REASON` when no matching CLI flag is provided.

All signals:

```sh
npm run research:forward-returns -- --limit 500 --lookback-hours 720 --min-age-minutes 240 --order newest
```

Rejected only:

```sh
npm run research:forward-returns -- --limit 500 --lookback-hours 720 --min-age-minutes 240 --order newest --status rejected
```

Accepted only:

```sh
npm run research:forward-returns -- --limit 500 --lookback-hours 720 --min-age-minutes 240 --order newest --status accepted
```

Rejected low-edge only:

```sh
npm run research:forward-returns -- --limit 500 --lookback-hours 720 --min-age-minutes 240 --order newest --status rejected --rejection-reason "low edge"
```

Low-edge baseline:

```sh
npm run research:forward-returns -- --limit 1000 --lookback-hours 720 --min-age-minutes 240 --order newest --status rejected --rejection-reason low_edge
```

Bucket by entry cost:

```sh
npm run research:forward-returns -- --limit 1000 --lookback-hours 720 --min-age-minutes 240 --order newest --status rejected --rejection-reason low_edge --bucket-by entryCost
```

Bucket by edge:

```sh
npm run research:forward-returns -- --limit 1000 --lookback-hours 720 --min-age-minutes 240 --order newest --status rejected --rejection-reason low_edge --bucket-by estimatedEdge
```

Near-miss low-edge report:

```sh
npm run research:forward-returns -- --limit 2000 --lookback-hours 720 --min-age-minutes 240 --order newest --status rejected --rejection-reason low_edge --bucket-by nearMiss
```

Near-miss signals are rejected low-edge candidates close to the minimum net-edge threshold used by the detector. They are not production signals and should not be interpreted as permission to loosen thresholds. The report buckets selected low-edge signals by distance from the minimum net-edge acceptance threshold: `within 0.005`, `within 0.010`, `within 0.020`, and `farther than 0.020`. It also prints the threshold source, the minimum net-edge value used, whether that value came from production config or a fallback, and how many selected low-edge signals had usable `netEdge` values.

Use this report to decide whether a threshold change is justified by forward-return evidence before changing any production settings.

Rejection reason filtering uses persisted `Signal.reason`, plus `rawJson.rejectionCode` for grouped multi-outcome signals when present. Reason matching is normalized so labels such as `low edge`, `empty orderbook`, `missing liquidity`, and `stale snapshot` can match the corresponding persisted rejection text.

Optional bucketed analysis is available with `--bucket-by entryCost|estimatedEdge|netEdge|spread|strategy|reason|nearMiss`, or `RESEARCH_FORWARD_RETURNS_BUCKET_BY` when no CLI flag is provided. Numeric bucket dimensions use only fields already read from persisted `Signal.rawJson`, `Signal` columns, computed entry cost, or entry `OrderbookSnapshot.spread`. Near-miss bucketing uses the selected signal's persisted `netEdge` value and the worker detection config threshold. If the requested field is unavailable for the selected signals, the report prints an unavailable message instead of fabricating buckets.

## Candidate Discovery Report

Run the read-only candidate discovery report manually with:

```sh
npm run research:candidates -- --limit 50000 --lookback-hours 720 --min-age-minutes 240 --status rejected --rejection-reason low_edge --sort-by netEdge --direction desc --top 20
```

The command scans persisted `Signal` rows and stored `OrderbookSnapshot` rows, filters rejected low-edge signals by default, computes candidate fields from already persisted data, ranks the candidates in memory, and prints the top rows. It does not fetch live data, create or update rows, change Prisma schema or migrations, tune thresholds, or change worker behavior.

Best low-edge candidates by net edge:

```sh
npm run research:candidates -- --limit 50000 --lookback-hours 720 --min-age-minutes 240 --status rejected --rejection-reason low_edge --sort-by netEdge --direction desc --top 20
```

Best unique low-edge candidates by netEdge:

```sh
npm run research:candidates -- --limit 10000 --lookback-hours 720 --min-age-minutes 240 --status rejected --rejection-reason low_edge --sort-by netEdge --direction desc --top 20 --dedupe-by ticker
```

Tightest-spread candidates:

```sh
npm run research:candidates -- --limit 50000 --lookback-hours 720 --min-age-minutes 240 --status rejected --rejection-reason low_edge --sort-by spread --direction asc --top 20
```

Best observed 240m return candidates:

```sh
npm run research:candidates -- --limit 50000 --lookback-hours 720 --min-age-minutes 240 --status rejected --rejection-reason low_edge --sort-by return240m --direction desc --top 20
```

Best unique candidates by 240m return:

```sh
npm run research:candidates -- --limit 10000 --lookback-hours 720 --min-age-minutes 240 --status rejected --rejection-reason low_edge --sort-by return240m --direction desc --top 20 --dedupe-by ticker
```

Supported sort fields are `netEdge`, `spread`, `entryCost`, `return15m`, `return60m`, and `return240m`. Missing sort values are placed last. Supported dedupe modes are `none`, `ticker`, and `market`; the default is `none`, and `ticker` and `market` currently use the persisted ticker/market identifier shown in the report. The report table shows rank, detected time, strategy, ticker, net edge, gross edge, entry cost, spread, max contracts, 15m/30m/60m/240m forward returns, and a truncated title.

By default the report uses `--min-age-minutes 15` and `--order oldest`, so a short collection sample can populate the 15-minute window before newer signals are selected. You can also set `RESEARCH_MIN_AGE_MINUTES` when no CLI flag is provided.

For a 30-minute collection sample, use:

```sh
npm run research:forward-returns -- --limit 200 --lookback-hours 720 --min-age-minutes 15 --order oldest
```

The age cutoff is based on the newest available persisted snapshot, not wall-clock time. A 15-minute window requires signals at least 15 minutes older than that newest snapshot. A 30-minute window requires at least 30 minutes of future snapshots. The 60-minute and 240-minute windows require longer collection runs before counts can populate.

The current approximation uses the supported Kalshi-style arbitrage strategies as basket signals:

- `binary_complement_arb`: entry is `YES ask + NO ask`; exit is `YES bid + NO bid` at the first snapshot at or after each forward window.
- `multi_outcome_arb`: entry is total `YES` ask cost from the persisted signal raw JSON, or the sum of leg `YES` asks; exit is the sum of each grouped market's `YES bid` at the first snapshot at or after each forward window.

When persisted signal raw JSON has the original detector price fields, those values are preferred for entry. If they are missing, the report falls back to the signal snapshot id when available, then to the closest stored snapshot around `detectedAt`. Missing future snapshots or missing bid prices are counted as missing exits and excluded from averages.

The report prints a signal selection section with the status filter, optional rejection reason filter, evaluated signal count, selected accepted/rejected counts, and top persisted rejection reasons before the strategy tables. It also prints a coverage diagnostics section with the oldest and newest selected signal timestamps, newest available snapshot timestamp, selected-signal age coverage for each window, selected signals with at least one later snapshot for the same market, selected signals with no later snapshot, and selected signals missing a market identifier. Missing exits are also grouped by simple reasons: `signal_too_recent`, `no_future_snapshot_for_market`, `no_snapshot_at_or_after_window`, `missing_market_identifier`, and `unsupported_strategy_shape`.

This is intentionally a research report, not a trading path. It does not fetch live data, does not create `Signal` rows, does not update paper trades, does not change Prisma schema or migrations, and does not alter worker or dashboard behavior. It only uses Prisma read queries.

Limitations:

- The report marks exits at top-of-book bid prices, so it approximates liquidation value rather than executable depth-aware PnL.
- It does not account for realized settlement, changing fees, queue position, slippage, or partial fills.
- The current persisted schema has no explicit signal side or outcome column, so the report assumes the basket implied by the strategy and detector raw JSON.
- Multi-outcome rows require snapshots for every grouped market at the requested window; otherwise the window is treated as missing.

This matters because parity tells us the normalized evaluator matches the legacy detector, while forward returns tell us whether the signals had useful subsequent price movement. That is the next layer of evidence needed before tightening signal quality thresholds or promoting any normalized research path.

## Spread Tightening Research Report

Run the read-only spread-tightening report manually with:

```sh
npm run research:spread-tightening -- --limit 10000 --lookback-hours 720 --min-age-minutes 240
```

The command reads persisted `OrderbookSnapshot` rows and their related `Market` metadata from the configured database, selects snapshots old enough to have later snapshots, finds the first future snapshot for the same market at or after 15m, 30m, 60m, and 240m windows, and reports whether the entry spread tightened. It evaluates spread behavior only; it does not measure arbitrage profitability and should be used to decide whether spread-based research signals are worth adding later.

Optional controls:

```sh
npm run research:spread-tightening -- --limit 10000 --lookback-hours 720 --min-age-minutes 240 --bucket-by spread --top 20 --window all
npm run research:spread-tightening -- --limit 10000 --lookback-hours 720 --min-age-minutes 240 --dedupe-by ticker --top 20
npm run research:spread-tightening -- --limit 5000 --lookback-hours 168 --min-age-minutes 60 --bucket-by none --top 10 --window 60m
```

Named flags are preferred for clarity. If npm workspace forwarding passes arguments positionally, the script also supports the equivalent form `tsx src/researchSpreadTightening.ts 10000 720 240 spread ticker 20`. When bucket mode is omitted, `tsx src/researchSpreadTightening.ts 10000 720 240 ticker 20` means `bucketBy=spread`, `dedupeBy=ticker`, and `top=20`. A lone fourth positional `none` is treated as `bucketBy=none`; if another dedupe value follows, such as `none ticker`, the first `none` remains the bucket mode and the second value is the dedupe mode.

Supported spread buckets are `< 0.02`, `0.02-0.05`, `0.05-0.10`, and `> 0.10`. Supported top-example dedupe modes are `none`, `ticker`, and `market`; the default is `none` to preserve repeated examples, while `ticker` keeps the strongest tightening row for each ticker and `market` keys by the internal `Market.id`. In the current schema, ticker and market are not equivalent: `Market.id` is the database primary key, while `ticker` is a market metadata field and uniqueness is enforced on `platform + externalMarketId`. The report prints overall rows, entry-spread bucket rows, category summaries, ticker summaries, and top tightening examples. `OrderbookSnapshot.spread` is preferred when present and non-negative; otherwise the report falls back to `bestYesAsk - bestYesBid`, then `bestNoAsk - bestNoBid`.

This is intentionally a research report, not a production signal. It does not fetch live data, create or update rows, write `Signal` records, change detector thresholds, change Prisma schema or migrations, or alter worker behavior. It only uses Prisma read queries against already persisted Kalshi data.

## Spread Tightening Candidate Discovery

Run the read-only spread-tightening candidate discovery report manually with:

```sh
npm run research:spread-candidates -- --limit 10000 --lookback-hours 720 --min-age-minutes 240 --window 240m --min-entry-spread 0.02 --max-entry-spread 0.10 --dedupe-by ticker --top 20
```

Best 60m candidates:

```sh
npm run research:spread-candidates -- --limit 10000 --lookback-hours 720 --min-age-minutes 60 --window 60m --min-entry-spread 0.02 --max-entry-spread 0.10 --dedupe-by ticker --top 20
```

The command reads persisted `OrderbookSnapshot` rows and related `Market` metadata, builds the same spread-tightening rows as the spread-tightening research report, filters to one future window and entry-spread range, then ranks the strongest unique candidates. Supported filters and ranking controls are `--limit`, `--lookback-hours`, `--min-age-minutes`, `--window 15m|30m|60m|240m`, `--min-entry-spread`, `--max-entry-spread`, `--dedupe-by none|ticker|market`, `--sort-by spreadChange|tightenPct|entrySpread|futureSpread`, `--direction asc|desc`, and `--top`.

Named flags are preferred for clarity. If npm workspace forwarding passes arguments positionally, the script also supports `tsx src/researchSpreadCandidates.ts 10000 720 240 240m 0.02 0.10 ticker 20`, interpreted as `limit lookbackHours minAgeMinutes window minEntrySpread maxEntrySpread dedupeBy top`, and the full form `tsx src/researchSpreadCandidates.ts 10000 720 240 240m 0.02 0.10 ticker spreadChange asc 20`, interpreted as `limit lookbackHours minAgeMinutes window minEntrySpread maxEntrySpread dedupeBy sortBy direction top`.

Defaults are `window=240m`, `minEntrySpread=0.02`, `maxEntrySpread=0.10`, `dedupeBy=ticker`, `sortBy=spreadChange`, `direction=asc`, and `top=20`. Sorting by `spreadChange asc` puts the most negative spread changes first, which are the strongest observed tightening candidates. When deduping by ticker or market, the command keeps the strongest already-ranked row for that key.

This is read-only research tooling. It does not place trades, create or update database rows, write `Signal` records, change detector thresholds, change Prisma schema or migrations, or alter worker behavior. The purpose is to decide whether spread-tightening deserves a production signal later.

## Maker Quote Simulation Report

Run the read-only maker-quote simulation report manually with:

```sh
npm run research:maker-quotes -- --limit 50000 --lookback-hours 720 --min-age-minutes 240 --window 240m --min-entry-spread 0.04 --max-entry-spread 0.10 --quote-mode midpoint --dedupe-by ticker --top 20
```

60m bid-plus-tick simulation:

```sh
npm run research:maker-quotes -- --limit 50000 --lookback-hours 720 --min-age-minutes 60 --window 60m --min-entry-spread 0.04 --max-entry-spread 0.10 --quote-mode bid_plus_tick --tick-size 0.01 --dedupe-by ticker --top 20
```

The command reads persisted `OrderbookSnapshot` rows and related `Market` metadata, selects snapshots with a YES-side entry spread in the requested range, simulates a passive buy quote from the stored best YES bid/ask, then finds the first future snapshot for the same market at or after the requested window. It computes quote price, future midpoint, markout, markout percent, favorable rate, and whether the future spread tightened.

Supported controls are `--limit`, `--lookback-hours`, `--min-age-minutes`, `--window 15m|30m|60m|240m`, `--min-entry-spread`, `--max-entry-spread`, `--quote-mode midpoint|bid_plus_tick`, `--tick-size`, `--dedupe-by none|ticker|market`, `--sort-by markout|markoutPct|spreadChange|entrySpread`, `--direction asc|desc`, and `--top`. Defaults are `window=240m`, `minEntrySpread=0.04`, `maxEntrySpread=0.10`, `quoteMode=midpoint`, `tickSize=0.01`, `dedupeBy=ticker`, `sortBy=markout`, `direction=desc`, and `top=20`. If tick size is not supplied, the report uses `0.01`.

Named flags are preferred for clarity. If npm workspace forwarding passes arguments positionally, the script also supports `tsx src/researchMakerQuotes.ts 50000 720 240 240m 0.04 0.10 midpoint ticker 20`, interpreted as `limit lookbackHours minAgeMinutes window minEntrySpread maxEntrySpread quoteMode dedupeBy top` with the default tick size, sort field, and direction. The full positional form is `tsx src/researchMakerQuotes.ts 50000 720 240 240m 0.04 0.10 midpoint 0.01 ticker markout desc 20`, interpreted as `limit lookbackHours minAgeMinutes window minEntrySpread maxEntrySpread quoteMode tickSize dedupeBy sortBy direction top`.

This is not real execution and does not assume fills. It is a conservative research proxy for whether quoting inside wide spreads would have had favorable future markout. It does not place trades, create or update database rows, write `Signal` records, tune thresholds, change Prisma schema or migrations, or alter worker behavior.

## Maker Quote Fill Proxy Research Report

Run the read-only fill proxy report manually with:

```sh
npm run research:fill-proxy -- --limit 50000 --lookback-hours 720 --min-age-minutes 240 --markout-window 240m --fill-window 60m --min-entry-spread 0.04 --max-entry-spread 0.10 --quote-mode bid_plus_tick --tick-size 0.01 --dedupe-by ticker --top 20
```

60m markout with a 15m fill proxy:

```sh
npm run research:fill-proxy -- --limit 50000 --lookback-hours 720 --min-age-minutes 60 --markout-window 60m --fill-window 15m --min-entry-spread 0.04 --max-entry-spread 0.10 --quote-mode bid_plus_tick --tick-size 0.01 --dedupe-by ticker --top 20
```

The command reads persisted `OrderbookSnapshot` rows and related `Market` metadata, builds the same passive maker-quote candidate rows as the maker-quote simulation report, then looks forward within the fill window for later same-market snapshots where `bestYesAsk <= quotePrice`. That condition marks a quote as `possibleFill` and records the first matching snapshot time and minutes from entry. It combines that proxy with the requested markout window so the report can show fillable rate, favorable-if-fillable rate, average markout for fillable rows, and unfillable-but-favorable counts.

Supported controls are `--limit`, `--lookback-hours`, `--min-age-minutes`, `--markout-window 15m|30m|60m|240m`, `--fill-window 5m|15m|30m|60m|240m`, `--min-entry-spread`, `--max-entry-spread`, `--quote-mode midpoint|bid_plus_tick`, `--tick-size`, `--dedupe-by none|ticker|market`, `--sort-by markout|markoutPct|timeToFill|quotePrice`, `--direction asc|desc`, and `--top`. Defaults are `markoutWindow=240m`, `fillWindow=60m`, `minEntrySpread=0.04`, `maxEntrySpread=0.10`, `quoteMode=bid_plus_tick`, `tickSize=0.01`, `dedupeBy=ticker`, `sortBy=markout`, `direction=desc`, and `top=20`.

Named flags are preferred for clarity. If npm workspace forwarding passes arguments positionally, the script also supports `tsx src/researchFillProxy.ts 50000 720 240 240m 60m 0.04 0.10 bid_plus_tick 0.01 ticker 20`, interpreted as `limit lookbackHours minAgeMinutes markoutWindow fillWindow minEntrySpread maxEntrySpread quoteMode tickSize dedupeBy top`. The full positional form is `tsx src/researchFillProxy.ts 50000 720 240 240m 60m 0.04 0.10 bid_plus_tick 0.01 ticker markout desc 20`, interpreted as `limit lookbackHours minAgeMinutes markoutWindow fillWindow minEntrySpread maxEntrySpread quoteMode tickSize dedupeBy sortBy direction top`. If the tick size is omitted, such as `tsx src/researchFillProxy.ts 50000 720 240 240m 60m 0.04 0.10 bid_plus_tick ticker 20`, the script uses the default tick size of `0.01`.

This is not proof of fills. It only uses snapshot-level top-of-book ask crossing as a possible-fill proxy; it does not model queue position, displayed depth consumption, cancellations, partial fills, or hidden liquidity. It does not place orders, create or update database rows, write `Signal` records, tune thresholds, change Prisma schema or migrations, or alter worker behavior.

## Quote Aggressiveness Sweep Report

Run the read-only quote aggressiveness sweep manually with:

```sh
npm run research:quote-sweep -- --limit 50000 --lookback-hours 720 --min-age-minutes 240 --markout-window 240m --fill-window 240m --min-entry-spread 0.04 --max-entry-spread 0.10 --tick-size 0.01 --dedupe-by ticker --top 20
```

60m markout with a 60m fill proxy:

```sh
npm run research:quote-sweep -- --limit 50000 --lookback-hours 720 --min-age-minutes 60 --markout-window 60m --fill-window 60m --min-entry-spread 0.04 --max-entry-spread 0.10 --tick-size 0.01 --dedupe-by ticker --top 20
```

The command reads persisted `OrderbookSnapshot` rows and related `Market` metadata, selects base candidate snapshots with a YES-side entry spread in the requested range, dedupes those base candidates, then expands each remaining candidate across quote levels: `bid_plus_1_tick`, `bid_plus_2_ticks`, `bid_plus_3_ticks`, `midpoint`, and `ask_minus_1_tick`. Base candidate dedupe happens before quote expansion; with `--dedupe-by ticker` or `--dedupe-by market`, it keeps the strongest original `bid_plus_tick` markout for that key.

For each quote level, the report compares fillability versus markout. `possibleFill` uses the same snapshot-level fill proxy as the fill-proxy report: any later same-market snapshot within the fill window where `bestYesAsk <= quotePrice`. Markout uses the future midpoint at the requested markout window. Quote levels whose computed price is invalid or outside the current `[bestYesBid, bestYesAsk]` range are skipped for that base row and counted in `skippedCount`.

Supported controls are `--limit`, `--lookback-hours`, `--min-age-minutes`, `--markout-window 15m|30m|60m|240m`, `--fill-window 5m|15m|30m|60m|240m`, `--min-entry-spread`, `--max-entry-spread`, `--tick-size`, `--dedupe-by none|ticker|market`, and `--top`. Defaults are `limit=50000`, `lookbackHours=720`, `minAgeMinutes=240`, `markoutWindow=240m`, `fillWindow=240m`, `minEntrySpread=0.04`, `maxEntrySpread=0.10`, `tickSize=0.01`, `dedupeBy=ticker`, and `top=20`.

This is not real execution. It compares possible fillability versus future markout across quote aggressiveness levels and does not place orders. It does not create or update database rows, write `Signal` records, tune thresholds, change Prisma schema or migrations, call trading APIs, or alter worker behavior.

## Spread Persistence Research Report

Run the read-only spread-persistence report manually with:

```sh
npm run research:spread-persistence -- --limit 50000 --lookback-hours 720 --min-spread 0.04 --max-spread 0.10 --dedupe-by ticker --top 20
```

The command reads persisted `OrderbookSnapshot` rows and related `Market` metadata, computes each snapshot spread with the same stored-spread-first fallback used by spread-tightening research, and groups snapshots into contiguous wide-spread episodes. An episode starts when a market enters the configured spread range, continues while later snapshots for the same ticker and market remain inside the range, and ends when the spread leaves the range, the ticker or market changes, or the gap between snapshots exceeds `--max-gap-minutes`. The default max gap is 2 minutes.

Supported controls are `--limit`, `--lookback-hours`, `--min-spread`, `--max-spread`, `--max-gap-minutes`, `--dedupe-by none|ticker|market`, and `--top`. Defaults are `limit=50000`, `lookbackHours=720`, `minSpread=0.04`, `maxSpread=0.10`, `maxGapMinutes=2`, `dedupeBy=ticker`, and `top=20`. Top episodes are ranked by longest duration, then snapshot count, then earliest start. With `--dedupe-by ticker`, the top table shows only the longest episode per ticker.

Named flags are preferred for clarity. If npm workspace forwarding passes arguments positionally, the script also supports `tsx src/researchSpreadPersistence.ts 50000 720 0.04 0.10 ticker 20`, interpreted as `limit lookbackHours minSpread maxSpread dedupeBy top` with the default max gap, and `tsx src/researchSpreadPersistence.ts 50000 720 0.04 0.10 2 ticker 20`, interpreted as `limit lookbackHours minSpread maxSpread maxGapMinutes dedupeBy top`.

Persistence helps decide whether spread-tightening candidates are realistic enough to simulate later. One-snapshot wide spreads can describe a spread that already vanished by the next poll, while persistent episodes suggest the wide state lasted long enough to potentially matter for execution research. This report still does not prove tradeability; it only measures duration and spread persistence before any execution simulation.

This is intentionally read-only research tooling. It does not fetch live data, create or update database rows, write `Signal` records, tune thresholds, change Prisma schema or migrations, or alter worker behavior.
