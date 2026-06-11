import "./env";

import { prisma } from "@prediction-market-scanner/db";
import { loadWorkerConfig } from "./config";

const config = loadWorkerConfig();

async function main(): Promise<void> {
  const since = new Date(Date.now() - readNumber("REPORT_LOOKBACK_HOURS", 24) * 60 * 60 * 1000);
  const [groups, groupedSignals, ineligibilityReasons, rejectedByEdge, lowestCostGroups] = await Promise.all([
    prisma.relatedMarketGroup.findMany({ where: { updatedAt: { gte: since } } }),
    prisma.signal.findMany({
      where: { strategy: "multi_outcome_arb", detectedAt: { gte: since } },
      orderBy: { detectedAt: "desc" },
      take: 10_000
    }),
    prisma.relatedMarketGroup.groupBy({
      by: ["eligibilityReason"],
      where: { updatedAt: { gte: since }, eligible: false },
      _count: { _all: true },
      orderBy: { _count: { eligibilityReason: "desc" } },
      take: 10
    }),
    prisma.signal.findMany({
      where: { strategy: "multi_outcome_arb", status: "rejected", detectedAt: { gte: since } },
      orderBy: { netEdge: "desc" },
      take: 25,
      include: { relatedGroup: true }
    }),
    prisma.relatedMarketGroup.findMany({
      where: { updatedAt: { gte: since }, totalYesAskCost: { not: null } },
      orderBy: { totalYesAskCost: "asc" },
      take: 25
    })
  ]);

  const accepted = groupedSignals.filter((signal) => signal.status === "accepted");
  const rejected = groupedSignals.filter((signal) => signal.status === "rejected");

  console.log("Overnight related-market report");
  console.log(`since: ${since.toISOString()}`);
  console.log(`related groups found: ${groups.length}`);
  console.log(`eligible related groups: ${groups.filter((group) => group.eligible).length}`);
  console.log(`ineligible groups: ${groups.filter((group) => !group.eligible).length}`);
  console.log("top ineligibility reasons:");
  for (const reason of ineligibilityReasons) {
    console.log(`- ${reason.eligibilityReason}: ${reason._count._all}`);
  }
  console.log(`multi_outcome_arb signals created: ${groupedSignals.length}`);
  console.log(`multi_outcome_arb accepted: ${accepted.length}`);
  console.log(`multi_outcome_arb rejected: ${rejected.length}`);
  console.log(`groups with total YES ask below 1 before fees: ${groups.filter((group) => toNumber(group.totalYesAskCost) !== null && (toNumber(group.totalYesAskCost) ?? 1) < 1).length}`);
  console.log(`groups with netEdge above 0: ${groups.filter((group) => (toNumber(group.netEdge) ?? Number.NEGATIVE_INFINITY) > 0).length}`);
  console.log(`groups with netEdge above MIN_NET_EDGE: ${groups.filter((group) => (toNumber(group.netEdge) ?? Number.NEGATIVE_INFINITY) >= config.detection.minNetEdge).length}`);

  console.log("top 25 rejected multi_outcome_arb signals by net edge:");
  for (const signal of rejectedByEdge) {
    console.log(
      `- ${signal.relatedGroup?.groupKey ?? "unknown"} | netEdge=${formatNumber(toNumber(signal.netEdge))} | reason=${signal.reason}`
    );
  }

  console.log("top 25 groups by lowest total YES ask cost:");
  for (const group of lowestCostGroups) {
    console.log(
      `- ${group.groupKey} | totalYesAskCost=${formatNumber(toNumber(group.totalYesAskCost))} | netEdge=${formatNumber(toNumber(group.netEdge))} | eligible=${group.eligible}`
    );
  }
}

function readNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "object" && "toNumber" in value && typeof value.toNumber === "function") {
    return value.toNumber();
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatNumber(value: number | null): string {
  return value === null ? "N/A" : value.toFixed(6);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
