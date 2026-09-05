/**
 * SEP-10 (Stellar Web Authentication) — challenge creation and verification.
 *
 * The server holds one signing keypair (SEP10_SIGNING_SECRET). It builds a
 * challenge transaction the client's wallet signs; verifying that signature is
 * what proves control of the account, and it is the only thing standing in
 * front of every protected group and settlement action. So verification is
 * deliberately strict and layered:
 *
 *  1. `WebAuth.readChallengeTx` parses the envelope against **our** network
 *     passphrase, server account, home domain, and web auth domain. A challenge
 *     built for another network, another anchor, or another domain fails here —
 *     the signature is computed over network-dependent bytes, so it cannot
 *     survive a passphrase swap.
 *  2. `validateChallengeEnvelope` re-checks the structure this server actually
 *     issues: server-sourced, sequence 0, real time bounds, one client-sourced
 *     `<home domain> auth` operation carrying a large enough nonce, and nothing
 *     else beyond the server's own `web_auth_domain` / `client_domain` entries.
 *     An unrelated transaction envelope has no way through this.
 *  3. Signatures are verified against the client account: the master key for an
 *     unfunded account, the account's signers and medium threshold otherwise.
 *     The server's own signature is required by both SDK checks.
 *  4. Only then is the challenge **consumed**, exactly once. Consumption is a
 *     conditional insert, so concurrent verifications of the same envelope
 *     resolve to one winner and the rest are rejected as replays.
 *
 * Failures are always the same generic 401. The SDK's message, the challenge
 * XDR, and any signature material are never echoed back or logged.
 *
 * Successful verification returns the client's public key; minting the session
 * token stays in src/routes/auth.ts, whose claims contract is unchanged.
 */

import { createHash, randomUUID } from "node:crypto";
import { Keypair, StrKey, Transaction, WebAuth } from "@stellar/stellar-sdk";
import { Prisma } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../db";
import { AppError, Errors } from "../errors";
import {
  CLOCK_SKEW_TOLERANCE_SECONDS,
  nowSeconds,
  readTimeBounds,
} from "../lib/time-bounds";
import { stellar } from "./stellar";

/** How long a freshly built challenge stays signable. */
export const CHALLENGE_VALIDITY_SECONDS = 300;

/** SEP-10 requires at least 32 bytes of server-chosen randomness in the nonce. */
const MIN_NONCE_BYTES = 32;

/**
 * Replay state for deployments with no reachable database — tests, and only
 * tests. Production consumption is durable (see `consumeChallenge`), which is
 * what makes single-use redemption hold across API instances.
 */
const inProcessConsumed = new Map<string, number>();

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

function invalidChallenge(): never {
  throw Errors.unauthorized("Invalid or expired authentication challenge");
}

function isValidAccount(account: string): boolean {
  return StrKey.isValidEd25519PublicKey(account);
}

