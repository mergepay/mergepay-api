/**
 * SEP-10 (Stellar Web Authentication) — challenge/verify on the server side.
 *
 * The server holds one signing keypair (SEP10_SIGNING_SECRET). It builds a
 * challenge transaction the client signs with their wallet; we then verify the
 * client's signature to prove control of the account.
 *
 * TODO(#115): Add configurable challenge time-to-live (CHALLENGE_TTL_SECONDS)
 * support so different client tiers can get different validity windows.
 */

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { Keypair, WebAuth, Transaction } from "@stellar/stellar-sdk";
import { config } from "../config";
import { prisma } from "../db";
import { Errors } from "../errors";
import {
  CLOCK_SKEW_TOLERANCE_SECONDS,
  nowSeconds,
  readTimeBounds,
} from "../lib/time-bounds";
import { stellar } from "./stellar";

const CHALLENGE_VALIDITY_SECONDS = 300;
const MIN_NONCE_BYTES = 32;

// Fallback used only under test, or by lightweight database mocks that do not
// expose Prisma raw-query methods. Production replay state is stored in the
// database (see the Sep10ConsumedChallenge model).
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

interface ChallengeOperation {
  type?: string;
  source?: string;
  name?: string;
  value?: Uint8Array;
}

function validateChallengeEnvelope(tx: Transaction, clientAccountId: string): void {
  const transaction = tx as Transaction & {
    timeBounds?: { minTime: number | string; maxTime: number | string } | null;
  };
  const operations = transaction.operations as ChallengeOperation[];

  if (transaction.source !== serverKeypair().publicKey()) invalidChallenge();

  // Time bounds arrive as decimal strings from the SDK; readTimeBounds
  // normalizes them and returns null for an envelope with none.
  const bounds = readTimeBounds(transaction);
  if (!bounds) invalidChallenge();

  // Stellar's TransactionBuilder.setTimeout() normally sets minTime to 0.
  // Validate the effective expiration rather than requiring maxTime - minTime
  // to be bounded, which would reject valid SEP-10 challenges. The same
  // bounded clock-skew tolerance used for transaction intents applies here, so
  // a wallet with a slightly fast or slow clock still authenticates.
  const now = nowSeconds();
  if (
    bounds.minTime > now + CLOCK_SKEW_TOLERANCE_SECONDS ||
    bounds.maxTime + CLOCK_SKEW_TOLERANCE_SECONDS <= now ||
    bounds.maxTime >
      bounds.minTime + CHALLENGE_VALIDITY_SECONDS + CLOCK_SKEW_TOLERANCE_SECONDS
  ) {
    invalidChallenge();
  }

  // A SEP-10 challenge carries the `<home domain> auth` operation sourced by
  // the client, plus (per SEP-10) a `web_auth_domain` operation sourced by the
  // server. Anything else is not a challenge this server issued.
  const authOperation = operations.find(
    (operation) => operation.name === `${config.SEP10_HOME_DOMAIN} auth`
  );
  if (
    !authOperation ||
    authOperation.type !== "manageData" ||
    authOperation.source !== clientAccountId ||
    !authOperation.value ||
    authOperation.value.length < MIN_NONCE_BYTES
  ) {
    invalidChallenge();
  }

  for (const operation of operations) {
    if (operation === authOperation) continue;
    if (
      operation.type !== "manageData" ||
      operation.name !== "web_auth_domain" ||
      operation.source !== serverKeypair().publicKey()
    ) {
      invalidChallenge();
    }
  }
}

async function consumeChallenge(id: string, expiresAt: Date): Promise<void> {
  // Tests run offline with Prisma mocked (or absent), so replay state lives in
  // process memory there. Production always uses the database, which is what
  // makes single-use redemption hold across API instances.
  if (config.isTest || typeof prisma.$executeRaw !== "function") {
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

  // Consume only after all envelope, account, and signature checks pass. The
  // insert is the single source of truth for replay protection: a challenge
  // already recorded fails the conditional insert and is rejected.
  try {
    const now = Math.floor(Date.now() / 1000);
    await consumeChallenge(
      challengeId(tx),
      new Date((now + CHALLENGE_VALIDITY_SECONDS) * 1000)
    );
  } catch (error) {
    if (error instanceof Error && error.message === "Invalid or expired authentication challenge") {
      throw error;
    }
    invalidChallenge();
  }

  return clientAccountId;
}

/** Validate the structure of a transaction XDR string (used in tests). */
export function parseTransaction(xdr: string): Transaction {
  return new Transaction(xdr, config.networkPassphrase);
}
