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
 *     issues: server-sourced, sequence 0, no memo, real time bounds, one
 *     client-sourced `<home domain> auth` operation carrying a large enough
 *     nonce for a G... account, and exactly one server-sourced
 *     `web_auth_domain` entry — nothing else (`client_domain` is not
 *     supported). An unrelated transaction envelope has no way through this.
 *  3. Signatures are verified against the client account: the master key for an
 *     unfunded account, the account's signers and medium threshold otherwise.
 *     The server's own signature is required by both SDK checks.
 *  4. Only then is the challenge **consumed**, exactly once. Consumption is a
 *     conditional insert, so concurrent verifications of the same envelope
 *     resolve to one winner and the rest are rejected as replays. The record
 *     is kept until the envelope's own `maxTime` plus the clock-skew
 *     tolerance, so it cannot be swept while the challenge is still usable.
 *
 * Failures are always a 401, but not one uniform message: a challenge that is
 * otherwise well-formed and correctly signed but arrived after its validity
 * window is rejected with the dedicated CHALLENGE_EXPIRED error so a client
 * knows the envelope was good and the only remedy is to request a fresh one.
 * Signature and domain failures stay the generic UNAUTHORIZED — distinguishing
 * them from expiry would hand an attacker a probe for which failures are
 * structural rather than temporal. The SDK's message, the challenge XDR, and
 * any signature material are never echoed back or logged either way.
 *
 * Successful verification returns the client's public key; minting the session
 * token stays in src/routes/auth.ts, whose claims contract is unchanged.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  Horizon,
  Keypair,
  MemoNone,
  StrKey,
  Transaction,
  WebAuth,
} from "@stellar/stellar-sdk";
import { Prisma } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../db";
import { AppError, Errors } from "../errors";
import {
  CLOCK_SKEW_TOLERANCE_SECONDS,
  nowSeconds,
  readTimeBounds,
  type TimeBounds,
} from "../lib/time-bounds";
import { stellar } from "./stellar";

/** How long a freshly built challenge stays signable. */
export const CHALLENGE_VALIDITY_SECONDS = 300;

/** The exact message the SDK raises when a challenge's own window has closed. */
const EXPIRED_CHALLENGE_MESSAGE = "The transaction has expired";

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

/**
 * The challenge was structurally valid and correctly signed but arrived after
 * its validity window closed — rejected with its own error so a client can
 * tell "sign again" from "you got something wrong". Follows the envelope
 * structure of the transaction-intent expiry path (INTENT_EXPIRED,
 * src/lib/time-bounds.ts).
 */
function expiredChallenge(): never {
  throw Errors.challengeExpired(
    "Authentication challenge has expired. Request a new challenge and sign it promptly.",
    { challengeValiditySeconds: CHALLENGE_VALIDITY_SECONDS }
  );
}

/**
 * The challenge was well-formed, correctly sourced, and inside its window, but
 * the signature material did not verify — wrong (or missing) client signature,
 * or a funded account whose signers do not meet the medium threshold.
 */
function invalidSignature(): never {
  throw Errors.unauthorized(
    "Challenge signature verification failed. Ensure the challenge is signed by the account's signing key(s) before submitting."
  );
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
 * is a total compromise, and the two checks fail independently. Where the
 * SDK is permissive about something this server never issues — a memo, a
 * `client_domain` operation, a missing `web_auth_domain` operation, a muxed
 * (M...) client account — the envelope is rejected here.
 *
 * Returns the challenge's time bounds, which decide how long its single-use
 * record must outlive it.
 */
function validateChallengeEnvelope(tx: Transaction, clientAccountId: string): TimeBounds {
  const serverAccount = serverKeypair().publicKey();

  if (tx.source !== serverAccount) invalidChallenge();
  // A challenge must never be submittable to the network. Sequence 0 is what
  // guarantees that, and it is part of the SEP-10 definition.
  if (String(tx.sequence) !== "0") invalidChallenge();
  // G... accounts only: a muxed account or an id memo would authenticate a
  // sub-account, which Mergepay's account-keyed users cannot represent.
  if (!isValidAccount(clientAccountId)) invalidChallenge();
  if (tx.memo.type !== MemoNone) invalidChallenge();

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
  if (bounds.maxTime + CLOCK_SKEW_TOLERANCE_SECONDS <= now) {
    // The envelope is one we issued, correctly shaped, whose window has
    // closed. Expired — the one failure a client can fix without debugging.
    expiredChallenge();
  }
  if (
    bounds.minTime > now + CLOCK_SKEW_TOLERANCE_SECONDS ||
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

  // Everything after it must be the server-sourced `web_auth_domain` operation
  // this server always adds — exactly once. The SDK only checks its value when
  // present, so an envelope without it would otherwise pass. `client_domain`
  // is not supported: this server never issues it and does not verify a
  // client domain's signing key, so an envelope carrying one is not ours.
  let webAuthDomainOperations = 0;
  for (const operation of operations.slice(1)) {
    if (
      operation.type !== "manageData" ||
      operation.source !== serverAccount ||
      operation.name !== "web_auth_domain"
    ) {
      invalidChallenge();
    }
    const value = operation.value ? Buffer.from(operation.value).toString("utf8") : "";
    if (value !== config.WEB_AUTH_DOMAIN) invalidChallenge();
    webAuthDomainOperations += 1;
  }
  if (webAuthDomainOperations !== 1) invalidChallenge();

  return bounds;
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
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === EXPIRED_CHALLENGE_MESSAGE &&
      isExpiredServerChallenge(signedXdr, serverAccount)
    ) {
      // The SDK's own expiry check fired on an envelope this server signed
      // whose window has genuinely closed (the SDK allows a loose 300s grace;
      // our envelope validation re-checks expiry strictly below).
      expiredChallenge();
    }
    // The SDK's message can name internal details; never surface it.
    invalidChallenge();
  }
}

