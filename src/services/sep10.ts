/**
 * SEP-10 (Stellar Web Authentication) — challenge/verify on the server side.
 *
 * The server holds one signing keypair (SEP10_SIGNING_SECRET). It builds a
 * challenge transaction the client signs with their wallet; we then verify the
 * client's signature to prove control of the account.
 */

import { Keypair, WebAuth, Transaction } from "@stellar/stellar-sdk";
import { config } from "../config";
import { prisma } from "../db";
import { Errors } from "../errors";
import { stellar } from "./stellar";

const CHALLENGE_VALIDITY_SECONDS = 300;

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
  } catch (e: any) {
    if (e?.code || e?.status) throw e;
    throw Errors.badRequest("invalid_challenge", e?.message ?? "Invalid challenge");
  }

  // 1. Verify Time Bounds (Expiration)
  const nowSec = Math.floor(Date.now() / 1000);
  const minTime = parseInt(tx.timeBounds?.minTime ?? "0", 10);
  const maxTime = parseInt(tx.timeBounds?.maxTime ?? "0", 10);

  if ((minTime > 0 && nowSec < minTime) || (maxTime > 0 && nowSec > maxTime)) {
    throw Errors.badRequest("challenge_expired", "Challenge transaction has expired");
  }

  // 2. Verify Signatures & Account Thresholds FIRST (prevents invalid signatures from consuming challenges)
  let snapshot;
  try {
    snapshot = await stellar.loadAccount(clientAccountId);
  } catch (e: any) {
    throw Errors.badRequest("invalid_challenge", e?.message ?? "Invalid challenge");
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
  } catch (e: any) {
    throw Errors.unauthorized(
      `Challenge signature verification failed: ${e?.message ?? "unknown"}`
    );
  }

  // 3. Atomically Record & Claim Challenge (Replay Protection) after signature verification succeeds
  const fingerprint = tx.hash().toString("hex");
  const expiresAt = maxTime > 0 ? new Date(maxTime * 1000) : new Date(Date.now() + 300 * 1000);

  try {
    await prisma.sep10Challenge.create({
      data: {
        fingerprint,
        clientAccount: clientAccountId,
        expiresAt,
      },
    });
  } catch (e: any) {
    if (e?.code === "P2002") {
      throw Errors.badRequest("challenge_replayed", "Challenge transaction has already been used");
    }
    throw e;
  }

  return clientAccountId;
}

/** Delete expired challenge records from the database. */
export async function cleanupExpiredChallenges(): Promise<number> {
  const result = await prisma.sep10Challenge.deleteMany({
    where: {
      expiresAt: {
        lt: new Date(),
      },
    },
  });
  return result.count;
}

/** Validate the structure of a transaction XDR string (used in tests). */
export function parseTransaction(xdr: string): Transaction {
  return new Transaction(xdr, config.networkPassphrase);
}