/** Build an unsigned challenge for a client account to sign. */
export function buildChallenge(account: string): {
  transaction: string;
  networkPassphrase: string;
} {
  if (!isValidAccount(account)) {
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

interface ChallengeOperation {
  type?: string;
  source?: string;
  name?: string;
  value?: Uint8Array;
}

/**
 * Extract the home domain name from a challenge envelope's first manageData
 * operation. Returns null when the operation is missing or not a manageData
 * type.
 */
function extractHomeDomain(tx: Transaction): string | null {
  const operations = tx.operations as ChallengeOperation[];
  const authOp = operations[0];
  if (!authOp || authOp.type !== "manageData" || typeof authOp.name !== "string") {
    return null;
  }
  // The name is `<homeDomain> auth` — strip the trailing ` auth` suffix.
  const suffix = " auth";
  if (!authOp.name.endsWith(suffix)) return null;
  return authOp.name.slice(0, -suffix.length);
}

/**
 * Re-check the envelope against the shape this server issues.
 *
 * Deliberately redundant with `readChallengeTx`: an authentication bypass here
 * is a total compromise, and the two checks fail independently.
 */
function validateChallengeEnvelope(tx: Transaction, clientAccountId: string): void {
  const serverAccount = serverKeypair().publicKey();

  if (tx.source !== serverAccount) invalidChallenge();
  // A challenge must never be submittable to the network. Sequence 0 is what
  // guarantees that, and it is part of the SEP-10 definition.
  if (String(tx.sequence) !== "0") invalidChallenge();
  if (!isValidAccount(clientAccountId)) invalidChallenge();

  // Explicit home domain assertion: the first manageData operation must carry
  // `<homeDomain> auth` where `homeDomain` matches the server configuration.
  // This is a defense-in-depth check — the SDK also validates the home
  // domain, but catching it here produces a clear, auditable rejection.
  const homeDomain = extractHomeDomain(tx);
  if (homeDomain !== config.SEP10_HOME_DOMAIN) invalidChallenge();

  // Time bounds arrive as decimal strings from the SDK; readTimeBounds
  // normalizes them and returns null for an envelope with none.
  const bounds = readTimeBounds(
    tx as unknown as {
      timeBounds?: { minTime: number | string; maxTime: number | string } | null;
    }
  );
  if (!bounds || bounds.maxTime <= 0) invalidChallenge();

  // Validate the effective window rather than requiring an exact duration: the
  // builder sets minTime to "now", and a wallet with a slightly fast or slow
  // clock must still authenticate. The same bounded skew tolerance used for
  // transaction intents applies, so a genuinely stale or not-yet-valid
  // challenge is still rejected.
  const now = nowSeconds();
  if (
    bounds.minTime > now + CLOCK_SKEW_TOLERANCE_SECONDS ||
    bounds.maxTime + CLOCK_SKEW_TOLERANCE_SECONDS <= now ||
    bounds.maxTime >
      bounds.minTime + CHALLENGE_VALIDITY_SECONDS + CLOCK_SKEW_TOLERANCE_SECONDS
  ) {
    invalidChallenge();
  }

  const operations = tx.operations as ChallengeOperation[];
  if (operations.length === 0) invalidChallenge();

  // The first operation carries the nonce and must be sourced by the account
  // being authenticated — this is what ties the challenge to one client.
  const authOperation = operations[0];
  if (
    authOperation.type !== "manageData" ||
    authOperation.name !== `${config.SEP10_HOME_DOMAIN} auth` ||
    authOperation.source !== clientAccountId ||
    !authOperation.value ||
    authOperation.value.length < MIN_NONCE_BYTES
  ) {
    invalidChallenge();
  }

  // Everything after it must be a server-sourced SEP-10 subsequent operation.
  // Anything else means this is not an envelope we issued.
  for (const operation of operations.slice(1)) {
    if (operation.type !== "manageData" || operation.source !== serverAccount) {
      invalidChallenge();
    }
    if (operation.name === "web_auth_domain") {
      const value = operation.value
        ? Buffer.from(operation.value).toString("utf8")
        : "";
      if (value !== config.WEB_AUTH_DOMAIN) invalidChallenge();
      continue;
    }
    if (operation.name !== "client_domain") invalidChallenge();
  }
}

/**
 * Parse a signed challenge against our own network, server account, and
 * domains. Every rejection the SDK can raise here — wrong passphrase, wrong
 * server key, wrong home or web auth domain, malformed XDR, missing server
 * signature — collapses to the same opaque 401.
 */
function readChallenge(
  signedXdr: string,
  serverAccount: string
): { tx: Transaction; clientAccountID: string } {
  try {
    return WebAuth.readChallengeTx(
      signedXdr,
      serverAccount,
      config.networkPassphrase,
      config.SEP10_HOME_DOMAIN,
      config.WEB_AUTH_DOMAIN
    );
  } catch {
    // The SDK's message can name internal details; never surface it.
    invalidChallenge();
  }
}

/** Stable per-challenge identity used for single-use redemption. */
function challengeFingerprint(tx: Transaction): string {
  return createHash("sha256").update(tx.hash()).digest("hex");
}

type ConsumeOutcome = "claimed" | "replayed";

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );
}

function consumeInProcess(fingerprint: string, expiresAt: Date): ConsumeOutcome {
  const now = Date.now();
  for (const [key, expiry] of inProcessConsumed) {
    if (expiry <= now) inProcessConsumed.delete(key);
  }
  // Check-and-set with no await in between, so concurrent verifications of the
  // same envelope cannot both observe it as unclaimed.
  if (inProcessConsumed.has(fingerprint)) return "replayed";
  inProcessConsumed.set(fingerprint, expiresAt.getTime());
  return "claimed";
}

/**
 * Record a challenge as used, exactly once.
 *
 * The insert itself is the concurrency control: whichever request lands the row
 * first has authenticated, and every other request — concurrent or later — sees
 * the conflict and is rejected as a replay. There is no read-then-write window
 * for two verifications to slip through.
 *
 * When no durable store is reachable, verification **fails closed** in
 * production; only under test does it fall back to per-process state.
 */
