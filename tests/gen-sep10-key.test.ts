/**
 * SEP-10 keypair generator script (issue #399).
 *
 * Runs the real `npm run gen:sep10key` script in a subprocess and asserts
 * that it mints a usable Stellar keypair and prints the .env set-up
 * instructions. Key validity is checked with @stellar/stellar-sdk itself —
 * the same library src/services/sep10.ts uses to load SEP10_SIGNING_SECRET —
 * so "the test passes" means exactly "the server can sign with this key".
 */
import { describe, it, expect } from "vitest";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { Keypair } from "@stellar/stellar-sdk";

const execAsync = promisify(exec);

/** Stellar account keys are 56 chars: G... (public) / S... (secret), base32. */
const STELLAR_KEY_RE = /^[GS][A-Z2-7]{55}$/;

describe("scripts/gen-sep10-key.ts (npm run gen:sep10key)", () => {
  // Subprocess tests spawn `npm run` (≈2–3s of npm/tsx startup each), so
  // they need a larger per-test budget than the 5s default.
  it("runs via npm and prints a valid, loadable SEP-10 signing keypair", { timeout: 30_000 }, async () => {
    const { stdout } = await execAsync("npm run gen:sep10key --silent", {
      timeout: 60_000,
    });

    const secretLine = stdout
      .split("\n")
      .find((l) => l.startsWith("SEP10_SIGNING_SECRET="));
    expect(secretLine).toBeTruthy();

    const secret = secretLine!.slice("SEP10_SIGNING_SECRET=".length).trim();
    // Shape: S-prefixed, 56 chars, base32 alphabet.
    expect(secret).toMatch(STELLAR_KEY_RE);

    // The server loads the secret with Keypair.fromSecret — prove the minted
    // key survives that exact path and round-trips to its public key.
    const kp = Keypair.fromSecret(secret);
    expect(kp.publicKey()).toMatch(STELLAR_KEY_RE);

    const publicLine = stdout
      .split("\n")
      .find((l) => l.startsWith("# public key: "));
    expect(publicLine).toBe(`# public key: ${kp.publicKey()}`);
  });

  it("prints instructions for wiring the key into .env", { timeout: 30_000 }, async () => {
    const { stdout } = await execAsync("npm run gen:sep10key --silent", {
      timeout: 60_000,
    });

    // The output must be self-documenting: where the secret goes and what to
    // do next (issue #399 acceptance criterion 2).
    expect(stdout).toContain(".env");
    expect(stdout).toContain("Next steps");
  });

  it("mints a fresh keypair on every run", { timeout: 60_000 }, async () => {
    const first = await execAsync("npm run gen:sep10key --silent", {
      timeout: 60_000,
    });
    const second = await execAsync("npm run gen:sep10key --silent", {
      timeout: 60_000,
    });

    const secretOf = (out: string) =>
      out.split("\n").find((l) => l.startsWith("SEP10_SIGNING_SECRET="))!;

    expect(secretOf(second.stdout)).not.toBe(secretOf(first.stdout));
  });
});
