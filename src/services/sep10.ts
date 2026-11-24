/**
 * SEP-10 (Stellar Web Authentication) — challenge creation and verification.
 *
 * The server holds one signing keypair (SEP10_SIGNING_SECRET). It builds a
 * challenge transaction the client's wallet signs; verifying that signature is
 * what proves control of the account, and it is the only thing standing in
 * front of every protected group and settlement action. So verification is
 * deliberately strict and layered:
 *
 *  1. `readChallenge` decodes the envelope, requires **our** server signature
 *     over **our** network passphrase, checks the time bounds and home domain,
 *     then hands it to `WebAuth.readChallengeTx` against our network, server
 *     account, home domain, and web auth domain. A challenge built for another
 *     network, another anchor, or another domain fails here — the signature is
 *     computed over network-dependent bytes, so it cannot survive a passphrase
 *     swap.
 *  2. `validateChallengeEnvelope` re-checks the structure this server actually
 *     issues: server-sourced, sequence 0, no memo, real time bounds (checked
 *     explicitly against server time with clock-skew tolerance — expired,
 *     not-yet-valid, and over-long windows each get their own code), one
  *     client-sourced `<home domain> auth` operation carrying a canonical
  *     48-byte base64 nonce for a G... account, and exactly one server-sourced
  *     `web_auth_domain` entry — nothing else (`client_domain` is not
  *     supported). The fee must equal the base fee for both operations. An
  *     unrelated transaction envelope has no way through this.
 *  3. Signatures are verified against the client account: the master key for an
 *     unfunded account, the account's signers and medium threshold otherwise.
 *     The server's own signature is required by both SDK checks.
 *  4. Only then is the challenge **consumed**, exactly once. Consumption is a
 *     conditional insert, so concurrent verifications of the same envelope
 *     resolve to one winner and the rest are rejected as replays. The record
 *     is kept until the envelope's own `maxTime` plus the clock-skew
 *     tolerance, so it cannot be swept while the challenge is still usable.
 *
 * A rejected credential is always a 401 with a stable code. Anything this
 * server did not demonstrably sign — undecodable, tampered with, built by
 * someone else — is the opaque INVALID_CHALLENGE, so a forger learns nothing
 * about which check failed. Only an envelope carrying this server's signature
 * earns a precise answer: NETWORK_MISMATCH (signed for another network),
 * CHALLENGE_EXPIRED / CHALLENGE_NOT_YET_VALID / CHALLENGE_WINDOW_TOO_LONG (its
 * window), HOME_DOMAIN_MISMATCH (another home domain), or INVALID_SIGNATURE
 * (client signatures that do not verify — the remedy is re-signing, not a new
 * challenge). Structural failures, replays, and anything else stay
 * INVALID_CHALLENGE. 401 rather than 400 is SEP-10-compliant: the spec's token
 * endpoint treats every non-200 status as an error (SEP-10 v3.4.1, "Token" →
 * "Response").
 *
 * The exceptions are this server's own dependencies, which fail closed but are
 * not reported as bad credentials: an unreachable challenge store is a 503
 * SERVICE_UNAVAILABLE (see `challengeStoreUnavailable`) and an unreachable
 * Horizon a 502 UPSTREAM_ERROR (see `signerLookupUnavailable`), because an
 * outage that reports itself as a wave of bad credentials is unactionable for
 * the operator and unrecoverable for the client. The SDK's message, the
 * challenge XDR, and any signature material are never echoed back or logged
 * either way.
 *
 * Successful verification returns the client's public key; minting the session
 * token stays in src/routes/auth.ts, whose claims contract is unchanged.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  BASE_FEE,
  Horizon,
  Keypair,
  MemoNone,
  Networks,
  StrKey,
  Transaction,
  WebAuth,
} from "@stellar/stellar-sdk";
import { Prisma } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../db";
import { AppError, ErrorCode, Errors } from "../errors";
import {
  CLOCK_SKEW_TOLERANCE_SECONDS,
  nowSeconds,
  readTimeBounds,
  type TimeBounds,
} from "../lib/time-bounds";
import { audit } from "./audit";
import { AuditAction } from "./audit-actions";
import { stellar } from "./stellar";

/**
 * How long a freshly built challenge stays signable, in seconds.
 *
 * One value drives both halves of the flow: `buildChallenge` stamps it into the
 * envelope's `maxTime`, and `validateChallengeTimeBounds` refuses a window
 * longer than it. Making it a deployment setting (SEP10_CHALLENGE_VALIDITY_SECONDS,
 * bounded in src/config.ts) lets an operator trade signing comfort against the
 * replay window without ever letting the two halves disagree.
 */
