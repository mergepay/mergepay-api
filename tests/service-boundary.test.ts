import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// CONTRIBUTING.md: "Keep Horizon/anchor I/O inside src/services/* so it stays
// mockable." This guards that rule so a new route or worker task can't quietly
// construct its own Horizon client or issue a raw HTTP request.
const SRC = join(__dirname, "..", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

const outsideServices = sourceFiles(SRC)
  .map((path) => relative(SRC, path).split("\\").join("/"))
  .filter((path) => !path.startsWith("services/"));

const FORBIDDEN: { label: string; pattern: RegExp }[] = [
  { label: "Horizon client", pattern: /\bHorizon\s*\.\s*Server\b/ },
  {
    label: "Horizon import",
    pattern: /import\s*\{[^}]*\bHorizon\b[^}]*\}\s*from\s*["']@stellar\/stellar-sdk["']/,
  },
  { label: "raw fetch", pattern: /\bfetch\s*\(/ },
  { label: "node-fetch", pattern: /["']node-fetch["']/ },
  { label: "stellar.toml resolver", pattern: /\bStellarToml\b/ },
];

describe("network I/O service boundary", () => {
  it("keeps Horizon and anchor I/O out of routes, worker, and lib code", () => {
    const violations: string[] = [];
    for (const file of outsideServices) {
      const text = readFileSync(join(SRC, file), "utf8")
        // Ignore comments; only code counts.
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      for (const { label, pattern } of FORBIDDEN) {
        if (pattern.test(text)) violations.push(`${file}: ${label}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("constructs Horizon clients only inside src/services/", () => {
    const constructing = sourceFiles(SRC)
      .filter((path) => /new\s+Horizon\.Server\s*\(/.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path).split("\\").join("/"));
    expect(constructing.length).toBeGreaterThan(0);
    expect(constructing.filter((path) => !path.startsWith("services/"))).toEqual([]);
  });
});
