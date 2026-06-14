import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { formatResearchSummaryReport, parseResearchSummaryOptions } from "../src/researchSummary";

describe("research summary CLI", () => {
  it("prints text output with all major sections", () => {
    const report = formatResearchSummaryReport({ format: "text" });

    expect(report).toContain("Prediction Market Intelligence Platform");
    expect(report).toContain("Research Summary");
    expect(report).toContain("Sample:");
    expect(report).toContain("* Data source: Kalshi snapshots");
    expect(report).toContain("* Status: read-only research");
    expect(report).toContain("* Trading: none");
    expect(report).toContain("Binary complement arbitrage baseline");
    expect(report).toContain("Spread tightening");
    expect(report).toContain("Persistence");
    expect(report).toContain("Maker quote markout");
    expect(report).toContain("Fill proxy / quote aggressiveness");
    expect(report).toContain("Final conclusion:");
    expect(report).toContain("Strongest current research direction: spread-tightening market microstructure signal");
  });

  it("prints markdown output with README-ready headings", () => {
    const report = formatResearchSummaryReport({ format: "markdown" });

    expect(report).toContain("## Prediction Market Intelligence Platform");
    expect(report).toContain("### Research Summary");
    expect(report).toContain("#### Sample");
    expect(report).toContain("#### Findings");
    expect(report).toContain("##### 1. Binary complement arbitrage baseline");
    expect(report).toContain("#### Final conclusion");
    expect(report).toContain("- **Trading:** none");
  });

  it("parses default, named, inline, and positional formats", () => {
    expect(parseResearchSummaryOptions([])).toEqual({ format: "text" });
    expect(parseResearchSummaryOptions(["--format", "markdown"])).toEqual({ format: "markdown" });
    expect(parseResearchSummaryOptions(["--format=text"])).toEqual({ format: "text" });
    expect(parseResearchSummaryOptions(["markdown"])).toEqual({ format: "markdown" });
  });

  it("rejects invalid format clearly", () => {
    expect(() => parseResearchSummaryOptions(["--format", "json"])).toThrow("Invalid format: expected text or markdown, received json.");
  });

  it("keeps database writes and trading surfaces out of the read-only command source", () => {
    const source = readFileSync(resolve(process.cwd(), "src/researchSummary.ts"), "utf8");

    expect(source).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/);
    expect(source).not.toMatch(/\.\$executeRaw|\.\$queryRawUnsafe/);
    expect(source).not.toMatch(/@prediction-market-scanner\/db|prisma/i);
    expect(source).not.toMatch(/placeOrder|createOrder|submitOrder|tradeApi|privateKey/i);
  });
});
