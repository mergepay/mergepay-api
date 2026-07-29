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
import { Errors } from "../errors";
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

export function buildChallenge(account: string): {
  transaction: string;
  networkPassphrase: string;
} {
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
    timeBounds?: { minTime: number; maxTime: number } | null;
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
  if (!bounds || !Number.isFinite(bounds.minTime) || !Number.isFinite(bounds.maxTime)) {
    invalidChallenge();
  }

  // Stellar's TransactionBuilder.setTimeout() normally sets minTime to 0.
  // Validate the effective expiration rather than requiring maxTime - minTime
  // to be bounded, which would reject valid SEP-10 challenges.
  if (
    bounds.minTime > now ||
    bounds.maxTime <= now ||
    bounds.maxTime > now + CHALLENGE_VALIDITY_SECONDS
  ) {
    invalidChallenge();
  }

  if (transaction.operations.length !== 1) invalidChallenge();
  const operation = transaction.operations[0];
  if (
    operation.type !== "manageData" ||
    operation.source !== clientAccountId ||
    operation.name !== `${config.WEB_AUTH_DOMAIN} auth` ||
    !operation.value ||
    operation.value.length < MIN_NONCE_BYTES
  ) {
    invalidChallenge();
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
