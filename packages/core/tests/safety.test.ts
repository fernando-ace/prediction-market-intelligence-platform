import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoots = ["packages/core/src", "apps/worker/src", "apps/web/app"];
const allowedPolymarketFoundationFiles = new Set([
  join(process.cwd(), "..", "..", "packages/core/src/adapters.ts"),
  join(process.cwd(), "..", "..", "packages/core/src/types.ts")
]);
const forbiddenPatterns = [
  /\bpolymarket\b/i,
  /\bwallet\b/i,
  /\bprivateKey\b/i,
  /\bplaceOrder\b/i,
  /\bcreateOrder\b/i,
  /\bauthenticated order\b/i
];

describe("real trading safety boundaries", () => {
  it("does not introduce Polymarket implementation, wallet, private-key, or order-placement source code", () => {
    const files = sourceRoots.flatMap((root) => listSourceFiles(join(process.cwd(), "..", "..", root)));
    const matches = files.flatMap((file) => {
      const content = readFileSync(file, "utf8");
      return forbiddenPatterns
        .filter((pattern) => pattern.test(content) && !isAllowedFoundationReference(file, pattern))
        .map((pattern) => `${file}: ${pattern}`);
    });

    expect(matches).toEqual([]);
  });
});

function isAllowedFoundationReference(file: string, pattern: RegExp): boolean {
  return pattern.source === "\\bpolymarket\\b" && allowedPolymarketFoundationFiles.has(file);
}

function listSourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      return listSourceFiles(path);
    }
    return /\.(ts|tsx)$/.test(path) ? [path] : [];
  });
}