export const CHALLENGE_VALIDITY_SECONDS =
  config.SEP10_CHALLENGE_VALIDITY_SECONDS;

/** The SDK encodes exactly 48 random bytes as a 64-character base64 nonce. */
const CHALLENGE_NONCE_BYTES = 48;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function hasCanonicalNonce(value: Uint8Array | undefined): boolean {
  if (!value) return false;
  const encoded = Buffer.from(value).toString("utf8");
  if (encoded.length !== (CHALLENGE_NONCE_BYTES / 3) * 4) return false;
  if (!BASE64_PATTERN.test(encoded)) return false;
  const decoded = Buffer.from(encoded, "base64");
  return decoded.length === CHALLENGE_NONCE_BYTES && decoded.toString("base64") === encoded;
}

/** The SDK decodes XDR timestamps as canonical decimal strings, not numbers. */
function safeEpochSeconds(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && String(parsed) === value ? parsed : null;
}

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
  throw Errors.invalidChallenge();
}

/**
 * The envelope carries this server's signature, but over another network's
 * passphrase. Only reachable for an envelope this server signed (see
 * `readChallenge`), so it reveals nothing a forger could not already know —
 * this server's network is public in its stellar.toml.
 */
function networkMismatch(): never {
  throw Errors.challengeNetworkMismatch(
    "Authentication challenge was issued for a different Stellar network. Request a new challenge from this server and sign it for its network.",
    { networkPassphrase: config.networkPassphrase }
  );
}

/**
 * A challenge this server signed whose `<home domain> auth` operation names a
 * domain it no longer authenticates for — e.g. one issued before
 * SEP10_HOME_DOMAIN changed.
 */
function homeDomainMismatch(): never {
  throw Errors.challengeHomeDomainMismatch(
    "Authentication challenge was issued for a different home domain. Request a new challenge from this server.",
    { homeDomain: config.SEP10_HOME_DOMAIN }
  );
}

/**
 * Horizon could not be asked for the client account's signers. The request
 * fails closed — nobody is authenticated without that answer — but as the
 * upstream outage it is (502, as every other Horizon failure in this API), not
 * as a rejected credential: a client cannot fix an outage by re-signing.
 */
function signerLookupUnavailable(): never {
  throw Errors.upstream(
    "Unable to load the account's signers from the Stellar network. Please retry shortly."
  );
}

/**
 * The durable challenge store could not be reached, so single use could not be
 * guaranteed.
 *
 * Deliberately *not* a 401. Verification still fails closed — no session is
 * minted, and a client cannot log in while the store is down — but the failure
 * is the server's, not the caller's: a database outage reported as
 * `UNAUTHORIZED` makes an incident look like a wave of bad credentials to both
 * the operator (whose dashboards and alert rules key off 4xx/5xx) and the
 * client (whose only remedy is to sign a fresh challenge that fails the same
 * way). 503 `SERVICE_UNAVAILABLE` is the code this API already uses for an
 * unreachable dependency, and the one `/health` reports for the same condition;
 * it says "retry", which is exactly the truth. No database detail is echoed: the
 * message is fixed text, and the driver's error stays in the server log.
 */
function challengeStoreUnavailable(): never {
  throw new AppError(
    503,
    ErrorCode.SERVICE_UNAVAILABLE,
    "The authentication store is temporarily unavailable. Please retry shortly."
  );
}

/**
 * The challenge was structurally valid and correctly signed but arrived after
 * its validity window closed — rejected with its own error so a client can
 * tell "sign again" from "you got something wrong". Follows the envelope
 * structure of the transaction-intent expiry path (INTENT_EXPIRED,
 * src/lib/time-bounds.ts).
 */