async function consumeChallenge(params: {
  fingerprint: string;
  clientAccount: string;
  expiresAt: Date;
}): Promise<ConsumeOutcome> {
  const { fingerprint, clientAccount, expiresAt } = params;
  const model = (prisma as unknown as {
    sep10Challenge?: { create?: (args: unknown) => Promise<unknown> };
  }).sep10Challenge;

  if (typeof model?.create === "function") {
    try {
      await model.create({
        data: { fingerprint, clientAccount, expiresAt },
      });
      return "claimed";
    } catch (error) {
      if (isUniqueViolation(error)) return "replayed";
      if (!config.isTest) invalidChallenge();
    }
  }

  if (typeof prisma.$executeRaw === "function") {
    try {
      // Column order puts the two values a conditional insert actually needs
      // first; `ON CONFLICT DO NOTHING` reports 0 rows for an already-consumed
      // challenge, which is the replay signal.
      const inserted = await prisma.$executeRaw(
        Prisma.sql`INSERT INTO "sep10_challenges" ("fingerprint", "expires_at", "id", "client_account")
          VALUES (${fingerprint}, ${expiresAt}, ${randomUUID()}, ${clientAccount})
          ON CONFLICT ("fingerprint") DO NOTHING`
      );

      // Opportunistic sweep: expired rows carry no security value and the table
      // would otherwise grow without bound.
      await prisma
        .$executeRaw(
          Prisma.sql`DELETE FROM "sep10_challenges" WHERE "expires_at" <= CURRENT_TIMESTAMP`
        )
        .catch(() => undefined);

      return Number(inserted) === 1 ? "claimed" : "replayed";
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (!config.isTest) invalidChallenge();
    }
  }

  if (!config.isTest) invalidChallenge();
  return consumeInProcess(fingerprint, expiresAt);
}

/**
 * Verify a signed challenge and return the authenticated client public key.
 *
 * Rejects — always as a generic 401 — challenges that are malformed, expired,
 * not yet valid, built for the wrong network, home domain, web auth domain, or
 * server account, signed by the wrong client (or not at all), structurally
 * unlike a challenge this server issued, or already redeemed.
 */
export async function verifyChallenge(signedXdr: string): Promise<string> {
  const serverAccount = serverKeypair().publicKey();

  const { tx, clientAccountID: clientAccountId } = readChallenge(
    signedXdr,
    serverAccount
  );

  try {
    validateChallengeEnvelope(tx, clientAccountId);
  } catch (error) {
    if (error instanceof AppError) throw error;
    invalidChallenge();
  }

  // An account Horizon does not know yet is authenticated against its master
  // key; a funded one against its configured signers and medium threshold.
  // Horizon being unreachable is not a reason to authenticate anyone.
  const snapshot = await stellar
    .loadAccount(clientAccountId)
    .catch(() => invalidChallenge());

  try {
    if (!snapshot.exists) {
      WebAuth.verifyChallengeTxSigners(
        signedXdr,
        serverAccount,
        config.networkPassphrase,
        [clientAccountId],
        config.SEP10_HOME_DOMAIN,
        config.WEB_AUTH_DOMAIN
      );
    } else {
      WebAuth.verifyChallengeTxThreshold(
        signedXdr,
        serverAccount,
        config.networkPassphrase,
        snapshot.thresholds.med || 1,
        snapshot.signers.map((signer) => ({
          key: signer.key,
          weight: signer.weight,
        })) as never,
        config.SEP10_HOME_DOMAIN,
        config.WEB_AUTH_DOMAIN
      );
    }
  } catch {
    invalidChallenge();
  }

  // Consumed last, so a challenge is only burned by an otherwise valid
  // exchange — a wrong signature can never be used to invalidate someone
  // else's pending challenge.
  const outcome = await consumeChallenge({
    fingerprint: challengeFingerprint(tx),
    clientAccount: clientAccountId,
    expiresAt: new Date((nowSeconds() + CHALLENGE_VALIDITY_SECONDS) * 1000),
  });
  if (outcome !== "claimed") invalidChallenge();

  return clientAccountId;
}

/** Delete redeemed challenges past their window. Returns the number removed. */
export async function cleanupExpiredChallenges(): Promise<number> {
  const now = Date.now();
  for (const [key, expiry] of inProcessConsumed) {
    if (expiry <= now) inProcessConsumed.delete(key);
  }

  const model = (prisma as unknown as {
    sep10Challenge?: { deleteMany?: (args: unknown) => Promise<{ count: number }> };
  }).sep10Challenge;

  if (typeof model?.deleteMany !== "function") return 0;

  const result = await model.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return result.count;
}

/** Parse a transaction XDR against the configured network (used in tests). */
export function parseTransaction(xdr: string): Transaction {
  return new Transaction(xdr, config.networkPassphrase);
}
