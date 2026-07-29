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

const CHALLENGE_TTL_SECONDS = 300;

interface IssuedChallenge {
  account: string;
  expiresAt: number;
}

// Challenge transactions are deliberately short-lived and single-use. Keeping
// these records in memory avoids persisting transaction contents or signatures.
// The record is only an issuance/replay marker; no private key material is kept.
const issuedChallenges = new Map<string, IssuedChallenge>();
const consumedChallenges = new Map<string, number>();

let _serverKeypair: Keypair | null = null;

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

function cleanupChallenges(now: number): void {
  for (const [hash, challenge] of issuedChallenges) {
    if (challenge.expiresAt <= now) issuedChallenges.delete(hash);
  }
  for (const [hash, expiresAt] of consumedChallenges) {
    if (expiresAt <= now) consumedChallenges.delete(hash);
  }
}

function validAccount(account: string): boolean {
  try {
    Keypair.fromPublicKey(account);
    return true;
  } catch {
    return false;
  }
}

function genericChallengeError(): never {
  throw Errors.badRequest("invalid_challenge", "Invalid or expired authentication challenge");
}

function operationValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return String(value);
}

export function buildChallenge(account: string): {
  transaction: string;
  networkPassphrase: string;
} {
  if (!validAccount(account)) {
    throw Errors.badRequest("invalid_account", "Not a valid Stellar public key");
  }

  const transaction = WebAuth.buildChallengeTx(
    serverKeypair(),
    account,
    config.SEP10_HOME_DOMAIN,
    CHALLENGE_TTL_SECONDS,
    config.networkPassphrase,
    config.WEB_AUTH_DOMAIN
  );

  const parsed = new Transaction(transaction, config.networkPassphrase);
  const now = Date.now();
  cleanupChallenges(now);
  issuedChallenges.set(parsed.hash().toString("hex"), {
    account,
    expiresAt: now + CHALLENGE_TTL_SECONDS * 1000,
  });

  return { transaction, networkPassphrase: config.networkPassphrase };
}

/**
 * Verify a signed challenge. Returns the authenticated client public key.
 * Handles unfunded accounts by verifying against the account's master key.
 */
export async function verifyChallenge(signedXdr: string): Promise<string> {
  const now = Date.now();
  cleanupChallenges(now);

  let tx: Transaction;
  let clientAccountId: string;
  let challengeHash: string;

  try {
    tx = new Transaction(signedXdr, config.networkPassphrase);
    challengeHash = tx.hash().toString("hex");

    const issued = issuedChallenges.get(challengeHash);
    if (!issued || issued.expiresAt <= now || consumedChallenges.has(challengeHash)) {
      genericChallengeError();
    }

    const currentTime = Math.floor(now / 1000);
    const timeBounds = tx.timeBounds;
    if (
      !timeBounds ||
      !Number.isFinite(timeBounds.minTime) ||
      !Number.isFinite(timeBounds.maxTime) ||
      timeBounds.minTime > currentTime ||
      timeBounds.maxTime < currentTime ||
      timeBounds.maxTime <= timeBounds.minTime
    ) {
      genericChallengeError();
    }

    if (tx.source !== serverKeypair().publicKey()) genericChallengeError();
    if (tx.sequence !== "0") genericChallengeError();
    if (tx.memo.type !== "none") genericChallengeError();
    if (tx.operations.length !== 2) genericChallengeError();

    const [homeOperation, webAuthOperation] = tx.operations;
    if (
      homeOperation.type !== "manageData" ||
      webAuthOperation.type !== "manageData" ||
      homeOperation.name !== config.SEP10_HOME_DOMAIN ||
      webAuthOperation.name !== config.WEB_AUTH_DOMAIN ||
      operationValue(homeOperation.value) === null ||
      operationValue(webAuthOperation.value) === null
    ) {
      genericChallengeError();
    }

    const read = WebAuth.readChallengeTx(
      signedXdr,
      serverKeypair().publicKey(),
      config.networkPassphrase,
      config.SEP10_HOME_DOMAIN,
      config.WEB_AUTH_DOMAIN
    );
    clientAccountId = read.clientAccountID;

    if (
      homeOperation.source !== clientAccountId ||
      webAuthOperation.source !== clientAccountId ||
      operationValue(webAuthOperation.value) !== clientAccountId
    ) {
      genericChallengeError();
    }

    const issuedAfterRead = issuedChallenges.get(challengeHash);
    if (
      !issuedAfterRead ||
      issuedAfterRead.account !== clientAccountId ||
      !validAccount(clientAccountId)
    ) {
      genericChallengeError();
    }
  } catch {
    throw Errors.badRequest("invalid_challenge", "Invalid or expired authentication challenge");
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
    throw Errors.unauthorized("Challenge authentication failed");
  }

  // Mark only after all validation and signature checks pass. JavaScript's
  // synchronous map update makes subsequent requests unable to reuse it.
  const expiresAt = issuedChallenges.get(challengeHash)?.expiresAt ?? now;
  issuedChallenges.delete(challengeHash);
  consumedChallenges.set(challengeHash, expiresAt);

  return clientAccountId;
}

/** Validate the structure of a transaction XDR string (used in tests). */
export function parseTransaction(xdr: string): Transaction {
  return new Transaction(xdr, config.networkPassphrase);
}
