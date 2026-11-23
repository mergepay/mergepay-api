import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

function read(relativePath: string): string {
  return readFileSync(`${repoRoot}${relativePath}`, "utf8");
}

/**
 * Extract a markdown section from its heading to the next heading of the same
 * or higher level, skipping fenced code blocks so `#` comments inside env/bash
 * examples are never mistaken for headings.
 */
function section(markdown: string, headingPattern: RegExp): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => headingPattern.test(line));
  expect(start, `heading ${headingPattern} not found`).toBeGreaterThanOrEqual(0);
  const level = (lines[start].match(/^#+/) ?? ["#"])[0].length;
  let inFence = false;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = lines[i].match(/^(#+)\s/);
    if (heading && heading[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

const readme = read("README.md");
const localSetup = read("docs/LOCAL_SETUP.md");
const contributing = read("CONTRIBUTING.md");
const apiContract = read("docs/api-contract.md");
const envExample = read(".env.example");

const allDocs: Record<string, string> = {
  "README.md": readme,
  "docs/LOCAL_SETUP.md": localSetup,
  "CONTRIBUTING.md": contributing,
  "docs/api-contract.md": apiContract,
  ".env.example": envExample,
};

describe("onboarding docs: README local quickstart", () => {
  const setup = section(readme, /^## Setup\s*$/m);
  const quickstart = section(readme, /^### Local quickstart \(testnet\)\s*$/m);

  it("walks a fresh clone from install to a running API and worker", () => {
    for (const command of [
      "git clone",
      "npm install",
      "cp .env.example .env",
      "npm run gen:sep10key",
      "npm run prisma:generate",
      "npm run prisma:migrate",
      "npm run db:seed",
      "npm run dev",
      "npm run worker",
    ]) {
      expect(setup, `Setup must include: ${command}`).toContain(command);
    }
    for (const command of [
      "createdb mergepay",
      "npm run gen:sep10key",
      "npm run prisma:generate",
      "npm run prisma:migrate",
      "npm run db:seed",
      "npm run dev",
      "npm run worker",
    ]) {
      expect(quickstart, `quickstart must include: ${command}`).toContain(command);
    }
  });

  it("lists every env key src/config.ts requires, plus the SEP-10 key", () => {
    for (const key of [
      "DATABASE_URL",
      "API_PUBLIC_URL",
      "JWT_SECRET",
      "STELLAR_NETWORK",
      "HORIZON_URL",
      "ANCHOR_HOME_DOMAIN",
      "ANCHOR_NAME",
      "ANCHOR_WEBHOOK_SECRET",
      "STABLE_ASSET_CODE",
      "STABLE_ASSET_ISSUER",
      "SEP10_SIGNING_SECRET",
    ]) {
      expect(quickstart, `quickstart must mention ${key}`).toContain(key);
    }
  });

  it("warns about the shipped public defaults and shows the testnet override", () => {
    expect(quickstart).toContain("STELLAR_NETWORK=public");
    expect(quickstart).toContain("https://horizon.stellar.org");
    expect(quickstart).toContain("STELLAR_NETWORK=testnet");
    expect(quickstart).toContain("HORIZON_URL=https://horizon-testnet.stellar.org");
    expect(quickstart).toContain("src/config.ts");
    expect(quickstart.toLowerCase()).toMatch(/must (match|override)|override \*\*both\*\*|both.*match/);
  });

  it("includes a health check against the default port 4000 and the other probes", () => {
    expect(quickstart).toContain("curl -sS http://localhost:4000/health");
    for (const probe of ["/health/live", "/health/ready", "/health/deep"]) {
      expect(quickstart).toContain(probe);
    }
  });

  it("has a Verify build/tests subsection and links to the deeper docs", () => {
    const verify = section(readme, /^#### Verify build\/tests\s*$/m);
    for (const command of ["npm run build", "npm test", "npm run lint"]) {
      expect(verify).toContain(command);
    }
    for (const link of [
      "docs/LOCAL_SETUP.md",
      "CONTRIBUTING.md",
      "docs/api.http",
      "docs/api-contract.md",
      "docs/INTEGRATION_TESTING_GUIDE.md",
    ]) {
      expect(readme, `README must link to ${link}`).toContain(link);
    }
    expect(quickstart).toContain("docs/api.http");
    expect(quickstart).toContain("docs/api-contract.md");
  });
});

describe("onboarding docs: graceful shutdown knobs (#1038)", () => {
  it("documents both knobs with their 30000 ms defaults in README, LOCAL_SETUP and .env.example", () => {
    const shutdown = section(readme, /^#### Graceful shutdown\s*$/m);
    expect(shutdown).toMatch(/SHUTDOWN_TIMEOUT_MS[^\n]*30000/);
    expect(shutdown).toMatch(/WORKER_SHUTDOWN_DRAIN_MS[^\n]*30000/);

    expect(localSetup).toMatch(/SHUTDOWN_TIMEOUT_MS[^\n]*30000/);
    expect(localSetup).toMatch(/WORKER_SHUTDOWN_DRAIN_MS[^\n]*30000/);

    expect(envExample).toMatch(/^SHUTDOWN_TIMEOUT_MS=30000$/m);
    expect(envExample).toMatch(/^WORKER_SHUTDOWN_DRAIN_MS=30000$/m);
  });
});

describe("onboarding docs: finalized error mapping (#1040)", () => {
  const errorSection = section(readme, /^### Error handling standardization/m);
  const envelopeSection = section(apiContract, /^## Error envelope\s*$/m);

  it("documents the canonical mapping with stable codes and statuses", () => {
    const expected: Array<[RegExp, string]> = [
      [/VALIDATION_ERROR/, "VALIDATION_ERROR"],
      [/DUPLICATE_RECORD/, "DUPLICATE_RECORD"],
      [/NOT_FOUND/, "NOT_FOUND"],
      [/SERVICE_UNAVAILABLE/, "SERVICE_UNAVAILABLE"],
      [/UPSTREAM_ERROR/, "UPSTREAM_ERROR"],
      [/UPSTREAM_TIMEOUT/, "UPSTREAM_TIMEOUT"],
      [/RATE_LIMITED/, "RATE_LIMITED"],
      [/INTERNAL_ERROR/, "INTERNAL_ERROR"],
      [/STELLAR_SEQUENCE_CONFLICT/, "STELLAR_SEQUENCE_CONFLICT"],
      [/STELLAR_INSUFFICIENT_FUNDS/, "STELLAR_INSUFFICIENT_FUNDS"],
      [/REQUEST_TOO_LARGE/, "REQUEST_TOO_LARGE"],
      [/BAD_REQUEST/, "BAD_REQUEST"],
      [/UNAUTHORIZED/, "UNAUTHORIZED"],
      [/FORBIDDEN/, "FORBIDDEN"],
      [/CONFLICT/, "CONFLICT"],
    ];
    for (const [pattern, code] of expected) {
      expect(errorSection, `error table must include ${code}`).toMatch(pattern);
    }
    for (const status of ["400", "404", "409", "413", "415", "422", "429", "500", "502", "503", "504"]) {
      expect(errorSection, `error table must include status ${status}`).toContain(status);
    }
    expect(errorSection).toContain("resolveError");
    expect(errorSection).toContain("serializeError");
  });

  it("shows the nested envelope without a statusCode in the body", () => {
    for (const doc of [errorSection, envelopeSection]) {
      expect(doc).toContain('"error": {');
      expect(doc).toContain('"timestamp"');
      expect(doc).toContain('"requestId"');
      expect(doc).not.toContain('"statusCode"');
    }
    expect(apiContract).not.toContain('"statusCode"');
    expect(envelopeSection).toContain("error.code");
  });

  it("api-contract lists the new upstream and limit codes", () => {
    for (const code of [
      "RATE_LIMITED",
      "UPSTREAM_ERROR",
      "UPSTREAM_TIMEOUT",
      "SERVICE_UNAVAILABLE",
      "STELLAR_SEQUENCE_CONFLICT",
      "REQUEST_TOO_LARGE",
      "TOO_MANY_PARTS",
      "INTERNAL_ERROR",
    ]) {
      expect(envelopeSection).toContain(code);
    }
  });
});

describe("onboarding docs: request size defaults match src/config.ts", () => {
  const limits = section(readme, /^### Request size limits\s*$/m);

  it("documents the 1 MB JSON default and 20 multipart parts", () => {
    expect(limits).toMatch(/JSON_BODY_LIMIT_BYTES[^\n]*1 MB/);
    expect(limits).not.toMatch(/JSON_BODY_LIMIT_BYTES[^\n]*256/);
    expect(limits).toMatch(/MULTIPART_MAX_FIELDS[^\n]*\|\s*20\s*\|/);
    expect(limits).not.toMatch(/MULTIPART_MAX_FIELDS[^\n]*\|\s*10\s*\|/);
  });
});

describe("onboarding docs: .env.example completeness", () => {
  it("ships safe values for every required anchor/asset key", () => {
    expect(envExample).toMatch(/^ANCHOR_HOME_DOMAIN=\S+/m);
    expect(envExample).toMatch(/^ANCHOR_NAME=\S+/m);
    expect(envExample).toMatch(/^ANCHOR_WEBHOOK_SECRET=\S+/m);
    expect(envExample).toMatch(/^STABLE_ASSET_CODE=\S+/m);
    expect(envExample).toMatch(/^STABLE_ASSET_ISSUER=G[A-Z0-9]{55}$/m);
  });

  it("keeps the safe public default but documents the testnet override", () => {
    expect(envExample).toMatch(/^STELLAR_NETWORK=public$/m);
    expect(envExample).toMatch(/^HORIZON_URL=https:\/\/horizon\.stellar\.org$/m);
    expect(envExample).toContain("STELLAR_NETWORK=testnet");
    expect(envExample).toContain("https://horizon-testnet.stellar.org");
    expect(envExample).toContain("src/config.ts");
  });

  it("offers SEP10_SIGNING_SECRET commented out with generation instructions", () => {
    expect(envExample).toMatch(/^#\s*SEP10_SIGNING_SECRET=/m);
    expect(envExample).not.toMatch(/^SEP10_SIGNING_SECRET=/m);
    expect(envExample).toContain("npm run gen:sep10key");
  });
});

describe("onboarding docs: no stale claims or contradictions", () => {
  it("no doc mentions the retired RATE_LIMIT_EXCEEDED code", () => {
    for (const [name, doc] of Object.entries(allDocs)) {
      expect(doc, `${name} must not mention RATE_LIMIT_EXCEEDED`).not.toContain("RATE_LIMIT_EXCEEDED");
    }
  });

  it("no doc carries the npm-run-gen:sep10key typo", () => {
    for (const [name, doc] of Object.entries(allDocs)) {
      expect(doc, `${name} must not contain the typo`).not.toContain("npm-run-gen:sep10key");
    }
    expect(localSetup).toContain("npm run gen:sep10key");
  });

  it("LOCAL_SETUP and CONTRIBUTING no longer claim a testnet default", () => {
    expect(localSetup).not.toMatch(/testnet by default/i);
    expect(contributing).not.toMatch(/defaults to testnet/i);
    for (const doc of [localSetup, contributing]) {
      expect(doc).toContain("STELLAR_NETWORK=testnet");
      expect(doc).toContain("https://horizon-testnet.stellar.org");
      expect(doc).toContain("STELLAR_NETWORK=public");
    }
  });

  it("LOCAL_SETUP documents the health probes and required keys", () => {
    for (const probe of ["/health", "/health/live", "/health/deep"]) {
      expect(localSetup).toContain(probe);
    }
    for (const key of ["ANCHOR_HOME_DOMAIN", "ANCHOR_NAME", "ANCHOR_WEBHOOK_SECRET", "STABLE_ASSET_CODE", "STABLE_ASSET_ISSUER"]) {
      expect(localSetup).toContain(key);
    }
  });
});