/**
 * Whether an envelope the SDK called "expired" really is an expired challenge
 * issued by this server.
 *
 * The SDK checks time bounds *before* the server signature, and it raises the
 * same "expired" message for a challenge that is not valid yet. Without this
 * check a forged, unsigned envelope with old time bounds would earn the
 * distinct CHALLENGE_EXPIRED answer — exactly the structural-vs-temporal probe
 * the uniform 401 exists to deny — and a not-yet-valid challenge would be
 * misreported as expired.
 */
function isExpiredServerChallenge(signedXdr: string, serverAccount: string): boolean {
  let tx: Transaction;
  try {
    tx = new Transaction(signedXdr, config.networkPassphrase);
  } catch {
    return false;
  }
  if (!WebAuth.verifyTxSignedBy(tx, serverAccount)) return false;
  const bounds = readTimeBounds(tx);
  return bounds !== null && bounds.maxTime > 0 && bounds.maxTime < nowSeconds();
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
 * Rejects — always with a 401 — challenges that are malformed, expired (code
 * CHALLENGE_EXPIRED), not yet valid, built for the wrong network, home domain,
 * web auth domain, or server account, signed by the wrong client (or not at
 * all), structurally unlike a challenge this server issued, or already
 * redeemed. Signature failures report a distinct message from expiry so a
 * client with a correctly-built but unsigned envelope retries the signature;
 * every other failure stays the generic UNAUTHORIZED with one uniform
 * message, so rejections cannot be probed for which check failed.
 */
export async function verifyChallenge(signedXdr: string): Promise<string> {
  return (await authenticateChallenge(signedXdr)).account;
}

export interface VerifiedChallenge {
  /** The authenticated client account (G...). */
  account: string;
  /** Hex hash of the challenge transaction — the SEP-10 `jti` for the session. */
  challengeHash: string;
}

/**
 * Only the ed25519 account signers can sign a challenge; hash-x, pre-auth and
 * signed-payload signers are dropped (the SDK would skip them too).
 */
function challengeSigners(
  signers: { key: string; weight: number }[]
): Horizon.ServerApi.AccountRecordSigners[] {
  return signers
    .filter((signer) => StrKey.isValidEd25519PublicKey(signer.key))
    .map((signer) => ({ key: signer.key, weight: signer.weight, type: "ed25519_public_key" }));
}

/**
 * `verifyChallenge`, also returning the challenge hash that identifies this
 * authentication (used as the session token's `jti`).
 */
export async function authenticateChallenge(signedXdr: string): Promise<VerifiedChallenge> {
  const serverAccount = serverKeypair().publicKey();

  const { tx, clientAccountID: clientAccountId } = readChallenge(
    signedXdr,
    serverAccount
  );

  let bounds: TimeBounds;
  try {
    bounds = validateChallengeEnvelope(tx, clientAccountId);
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
        // A medium threshold of 0 still demands at least one real signature.
        snapshot.thresholds.med || 1,
        challengeSigners(snapshot.signers),
        config.SEP10_HOME_DOMAIN,
        config.WEB_AUTH_DOMAIN
      );
    }
  } catch {
    // Structure, domains, and time bounds are already confirmed, so a
    // threshold failure here means the signature material is wrong. Reported
    // distinctly from expiry: the remedy is re-signing the same envelope,
    // not minting a new challenge.
    invalidSignature();
  }

  // Consumed last, so a challenge is only burned by an otherwise valid
  // exchange — a wrong signature can never be used to invalidate someone
  // else's pending challenge.
  //
  // The single-use record must outlive every moment the envelope could still
  // be accepted: its own maxTime plus the clock-skew tolerance granted above.
  // Expiring it any earlier (e.g. `now + validity`) would let the sweep delete
  // the record while the same signed challenge is still redeemable.
  const outcome = await consumeChallenge({
    fingerprint: challengeFingerprint(tx),
    clientAccount: clientAccountId,
    expiresAt: new Date((bounds.maxTime + CLOCK_SKEW_TOLERANCE_SECONDS + 1) * 1000),
  });
  if (outcome !== "claimed") invalidChallenge();

  return { account: clientAccountId, challengeHash: tx.hash().toString("hex") };
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
