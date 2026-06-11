import { estimateLegFee } from "./fees";
import { roundPrice } from "./kalshi";
import type {
  FeeSettings,
  NormalizedOrderbook,
  PaperFillResult,
  PaperSignalInput,
  PaperTradeSimulation,
  PriceLevel
} from "./types";

export interface PaperSimulationConfig {
  executionDelaySeconds: number;
  feeSettings: FeeSettings;
}

export interface MultiOutcomePaperSignalInput {
  detectedAt: Date;
  expectedNetEdge: number;
  maxContracts: number;
  legs: Array<{
    marketId?: string;
    marketTicker: string;
    yesAskAtSignal?: number | null;
    snapshots: NormalizedOrderbook[];
  }>;
}

interface FillAtAskResult {
  contracts: number;
  averagePrice: number | null;
  fills: Array<{ price: number; contracts: number }>;
}

export function simulateComplementPaperTrade(
  signal: PaperSignalInput,
  snapshots: NormalizedOrderbook[],
  config: PaperSimulationConfig
): PaperTradeSimulation {
  const executionTime = new Date(signal.detectedAt.getTime() + config.executionDelaySeconds * 1000);
  const executionSnapshot = snapshots
    .filter((snapshot) => snapshot.capturedAt >= executionTime)
    .sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime())[0];

  if (!executionSnapshot) {
    return failedSimulation({
      executionTime,
      config,
      signal,
      notes: "Failed: no orderbook snapshot exists at or after the simulated execution time.",
      failureReason: "No eligible execution snapshot."
    });
  }

  const targetContracts = Math.max(0, signal.maxContracts);
  const yes = fillAtAsk(executionSnapshot.yesAsks, targetContracts);
  const no = fillAtAsk(executionSnapshot.noAsks, targetContracts);
  const pairedContracts = Math.min(yes.contracts, no.contracts);
  const legRisk = yes.contracts !== no.contracts || pairedContracts < targetContracts;

  if (pairedContracts <= 0 || yes.averagePrice === null || no.averagePrice === null) {
    return failedSimulation({
      executionTime,
      config,
      signal,
      actualSnapshotExecutionTime: executionSnapshot.capturedAt,
      notes: "Failed: both YES and NO legs could not be filled at available asks.",
      failureReason: "Both YES and NO legs could not be filled at available asks.",
      legRisk
    });
  }

  const pairedYesFills = capFillsToContracts(yes.fills, pairedContracts);
  const pairedNoFills = capFillsToContracts(no.fills, pairedContracts);
  const pairedYesAveragePrice = averageFillPrice(pairedYesFills);
  const pairedNoAveragePrice = averageFillPrice(pairedNoFills);

  if (pairedYesAveragePrice === null || pairedNoAveragePrice === null) {
    return failedSimulation({
      executionTime,
      config,
      signal,
      actualSnapshotExecutionTime: executionSnapshot.capturedAt,
      notes: "Failed: paired YES and NO fills could not be constructed from available ask depth.",
      failureReason: "Paired YES and NO fills could not be constructed from available ask depth.",
      legRisk
    });
  }

  const fills: PaperFillResult[] = [
    ...toPaperFills("yes", pairedYesFills, executionSnapshot.capturedAt, config.feeSettings),
    ...toPaperFills("no", pairedNoFills, executionSnapshot.capturedAt, config.feeSettings)
  ];

  const fees = estimateLegFee(pairedContracts, config.feeSettings) * 2;
  const realizedPerContract = roundPrice(
    1 -
      pairedYesAveragePrice -
      pairedNoAveragePrice -
      (config.feeSettings.feeBufferPerContract + (config.feeSettings.feeBufferPercentOfNotional ?? 0))
  );
  const realizedNetEdge = roundPrice(realizedPerContract * pairedContracts);
  const fullyFilled = pairedContracts >= targetContracts && !legRisk;
  const unpairedContractsDiscarded = roundPrice(Math.max(0, yes.contracts - pairedContracts) + Math.max(0, no.contracts - pairedContracts));

  return {
    status: fullyFilled ? "filled" : "partial",
    executionTime,
    executionDelaySeconds: config.executionDelaySeconds,
    expectedNetEdge: signal.expectedNetEdge,
    realizedNetEdge,
    fills,
    notes: `${fullyFilled ? "Filled" : "Partial"} paper trade: bought ${pairedContracts} paired contracts at asks with ${fees.toFixed(4)} estimated fees.${legRisk ? " Leg risk recorded because side fills differed." : ""}`,
    legRisk,
    targetExecutionTime: executionTime,
    actualSnapshotExecutionTime: executionSnapshot.capturedAt,
    yesAskAtSignal: signal.yesAskAtSignal ?? null,
    noAskAtSignal: signal.noAskAtSignal ?? null,
    yesFillAveragePrice: pairedYesAveragePrice,
    noFillAveragePrice: pairedNoAveragePrice,
    yesContractsFilled: pairedContracts,
    noContractsFilled: pairedContracts,
    pairedContracts,
    unpairedContractsDiscarded,
    feeEstimate: roundPrice(fees),
    failureReason: null
  };
}

