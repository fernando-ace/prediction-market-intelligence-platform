import path from "node:path";
import { fileURLToPath } from "node:url";

export type ResearchSummaryFormat = "text" | "markdown";

export interface ResearchSummaryOptions {
  format: ResearchSummaryFormat;
}

class ResearchSummaryOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchSummaryOptionsError";
  }
}

const SUMMARY = {
  title: "Prediction Market Intelligence Platform",
  subtitle: "Research Summary",
  sample: [
    ["Data source", "Kalshi snapshots"],
    ["Status", "read-only research"],
    ["Trading", "none"],
    ["Main strategy studied", "spread-tightening / passive quote markout"],
    ["Caveat", "fill proxy uses orderbook snapshots, not real fills"]
  ],
  findings: [
    {
      title: "Binary complement arbitrage baseline",
      points: [
        "low-edge rejected signals were consistently negative",
        "no near-miss candidates found",
        "best netEdge found was -0.020000 vs min net edge threshold 0.005000",
        "conclusion: do not loosen thresholds"
      ]
    },
    {
      title: "Spread tightening",
      points: [
        "wider spreads tightened more often",
        "0.04-0.10 entry spread range was strongest",
        "0.05-0.10 showed about 90% 60m tightenRate and 100% 240m tightenRate in the sample",
        "conclusion: descriptive signal is real in this sample"
      ]
    },
    {
      title: "Persistence",
      points: [
        "50,000 snapshots produced 36 wide-spread episodes across 12 unique tickers",
        "median episode duration was about 0.98 minutes, but max duration was about 122.52 minutes",
        "some wide-spread episodes lasted 20, 30, 50, and 120+ minutes",
        "conclusion: not all wide spreads are one-snapshot noise"
      ]
    },
    {
      title: "Maker quote markout",
      points: [
        "bid_plus_tick showed strong markout at 60m and 240m",
        "240m bid_plus_tick, 0.04-0.10 entry spread: 18 deduped candidates, 25.35% avgMarkoutPct, 94.44% favorableRate",
        "60m bid_plus_tick, 0.04-0.10 entry spread: 16 deduped candidates, 17.30% avgMarkoutPct, 93.75% favorableRate",
        "conclusion: passive quote markout is promising before fill constraints"
      ]
    },
    {
      title: "Fill proxy / quote aggressiveness",
      points: [
        "conservative quotes had strong markout but low fillability",
        "bid_plus_1_tick had 22.22% possibleFillRate and 25.35% avgMarkoutPct in the 240m sweep",
        "bid_plus_3_ticks had 55.56% possibleFillRate but only 4.67% avgMarkoutPct",
        "ask_minus_1_tick had 77.78% possibleFillRate but negative markout",
        "aggressive quotes improved fillability but destroyed edge",
        "conclusion: execution is the bottleneck"
      ]
    }
  ],
  finalConclusion: [
    "Strongest current research direction: spread-tightening market microstructure signal",
    "Current weakness: fillability / execution realism",
    "Next recommended work: collect trade history or improve fill proxy, then build a true event-driven backtester"
  ]
} as const;

export function parseResearchSummaryOptions(argv: string[] = process.argv.slice(2)): ResearchSummaryOptions {
  const args = parseArgs(argv);
  const rawFormat = args.named.format ?? args.positional[0] ?? "text";
  return {
    format: readFormat(rawFormat)
  };
}

export function formatResearchSummaryReport(options: ResearchSummaryOptions = { format: "text" }): string {
  return options.format === "markdown" ? formatMarkdownReport() : formatTextReport();
}

function parseArgs(argv: string[]): { named: Record<string, string | boolean>; positional: string[] } {
  const named: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      named[rawKey] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      named[rawKey] = next;
      index += 1;
    } else {
      named[rawKey] = true;
    }
  }

  return { named, positional };
}

function readFormat(value: string | boolean): ResearchSummaryFormat {
  if (value === "text" || value === "markdown") {
    return value;
  }
  throw new ResearchSummaryOptionsError(`Invalid format: expected text or markdown, received ${String(value)}.`);
}

function formatTextReport(): string {
  return [
    SUMMARY.title,
    SUMMARY.subtitle,
    "",
    "Sample:",
    ...SUMMARY.sample.map(([label, value]) => `* ${label}: ${value}`),
    "",
    "Findings:",
    "",
    ...SUMMARY.findings.flatMap((finding, index) => [
      `${index + 1}. ${finding.title}`,
      "",
      ...finding.points.map((point) => `   * ${point}`),
      ""
    ]),
    "Final conclusion:",
    "",
    ...SUMMARY.finalConclusion.map((point) => `* ${point}`)
  ].join("\n");
}

function formatMarkdownReport(): string {
  return [
    `## ${SUMMARY.title}`,
    "",
    `### ${SUMMARY.subtitle}`,
    "",
    "#### Sample",
    "",
    ...SUMMARY.sample.map(([label, value]) => `- **${label}:** ${value}`),
    "",
    "#### Findings",
    "",
    ...SUMMARY.findings.flatMap((finding, index) => [
      `##### ${index + 1}. ${finding.title}`,
      "",
      ...finding.points.map((point) => `- ${point}`),
      ""
    ]),
    "#### Final conclusion",
    "",
    ...SUMMARY.finalConclusion.map((point) => `- ${point}`)
  ].join("\n");
}

function main(): void {
  const options = parseResearchSummaryOptions();
  console.log(formatResearchSummaryReport(options));
}

function isMainModule(): boolean {
  return process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
}

if (isMainModule()) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
