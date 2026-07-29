/**
 * SEP-10 (Stellar Web Authentication) — challenge/verify on the server side.
 *
 * The server holds one signing keypair (SEP10_SIGNING_SECRET). It builds a
 * challenge transaction the client signs with their wallet; we then verify the
 * client's signature to prove control of the account.
 */

import { Keypair, WebAuth, Transaction } from "@stellar/stellar-sdk";
import { config } from "../config";
import { Errors } from "../errors";
import { stellar } from "./stellar";

let _serverKeypair: Keypair | null = null;

const CHALLENGE_TIMEOUT_SECONDS = 300;

// Single-use guard against challenge replay: once a signed challenge has been
// used to mint a token, the same signed transaction cannot be replayed to
// authenticate again. Keyed by transaction hash, pruned lazily by expiry.
// Note: this is in-memory and per-process — a multi-instance deployment
// needs a shared store (e.g. Redis) for this guarantee to hold across nodes.
const usedChallenges = new Map<string, number>();

function pruneUsedChallenges(now: number): void {
  for (const [hash, expiresAt] of usedChallenges) {
    if (expiresAt <= now) usedChallenges.delete(hash);
  }
}

function consumeChallengeOnce(tx: Transaction): void {
  const hash = tx.hash().toString("hex");
  const now = Date.now();
  pruneUsedChallenges(now);
  if (usedChallenges.has(hash)) {
    throw Errors.unauthorized();
  }
  usedChallenges.set(hash, now + CHALLENGE_TIMEOUT_SECONDS * 1000);
}

export function serverKeypair(): Keypair {
  if (_serverKeypair) return _serverKeypair;
  if (config.SEP10_SIGNING_SECRET) {
    _serverKeypair = Keypair.fromSecret(config.SEP10_SIGNING_SECRET);
  } else {
    // Deterministic-enough ephemeral key for dev/test when none is configured.
    _serverKeypair = Keypair.random();
  }
  return _serverKeypair;
}

export function buildChallenge(account: string): {
  transaction: string;
  networkPassphrase: string;
} {
  const transaction = WebAuth.buildChallengeTx(
    serverKeypair(),
    account,
    config.SEP10_HOME_DOMAIN,
    CHALLENGE_TIMEOUT_SECONDS,
    config.networkPassphrase,
    config.WEB_AUTH_DOMAIN
  );
  return { transaction, networkPassphrase: config.networkPassphrase };
}

/**
 * Verify a signed challenge. Returns the authenticated client public key.
 * Handles unfunded accounts by verifying against the account's master key.
 *
 * Rejects expired, malformed, incorrectly signed, wrong-network, and
 * wrong-domain transactions, and rejects replays of an already-consumed
 * challenge. Failure messages are intentionally generic — the underlying
 * SDK/network error is never echoed back to the caller, and neither the
 * challenge XDR nor any signed payload is logged.
 */
export async function verifyChallenge(signedXdr: string): Promise<string> {
  let clientAccountId: string;
  let tx: Transaction;
  try {
    const read = WebAuth.readChallengeTx(
      signedXdr,
      serverKeypair().publicKey(),
      config.networkPassphrase,
      config.SEP10_HOME_DOMAIN,
      config.WEB_AUTH_DOMAIN
    );
    clientAccountId = read.clientAccountID;
    tx = read.tx;
  } catch {
    throw Errors.unauthorized();
  }

  const snapshot = await stellar.loadAccount(clientAccountId);

  try {
    if (!snapshot.exists) {
      // Unfunded account: verify the master-key signature directly.
      WebAuth.verifyChallengeTxSigners(
        signedXdr,
        serverKeypair().publicKey(),
        config.networkPassphrase,
        [clientAccountId],
        config.SEP10_HOME_DOMAIN,
        config.WEB_AUTH_DOMAIN
      );
    } else {
      const signerSummary = snapshot.signers.map((s) => ({
        key: s.key,
        weight: s.weight,
      }));
      const med = snapshot.thresholds.med || 1;
      WebAuth.verifyChallengeTxThreshold(
        signedXdr,
        serverKeypair().publicKey(),
        config.networkPassphrase,
        med,
        signerSummary as any,
        config.SEP10_HOME_DOMAIN,
        config.WEB_AUTH_DOMAIN
      );
    }
  } catch {
    throw Errors.unauthorized();
  }

  consumeChallengeOnce(tx);

  return clientAccountId;
}

/** Validate the structure of a transaction XDR string (used in tests). */
export function parseTransaction(xdr: string): Transaction {
  return new Transaction(xdr, config.networkPassphrase);
}