export function simulateMultiOutcomePaperTrade(
  signal: MultiOutcomePaperSignalInput,
  config: PaperSimulationConfig
): PaperTradeSimulation {
  const executionTime = new Date(signal.detectedAt.getTime() + config.executionDelaySeconds * 1000);
  const executionLegs = signal.legs.map((leg) => {
    const snapshot = leg.snapshots
      .filter((candidate) => candidate.capturedAt >= executionTime)
      .sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime())[0];
    return { ...leg, snapshot };
  });

  if (executionLegs.some((leg) => !leg.snapshot)) {
    return failedSimulation({
      executionTime,
      config,
      signal: {
        detectedAt: signal.detectedAt,
        expectedNetEdge: signal.expectedNetEdge,
        maxContracts: signal.maxContracts
      },
      notes: "Failed: at least one outcome has no orderbook snapshot at or after the simulated execution time.",
      failureReason: "No eligible execution snapshot for every group outcome.",
      legRisk: true
    });
  }

  const targetContracts = Math.max(0, signal.maxContracts);
  const fillsByLeg = executionLegs.map((leg) => ({
    ...leg,
    fill: fillAtAsk(leg.snapshot?.yesAsks ?? [], targetContracts)
  }));
  const pairedContracts = Math.min(...fillsByLeg.map((leg) => leg.fill.contracts));
  const groupFillRisk = fillsByLeg.some((leg) => leg.fill.contracts !== targetContracts) || pairedContracts < targetContracts;

  if (pairedContracts <= 0 || fillsByLeg.some((leg) => leg.fill.averagePrice === null)) {
    return failedSimulation({
      executionTime,
      config,
      signal: {
        detectedAt: signal.detectedAt,
        expectedNetEdge: signal.expectedNetEdge,
        maxContracts: signal.maxContracts
      },
      actualSnapshotExecutionTime: earliestActualSnapshotTime(executionLegs),
      notes: "Failed: every group outcome could not be filled at available YES asks.",
      failureReason: "Every group outcome could not be filled at available YES asks.",
      legRisk: true
    });
  }

  const cappedByLeg = fillsByLeg.map((leg) => {
    const cappedFills = capFillsToContracts(leg.fill.fills, pairedContracts);
    return {
      ...leg,
      cappedFills,
      averagePrice: averageFillPrice(cappedFills)
    };
  });

  if (cappedByLeg.some((leg) => leg.averagePrice === null)) {
    return failedSimulation({
      executionTime,
      config,
      signal: {
        detectedAt: signal.detectedAt,
        expectedNetEdge: signal.expectedNetEdge,
        maxContracts: signal.maxContracts
      },
      actualSnapshotExecutionTime: earliestActualSnapshotTime(executionLegs),
      notes: "Failed: grouped fills could not be constructed from available ask depth.",
      failureReason: "Grouped fills could not be constructed from available ask depth.",
      legRisk: true
    });
  }

  const fills: PaperFillResult[] = cappedByLeg.flatMap((leg) =>
    toPaperFills("yes", leg.cappedFills, leg.snapshot?.capturedAt ?? executionTime, config.feeSettings).map((fill) => ({
      ...fill,
      marketId: leg.marketId,
      marketTicker: leg.marketTicker,
      legRole: leg.marketTicker
    }))
  );
  const fees = estimateLegFee(pairedContracts, config.feeSettings) * cappedByLeg.length;
  const averagePriceTotal = cappedByLeg.reduce((sum, leg) => sum + (leg.averagePrice ?? 0), 0);
  const realizedNetEdge = roundPrice((1 - averagePriceTotal) * pairedContracts - fees);
  const fullyFilled = pairedContracts >= targetContracts && !groupFillRisk;
  const unpairedContractsDiscarded = roundPrice(
    fillsByLeg.reduce((sum, leg) => sum + Math.max(0, leg.fill.contracts - pairedContracts), 0)
  );
  const firstSignalAsk = signal.legs[0]?.yesAskAtSignal ?? null;
  const secondSignalAsk = signal.legs[1]?.yesAskAtSignal ?? null;
  const firstAveragePrice = cappedByLeg[0]?.averagePrice ?? null;
  const secondAveragePrice = cappedByLeg[1]?.averagePrice ?? null;

  return {
    status: fullyFilled ? "filled" : "partial",
    executionTime,
    executionDelaySeconds: config.executionDelaySeconds,
    expectedNetEdge: signal.expectedNetEdge,
    realizedNetEdge,
    fills,
    notes: `${fullyFilled ? "Filled" : "Partial"} grouped paper trade: bought YES on ${cappedByLeg.length} outcomes for ${pairedContracts} grouped contracts at asks with ${fees.toFixed(4)} estimated fees.${groupFillRisk ? " Group fill risk recorded because outcome fills differed or were partial." : ""}`,
    legRisk: groupFillRisk,
    groupFillRisk,
    targetExecutionTime: executionTime,
    actualSnapshotExecutionTime: earliestActualSnapshotTime(executionLegs),
    yesAskAtSignal: firstSignalAsk,
    noAskAtSignal: secondSignalAsk,
    yesFillAveragePrice: firstAveragePrice,
    noFillAveragePrice: secondAveragePrice,
    yesContractsFilled: pairedContracts,
    noContractsFilled: pairedContracts,
    pairedContracts,
    unpairedContractsDiscarded,
    feeEstimate: roundPrice(fees),
    failureReason: null,
    fillPricesByMarket: cappedByLeg.map((leg) => ({
      marketId: leg.marketId,
      marketTicker: leg.marketTicker,
      averagePrice: leg.averagePrice,
      contractsFilled: pairedContracts
    }))
  };
}

