/**
 * Issue #845 — Stellar Horizon I/O and transaction construction stay inside
 * `src/services/`.
 *
 * CONTRIBUTING states the rule ("Keep Horizon/anchor I/O inside src/services/*
 * so it stays mockable"), but nothing enforced it: a route could import the
 * SDK and instantiate its own Horizon client, and every mocked service test
 * would keep passing while that call went to the real network. This guard
 * test makes the boundary mechanical:
 *
 *   - no route or worker module imports the Stellar SDK;
 *   - Horizon clients, transaction submission, and envelope parsing appear
 *     only under `src/services/`;
 *   - the two service entry points other layers are meant to use are exported.
 *
 * It is deliberately a source scan rather than a runtime check: the point is
 * to fail at review time, on the import that introduces the leak.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

function filesUnder(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...filesUnder(path));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      files.push(path);
    }
  }

  return files;
}

function relativeToSrc(path: string): string {
  return relative(SRC, path).split("\\").join("/");
}

/** Files that are allowed to talk to Horizon or build/parse envelopes. */
function isServiceFile(path: string): boolean {
  const rel = relativeToSrc(path);
  return rel.startsWith("services/") || rel === "config.ts";
}

/**
 * The request-schema XDR check. It parses an envelope and nothing else: no
 * Horizon client, no network call, no transaction construction. Kept outside
 * `src/services/` on purpose so schema validation does not import the
 * database-backed service graph.
 */
const PARSE_ONLY_HELPERS = new Set(["utils/stellar-xdr.ts"]);

describe("Stellar service boundary (#845)", () => {
  const sourceFiles = filesUnder(SRC);
  const routesAndWorker = sourceFiles.filter((path) => {
    const rel = relativeToSrc(path);
    return rel.startsWith("routes/") || rel.startsWith("worker/");
  });

  it("keeps the Stellar SDK out of route and worker modules", () => {
    const offenders = routesAndWorker.filter((path) =>
      readFileSync(path, "utf8").includes("@stellar/stellar-sdk")
    );

    expect(offenders.map(relativeToSrc)).toEqual([]);
  });

  it.each([
    ["Horizon client construction", /new\s+Horizon\.Server\s*\(/, false],
    ["transaction submission", /\.submitTransaction\s*\(/, false],
    ["envelope parsing", /TransactionBuilder\.fromXDR\s*\(/, true],
  ])("keeps %s inside src/services", (_label, pattern, allowParseHelper) => {
    const offenders = sourceFiles
      .filter((path) => !isServiceFile(path))
      .filter((path) => !(allowParseHelper && PARSE_ONLY_HELPERS.has(relativeToSrc(path))))
      .filter((path) => pattern.test(readFileSync(path, "utf8")));

    expect(offenders.map(relativeToSrc)).toEqual([]);
  });

  it("exposes the account and envelope checks other layers validate through", async () => {
    // Routes must be able to validate a G... address and parse a submitted
    // envelope without importing the SDK themselves: these are the seam.
    const { isValidPublicKey, parseSignedPaymentXdr } = await import(
      "../src/services/stellar"
    );
    expect(typeof isValidPublicKey).toBe("function");
    expect(typeof parseSignedPaymentXdr).toBe("function");
  });
});