function expiredChallenge(account?: string): never {
  if (account) {
    void audit({
      action: AuditAction.AUTH_CHALLENGE_EXPIRED,
      entityType: "auth_challenge",
      entityId: account,
      metadata: { challengeValiditySeconds: CHALLENGE_VALIDITY_SECONDS },
    });
  }
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
function invalidSignature(account?: string): never {
  // Best-effort audit log for signature verification failure.
  if (account) {
    void audit({
      action: AuditAction.AUTH_CHALLENGE_REJECTED,
      entityType: "auth_challenge",
      entityId: account,
      metadata: { reason: "signature_verification_failed" },
    });
  }
  throw Errors.challengeSignatureInvalid(
    "Challenge signature verification failed. Ensure the challenge is signed by the account's signing key(s) before submitting."
  );
}

function isValidAccount(account: string): boolean {
  return StrKey.isValidEd25519PublicKey(account);
}

/**
 * The challenge carries a usable time-bound window, but the window is not the
 * one this server issues: it starts beyond the clock-skew tolerance (a wallet
 * signing a not-yet-valid envelope is holding a credential with no present
 * value) or it outlives the validity this server grants. Both are structural
 * mismatches between the envelope and what this server would have built,
 * reported with their own 401 code so clients can tell them from the opaque
 * structural failures below — without ever revealing *which* structural
 * detail disagreed.
 */
function invalidChallengeWindow(reason: "not_yet_valid" | "window_too_long"): never {
  if (reason === "not_yet_valid") {
    throw Errors.challengeNotYetValid(
      "Authentication challenge is not valid yet. Request a new challenge and sign it promptly."
    );
  }
  throw Errors.challengeWindowTooLong(
    "Authentication challenge window is longer than this server issues. Request a new challenge."
  );
}

/**
 * Explicitly check a challenge's time bounds against the current server time.
 *
 * This is the challenge-side counterpart of the signed-intent checks in
 * src/lib/time-bounds.ts, kept separate because a challenge answers a
 * different question: not "does this envelope match a stored intent" but "may
 * this envelope still be redeemed right now". In order:
 *
 *  1. No usable bounds, or an unbounded envelope (`maxTime` 0) — rejected.
 *     A challenge that never expires is not one this server built.
 *  2. `maxTime` elapsed, granting `CLOCK_SKEW_TOLERANCE_SECONDS` of skew —
 *     CHALLENGE_EXPIRED. The one failure a client can fix without debugging.
 *  3. `minTime` not yet reached, granting the same skew — the window's floor.
 *  4. A window longer than `CHALLENGE_VALIDITY_SECONDS` (skew granted on top)
 *     — the envelope outlives anything this server issues.
 *
 * Split out from `validateChallengeEnvelope` so the contract is directly
 * testable and future redemption paths cannot bypass it: every challenge
 * verification must have passed these bounds against server time.
 */
export function validateChallengeTimeBounds(
  bounds: TimeBounds | null,
  now: Date = new Date(),
  account?: string
): void {
  // No usable bounds, or an inverted window (minTime after maxTime): an
  // envelope that never expires, or whose bounds contradict each other, is
  // not one this server built — structural, so the generic 401.
  const minTime = safeEpochSeconds(bounds?.minTime);
  const maxTime = safeEpochSeconds(bounds?.maxTime);
  if (minTime === null || maxTime === null || maxTime <= 0 || minTime > maxTime) {
    invalidChallenge();
  }

  const currentSeconds = nowSeconds(now);

  if (maxTime + CLOCK_SKEW_TOLERANCE_SECONDS <= currentSeconds) {
    expiredChallenge(account);
  }
  if (minTime > currentSeconds + CLOCK_SKEW_TOLERANCE_SECONDS) {
    invalidChallengeWindow("not_yet_valid");
  }
  if (
    maxTime >
    minTime + CHALLENGE_VALIDITY_SECONDS + CLOCK_SKEW_TOLERANCE_SECONDS
  ) {
    invalidChallengeWindow("window_too_long");
  }
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

  // Best-effort audit log for challenge creation — never blocks the flow.
  void audit({
    action: AuditAction.AUTH_CHALLENGE_CREATED,
    entityType: "auth_challenge",
    entityId: account,
    metadata: { validitySeconds: CHALLENGE_VALIDITY_SECONDS },
  });

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
export function extractHomeDomain(tx: Transaction): string | null {
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

  const operations = tx.operations as ChallengeOperation[];
  // This server always issues exactly two manageData operations and pays the
  // SDK's base fee for each. Any other fee is a different envelope shape.
  if (operations.length !== 2 || Number(tx.fee) !== Number(BASE_FEE) * operations.length) {
    invalidChallenge();
  }

  const homeDomain = extractHomeDomain(tx);
  if (!homeDomain || homeDomain !== config.SEP10_HOME_DOMAIN) {
    invalidChallenge();
  }

  // Time bounds arrive as decimal strings from the SDK; readTimeBounds
  // normalizes them and returns null for an envelope with none.
  const bounds = readTimeBounds(
    tx as unknown as {
      timeBounds?: { minTime: number | string; maxTime: number | string } | null;
    }
  );
  if (!bounds || bounds.maxTime <= 0) invalidChallenge();

  // From here the envelope is known to be one this server signed, so a closed
  // window is reported as CHALLENGE_EXPIRED and a window that has not opened
  // (or that outlives the validity this server issues) with its own codes.
  // The checks live in validateChallengeTimeBounds — the explicit, directly
  // testable statement of the challenge-expiration contract.
  validateChallengeTimeBounds(bounds, undefined, clientAccountId);

  // The first operation carries the nonce and must be sourced by the account
  // being authenticated — this is what ties the challenge to one client.
  const authOperation = operations[0];
  if (
    authOperation.type !== "manageData" ||
    authOperation.name !== `${config.SEP10_HOME_DOMAIN} auth` ||
    authOperation.source !== clientAccountId ||
    !hasCanonicalNonce(authOperation.value)
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
    if (!value || value.toLowerCase() !== config.WEB_AUTH_DOMAIN.toLowerCase()) {
      invalidChallenge();
    }
    webAuthDomainOperations += 1;
  }
  if (webAuthDomainOperations !== 1) invalidChallenge();

  return bounds;
}

/**
 * Every network passphrase the SDK knows other than this deployment's — the
 * candidates `readChallenge` tries when deciding whether a rejected envelope
 * is really this server's challenge for another network.
 */
const OTHER_NETWORK_PASSPHRASES = Object.values(Networks).filter(
  (passphrase) => passphrase !== config.networkPassphrase
);

/** Whether this server's key signed the envelope over another network's passphrase. */
function signedByServerOnAnotherNetwork(signedXdr: string, serverAccount: string): boolean {
  return OTHER_NETWORK_PASSPHRASES.some((passphrase) => {
    try {
      return WebAuth.verifyTxSignedBy(new Transaction(signedXdr, passphrase), serverAccount);
    } catch {
      return false;
    }
  });
}

/** The client account the challenge's first operation names, when it is one. */
function firstOperationAccount(tx: Transaction): string | undefined {
  const source = (tx.operations as ChallengeOperation[])[0]?.source;
  return source && isValidAccount(source) ? source : undefined;
}

/**
 * Parse a signed challenge against our own network, server account, and
 * domains.
 *
 * The server signature is checked first, and it decides how much a rejection
 * may say. An envelope this server did not sign — undecodable, a fee bump,
 * tampered with after signing, built by someone else, sourced from another
 * account — is answered with the opaque INVALID_CHALLENGE, whatever else is
 * wrong with it, so a forger cannot probe which check failed. Only an envelope
 * that demonstrably came from this server — and is shaped like a challenge,
 * leading with a `<domain> auth` operation — earns a precise answer:
 *
 *  - signed for another network          → NETWORK_MISMATCH
 *  - window closed / not open / too long → CHALLENGE_EXPIRED /
 *                                          CHALLENGE_NOT_YET_VALID /
 *                                          CHALLENGE_WINDOW_TOO_LONG
 *  - another home domain                 → HOME_DOMAIN_MISMATCH
 *  - anything else the SDK rejects       → INVALID_CHALLENGE
 *
 * The time bounds are judged here, against server time with this server's
 * clock-skew tolerance, *before* the SDK sees the envelope: the SDK's own check
 * grants five minutes of grace either side and reports both directions as
 * "expired", so leaving it first would make the answer depend on which of the
 * two tolerances a window happened to fall between. The SDK's message is never
 * surfaced; it can name internal details such as the server account.
 */

/**
 * Validate that the challenge transaction contains the configured home domain.
 * Refactored helper function to strictly validate home domain parameter (#632).
 */
export function validateChallengeHomeDomain(
  tx: Transaction,
  expectedDomain: string = config.SEP10_HOME_DOMAIN
): string {
  const homeDomain = extractHomeDomain(tx);
  if (!homeDomain || homeDomain !== expectedDomain) {
    homeDomainMismatch();
  }
  return homeDomain;
}

/**
 * Explicit check for multiple required signers and threshold weights (#632).
 * Verifies that the signed transaction satisfies the account's medium threshold
 * using valid ed25519 signers.
 */
export function validateChallengeSignerThresholds(
  signedXdr: string,
  serverAccount: string,
  threshold: number,
  signers: { key: string; weight: number }[],
  homeDomain: string = config.SEP10_HOME_DOMAIN,
  webAuthDomain: string = config.WEB_AUTH_DOMAIN
): string[] {
  const eligibleSigners = challengeSigners(signers);
  const effectiveThreshold = threshold > 0 ? threshold : 1;

  return WebAuth.verifyChallengeTxThreshold(
    signedXdr,
    serverAccount,
    config.networkPassphrase,
    effectiveThreshold,
    eligibleSigners,
    homeDomain,
    webAuthDomain
  );
}

function readChallenge(
  signedXdr: string,
  serverAccount: string
): { tx: Transaction; clientAccountID: string } {
  let tx: Transaction;
  try {
    // Throws for undecodable XDR and for a fee-bump envelope, which SEP-10
    // does not allow.
    tx = new Transaction(signedXdr, config.networkPassphrase);
  } catch {
    invalidChallenge();
  }

  if (!WebAuth.verifyTxSignedBy(tx, serverAccount)) {
    if (signedByServerOnAnotherNetwork(signedXdr, serverAccount)) networkMismatch();
    invalidChallenge();
  }

  // Not challenge-shaped at all (no leading `<domain> auth` operation): there
  // is no window or domain worth reporting on.
  const homeDomain = extractHomeDomain(tx);
  if (homeDomain === null) invalidChallenge();

  // A window that has closed is reported as expiry even when it is otherwise
  // malformed (e.g. inverted bounds): the remedy is the same fresh challenge,
  // and this precedence is what verification has always given a server-signed
  // envelope.
  const bounds = readTimeBounds(tx);
  const account = firstOperationAccount(tx);
  if (
    bounds &&
    bounds.maxTime > 0 &&
    bounds.maxTime + CLOCK_SKEW_TOLERANCE_SECONDS <= nowSeconds()
  ) {
    expiredChallenge(account);
  }
  validateChallengeTimeBounds(bounds, undefined, account);

  validateChallengeHomeDomain(tx, config.SEP10_HOME_DOMAIN);

  try {
    return WebAuth.readChallengeTx(
      signedXdr,
      serverAccount,
      config.networkPassphrase,
      config.SEP10_HOME_DOMAIN,
      config.WEB_AUTH_DOMAIN
    );
  } catch {
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
 * production — with a 503, because the store being down is the server's
 * problem, not a rejected credential. Only under test does it fall back to
 * per-process state.
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
      // The unique violation *is* the replay signal, and belongs to the caller.
      // Anything else — the connection dropped, the table missing, the pool
      // exhausted — is this server's failure, so it is reported as one rather
      // than as another rejected credential.
      if (isUniqueViolation(error)) return "replayed";
      if (!config.isTest) challengeStoreUnavailable();
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
      // An AppError raised below this layer already carries its own status and
      // code, so it is rethrown untouched rather than reclassified.
      if (error instanceof AppError) throw error;
      if (!config.isTest) challengeStoreUnavailable();
    }
  }

  // No durable store is wired at all. Under test the documented in-process
  // store keeps single use honest; in production this is a deployment failure
  // and must never become an authentication bypass.
  if (!config.isTest) challengeStoreUnavailable();
  return consumeInProcess(fingerprint, expiresAt);
}

/**
 * Verify a signed challenge and return the authenticated client public key.
 *
 * A rejected credential is a 401 whose code is decided as described at the top
 * of this module: INVALID_CHALLENGE for anything this server did not sign, and
 * the precise NETWORK_MISMATCH, CHALLENGE_EXPIRED, CHALLENGE_NOT_YET_VALID,
 * CHALLENGE_WINDOW_TOO_LONG, HOME_DOMAIN_MISMATCH, or INVALID_SIGNATURE codes
 * only for an envelope that carries this server's signature. The only non-401s
 * are this server's dependencies failing closed: a 503 for the challenge store
 * and a 502 for Horizon.
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
  // Horizon being unreachable is not a reason to authenticate anyone — nor a
  // reason to tell the client its credential is bad. (An unfunded account is
  // not a failure: loadAccount answers it with `exists: false`.)
  const snapshot = await stellar
    .loadAccount(clientAccountId)
    .catch(() => signerLookupUnavailable());

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
      validateChallengeSignerThresholds(
        signedXdr,
        serverAccount,
        snapshot.thresholds.med || 1,
        snapshot.signers,
        config.SEP10_HOME_DOMAIN,
        config.WEB_AUTH_DOMAIN
      );
    }
  } catch {
    // Structure, domains, and time bounds are already confirmed, so a
    // threshold failure here means the signature material is wrong. Reported
    // distinctly from expiry: the remedy is re-signing the same envelope,
    // not minting a new challenge.
    invalidSignature(clientAccountId);
  }

  // Signature verification may have waited on a Horizon round trip, so the
  // window is checked against the clock once more immediately before the
  // challenge is burned. Without this, an envelope whose maxTime elapsed while
  // Horizon was answering would still be redeemed — exactly the stale window
  // the expiry contract exists to close.
  validateChallengeTimeBounds(bounds, new Date(), clientAccountId);

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

  // Best-effort audit log for successful challenge verification.
  void audit({
    action: AuditAction.AUTH_CHALLENGE_VERIFIED,
    entityType: "auth_challenge",
    entityId: clientAccountId,
    metadata: { challengeHash: tx.hash().toString("hex") },
  });

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