function failedSimulation(input: {
  executionTime: Date;
  config: PaperSimulationConfig;
  signal: PaperSignalInput;
  notes: string;
  failureReason: string;
  actualSnapshotExecutionTime?: Date | null;
  legRisk?: boolean;
}): PaperTradeSimulation {
  return {
    status: "failed",
    executionTime: input.executionTime,
    executionDelaySeconds: input.config.executionDelaySeconds,
    expectedNetEdge: input.signal.expectedNetEdge,
    realizedNetEdge: null,
    fills: [],
    notes: input.notes,
    legRisk: input.legRisk ?? false,
    targetExecutionTime: input.executionTime,
    actualSnapshotExecutionTime: input.actualSnapshotExecutionTime ?? null,
    yesAskAtSignal: input.signal.yesAskAtSignal ?? null,
    noAskAtSignal: input.signal.noAskAtSignal ?? null,
    yesFillAveragePrice: null,
    noFillAveragePrice: null,
    yesContractsFilled: 0,
    noContractsFilled: 0,
    pairedContracts: 0,
    unpairedContractsDiscarded: 0,
    feeEstimate: 0,
    failureReason: input.failureReason
  };
}

function capFillsToContracts(
  fills: Array<{ price: number; contracts: number }>,
  maxContracts: number
): Array<{ price: number; contracts: number }> {
  let remaining = maxContracts;
  const capped: Array<{ price: number; contracts: number }> = [];

  for (const fill of fills) {
    if (remaining <= 0) {
      break;
    }
    const contracts = Math.min(remaining, fill.contracts);
    if (contracts > 0) {
      capped.push({ price: fill.price, contracts });
      remaining -= contracts;
    }
  }

  return capped;
}

function averageFillPrice(fills: Array<{ price: number; contracts: number }>): number | null {
  const contracts = fills.reduce((sum, fill) => sum + fill.contracts, 0);
  if (contracts <= 0) {
    return null;
  }
  const cost = fills.reduce((sum, fill) => sum + fill.price * fill.contracts, 0);
  return roundPrice(cost / contracts);
}

function fillAtAsk(levels: PriceLevel[], targetContracts: number): FillAtAskResult {
  let remaining = targetContracts;
  let cost = 0;
  let contracts = 0;
  const fills: Array<{ price: number; contracts: number }> = [];

  for (const level of [...levels].sort((a, b) => a.price - b.price)) {
    if (remaining <= 0) {
      break;
    }
    const fillContracts = Math.min(remaining, level.contracts);
    if (fillContracts <= 0) {
      continue;
    }
    fills.push({ price: level.price, contracts: fillContracts });
    contracts += fillContracts;
    cost += fillContracts * level.price;
    remaining -= fillContracts;
  }

  return {
    contracts,
    averagePrice: contracts > 0 ? roundPrice(cost / contracts) : null,
    fills
  };
}

function toPaperFills(
  outcome: "yes" | "no",
  fills: Array<{ price: number; contracts: number }>,
  filledAt: Date,
  feeSettings: FeeSettings
): PaperFillResult[] {
  return fills.map((fill) => ({
    side: "buy",
    outcome,
    price: fill.price,
    contracts: fill.contracts,
    fees: estimateLegFee(fill.contracts, feeSettings),
    filledAt
  }));
}

function earliestActualSnapshotTime(legs: Array<{ snapshot?: NormalizedOrderbook }>): Date | null {
  const times = legs.map((leg) => leg.snapshot?.capturedAt.getTime()).filter((value): value is number => typeof value === "number");
  return times.length === 0 ? null : new Date(Math.min(...times));
}
