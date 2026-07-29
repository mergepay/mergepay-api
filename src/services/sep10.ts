/**
 * SEP-10 (Stellar Web Authentication) — challenge/verify on the server side.
 *
 * The server holds one signing keypair (SEP10_SIGNING_SECRET). It builds a
 * challenge transaction the client signs with their wallet; we then verify the
 * client's signature to prove control of the account.
 */

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { Keypair, WebAuth, Transaction } from "@stellar/stellar-sdk";
import { config } from "../config";
import { prisma } from "../db";
import { AppError, Errors } from "../errors";
import { stellar } from "./stellar";

const CHALLENGE_VALIDITY_SECONDS = 300;
const MIN_NONCE_BYTES = 32;

// Fallback used only by lightweight unit-test database mocks that do not expose
// Prisma raw-query methods. Production replay state is stored in the database.
const testConsumedChallenges = new Map<string, number>();

let _serverKeypair: Keypair | null = null;

export function serverKeypair(): Keypair {
  if (_serverKeypair) return _serverKeypair;
  if (config.SEP10_SIGNING_SECRET) {
    _serverKeypair = Keypair.fromSecret(config.SEP10_SIGNING_SECRET);
  } else {
    _serverKeypair = Keypair.random();
  }
  return _serverKeypair;
}

function validAccount(account: string): boolean {
  try {
    Keypair.fromPublicKey(account);
    return true;
  } catch {
    return false;
  }
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
    CHALLENGE_VALIDITY_SECONDS,
    config.networkPassphrase,
    config.WEB_AUTH_DOMAIN
  );

  return { transaction, networkPassphrase: config.networkPassphrase };
}

function invalidChallenge(): never {
  throw Errors.unauthorized("Invalid or expired authentication challenge");
}

function challengeId(tx: Transaction): string {
  return createHash("sha256").update(tx.hash()).digest("hex");
}

function validateChallengeEnvelope(tx: Transaction, clientAccountId: string): void {
  const transaction = tx as Transaction & {
    // stellar-sdk represents time bounds as decimal-string unix timestamps,
    // not numbers.
    timeBounds?: { minTime: string; maxTime: string } | null;
    operations: Array<{
      type?: string;
      source?: string;
      name?: string;
      value?: Uint8Array;
    }>;
  };

  if (transaction.source !== serverKeypair().publicKey()) invalidChallenge();

  const bounds = transaction.timeBounds;
  const now = Math.floor(Date.now() / 1000);
  const minTime = bounds ? Number(bounds.minTime) : NaN;
  const maxTime = bounds ? Number(bounds.maxTime) : NaN;
  if (!bounds || !Number.isFinite(minTime) || !Number.isFinite(maxTime)) {
    invalidChallenge();
  }

  // Stellar's TransactionBuilder.setTimeout() normally sets minTime to 0.
  // Validate the effective expiration rather than requiring maxTime - minTime
  // to be bounded, which would reject valid SEP-10 challenges.
  if (minTime > now || maxTime <= now || maxTime > now + CHALLENGE_VALIDITY_SECONDS) {
    invalidChallenge();
  }

  // A SEP-10 challenge always has a manageData operation binding the
  // challenge to the client account under the home domain; when the server
  // is configured with a distinct WEB_AUTH_DOMAIN (the common case), the SDK
  // adds a second manageData operation binding the challenge to that
  // web_auth_domain too, to prevent it being replayed against a different
  // web-auth endpoint sharing the same signing key. Both are validated when
  // present; anything else is rejected.
  const operations = transaction.operations;
  if (operations.length < 1 || operations.length > 2) invalidChallenge();

  const clientOp = operations[0];
  if (
    clientOp.type !== "manageData" ||
    clientOp.source !== clientAccountId ||
    clientOp.name !== `${config.SEP10_HOME_DOMAIN} auth` ||
    !clientOp.value ||
    clientOp.value.length < MIN_NONCE_BYTES
  ) {
    invalidChallenge();
  }

  if (operations.length === 2) {
    const domainOp = operations[1];
    const domainValue = operationValue(domainOp.value);
    if (
      domainOp.type !== "manageData" ||
      domainOp.source !== serverKeypair().publicKey() ||
      domainOp.name !== "web_auth_domain" ||
      domainValue !== config.WEB_AUTH_DOMAIN
    ) {
      invalidChallenge();
    }
  }
}

async function consumeChallenge(id: string, expiresAt: Date): Promise<void> {
  if (typeof prisma.$executeRaw !== "function") {
    const now = Date.now();
    for (const [key, expiry] of testConsumedChallenges) {
      if (expiry <= now) testConsumedChallenges.delete(key);
    }
    if (testConsumedChallenges.has(id)) invalidChallenge();
    testConsumedChallenges.set(id, expiresAt.getTime());
    return;
  }

  const inserted = await prisma.$executeRaw(
    Prisma.sql`INSERT INTO "Sep10ConsumedChallenge" ("id", "expiresAt")
      VALUES (${id}, ${expiresAt})
      ON CONFLICT ("id") DO NOTHING`
  );
  if (Number(inserted) !== 1) invalidChallenge();

  await prisma.$executeRaw(
    Prisma.sql`DELETE FROM "Sep10ConsumedChallenge" WHERE "expiresAt" <= CURRENT_TIMESTAMP`
  );
}

/**
 * Verify a signed challenge. Returns the authenticated client public key.
 * Handles unfunded accounts by verifying against the account's master key.
 */
export async function verifyChallenge(signedXdr: string): Promise<string> {
  let tx: Transaction;
  let clientAccountId: string;

  try {
    tx = new Transaction(signedXdr, config.networkPassphrase);
    const read = WebAuth.readChallengeTx(
      signedXdr,
      serverKeypair().publicKey(),
      config.networkPassphrase,
      config.SEP10_HOME_DOMAIN,
      config.WEB_AUTH_DOMAIN
    );
    clientAccountId = read.clientAccountID;
    validateChallengeEnvelope(tx, clientAccountId);
  } catch {
    invalidChallenge();
  }

  let snapshot;
  try {
    snapshot = await stellar.loadAccount(clientAccountId);
  } catch {
    invalidChallenge();
  }

  try {
    if (!snapshot.exists) {
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
    invalidChallenge();
  }

  // Claim the challenge only after every structural, time-bound, and
  // signature check has passed. consumeChallenge() atomically inserts the
  // challenge's fingerprint and rejects if it has already been claimed —
  // by this request or a concurrent one — so a signed challenge can never
  // be exchanged for a session more than once. Any failure here (a replay,
  // or an unexpected database error) surfaces as the same generic,
  // client-safe "invalid or expired challenge" response as every other
  // validation step above, rather than leaking why the exchange failed.
  try {
    const now = Math.floor(Date.now() / 1000);
    await consumeChallenge(
      challengeId(tx),
      new Date((now + CHALLENGE_VALIDITY_SECONDS) * 1000)
    );
  } catch (error) {
    if (error instanceof AppError) throw error;
    invalidChallenge();
  }

  return clientAccountId;
}

/** Validate the structure of a transaction XDR string (used in tests). */
export function parseTransaction(xdr: string): Transaction {
  return new Transaction(xdr, config.networkPassphrase);
}
