/**
 * Expiration handling for unsigned Stellar transaction intents.
 *
 * Mergepay never holds a private key: it builds an unsigned envelope, the
 * wallet signs it, and a later request hands the signed XDR back. That gap is
 * where staleness creeps in — a user can leave a wallet prompt open for an
 * hour, a retry can resurrect a envelope built against a long-superseded
 * sequence number, and a replayed request can try to submit an envelope whose
 * intent no longer reflects anything the group agreed to.
 *
 * Every intent therefore carries a **server-controlled** expiry, recorded when
 * the intent is created and re-checked before a signed envelope is accepted.
 * The rules this module enforces:
 *
 *  1. The expiry is derived from the server clock. A client may *request* a
 *     shorter window, but never extend one, and never supply the timestamp
 *     that decides the answer.
 *  2. The signed transaction's own `maxTime` must agree with the stored
 *     intent. A wallet that returns an envelope valid far longer than the
 *     intent it was built for is a mismatch, not a convenience.
 *  3. Comparisons allow a bounded, documented clock-skew tolerance so a wallet
 *     or validator whose clock is a few seconds off still works, while a
 *     genuinely stale envelope is still rejected.
 *  4. Expiry is reported with its own error code, distinct from a malformed
 *     envelope (`XDR_MISMATCH` / `VALIDATION_ERROR`) or an authorization
 *     failure (`UNAUTHORIZED` / `FORBIDDEN`), so clients can tell "sign again"
 *     from "you got something wrong" and from "you may not do this".
 */
import { z } from "zod";
import { Errors } from "../errors";

/**
 * Tolerance, in seconds, for disagreement between the server clock and a
 * client's or wallet's clock.
 *
 * 30s is deliberately small: large enough to absorb ordinary NTP drift and the
 * round trip of a wallet prompt, small enough that it cannot meaningfully
 * extend the validity of a stale envelope. Widening it weakens replay
 * protection proportionally, so it is a constant rather than a config knob.
 */
export const CLOCK_SKEW_TOLERANCE_SECONDS = 30;

/**
 * Default validity window for a newly created intent. Matches the 300s
 * `setTimeout` the Stellar transaction builder uses for the same envelope, so
 * the stored expiry and the on-chain `maxTime` describe the same deadline.
 */
export const INTENT_VALIDITY_SECONDS = 300;

/** Narrowest window a client may request. Below this, a wallet prompt cannot realistically be completed. */
export const MIN_INTENT_VALIDITY_SECONDS = 30;

/** Widest window a client may request — a client can shorten the default, never extend it. */
export const MAX_INTENT_VALIDITY_SECONDS = INTENT_VALIDITY_SECONDS;

/** Stellar time bounds, normalized to whole seconds since the epoch. */
export interface TimeBounds {
  minTime: number;
  maxTime: number;
}

/** Current server time in whole seconds since the epoch. */
export function nowSeconds(now: Date = new Date()): number {
  return Math.floor(now.getTime() / 1000);
}

/**
 * Validity window a client may request on an intent.
 *
 * Absent, it defaults to `INTENT_VALIDITY_SECONDS`. Anything outside
 * [MIN, MAX] is rejected as validation input rather than silently clamped — a
 * client asking for a two-hour window has misunderstood the contract, and
 * quietly giving it five minutes would hide that.
 */
export const intentValiditySchema = z.coerce
  .number()
  .int()
  .min(MIN_INTENT_VALIDITY_SECONDS)
  .max(MAX_INTENT_VALIDITY_SECONDS)
  .default(INTENT_VALIDITY_SECONDS);

/**
 * Compute an intent's expiry from the *server* clock.
 *
 * `requestedValiditySeconds` has already been bounded by
 * `intentValiditySchema`; it is a request for a shorter window, not a
 * client-supplied deadline.
 */
export function intentExpiry(
  requestedValiditySeconds: number = INTENT_VALIDITY_SECONDS,
  now: Date = new Date()
): { expiresAt: Date; validitySeconds: number } {
  const validitySeconds = Math.min(
    Math.max(requestedValiditySeconds, MIN_INTENT_VALIDITY_SECONDS),
    MAX_INTENT_VALIDITY_SECONDS
  );
  return {
    expiresAt: new Date(now.getTime() + validitySeconds * 1000),
    validitySeconds,
  };
}

/**
 * Has an intent expired, allowing for clock skew?
 *
 * A null expiry means "no recorded deadline" — intents created before
 * expiration tracking existed. Those are treated as *not* expired here; the
 * caller decides whether to require one.
 */
export function isIntentExpired(
  expiresAt: Date | null | undefined,
  now: Date = new Date()
): boolean {
  if (!expiresAt) return false;
  return nowSeconds(now) > nowSeconds(expiresAt) + CLOCK_SKEW_TOLERANCE_SECONDS;
}

/** Seconds until an intent expires; negative once it has. */
export function secondsUntilExpiry(expiresAt: Date, now: Date = new Date()): number {
  return nowSeconds(expiresAt) - nowSeconds(now);
}

/**
 * Throw the stable expiration error unless the intent is still valid.
 *
 * `resource` names the thing that expired ("settlement", "treasury
 * transaction") so the message is actionable without leaking any state.
 */
export function assertIntentNotExpired(
  expiresAt: Date | null | undefined,
  resource: string,
  now: Date = new Date()
): void {
  if (isIntentExpired(expiresAt, now)) {
    throw Errors.badRequest(
      "intent_expired",
      `This ${resource} request has expired. Request a new transaction to sign and sign it promptly.`,
      { expiredAt: expiresAt!.toISOString(), clockSkewToleranceSeconds: CLOCK_SKEW_TOLERANCE_SECONDS }
    );
  }
}

/**
 * Read Stellar time bounds off a parsed transaction.
 *
 * The SDK exposes `minTime`/`maxTime` as decimal *strings*, and older
 * envelopes may carry none at all, so this normalizes both cases instead of
 * letting each call site guess. Returns null when the envelope has no usable
 * bounds.
 */
export function readTimeBounds(tx: {
  timeBounds?: { minTime: number | string; maxTime: number | string } | null;
}): TimeBounds | null {
  const bounds = tx.timeBounds;
  if (!bounds) return null;

  const minTime = Number(bounds.minTime);
  const maxTime = Number(bounds.maxTime);
  if (!Number.isFinite(minTime) || !Number.isFinite(maxTime)) return null;

  return { minTime, maxTime };
}

/**
 * Validate a signed transaction's own time bounds against the stored intent.
 *
 * Three distinct failures, each with its own meaning:
 *  - No usable bounds, or an unbounded envelope → mismatch. An envelope that
 *    never expires is not the one we built.
 *  - `maxTime` materially later than the intent's expiry → mismatch. The
 *    wallet signed a different, longer-lived transaction.
 *  - `maxTime` already in the past → expired. This is the same condition
 *    Horizon would reject with `tx_too_late`, caught before we submit.
 */
export function assertTimeBoundsMatchIntent(
  bounds: TimeBounds | null,
  expiresAt: Date | null | undefined,
  resource: string,
  now: Date = new Date()
): void {
  if (!bounds || bounds.maxTime <= 0) {
    throw Errors.badRequest(
      "xdr_mismatch",
      "Signed transaction must declare a time bound that expires"
    );
  }

  const currentSeconds = nowSeconds(now);

  if (expiresAt) {
    const intentSeconds = nowSeconds(expiresAt);
    if (bounds.maxTime > intentSeconds + CLOCK_SKEW_TOLERANCE_SECONDS) {
      throw Errors.badRequest(
        "xdr_mismatch",
        "Signed transaction is valid longer than the request it was built for"
      );
    }
  }

  if (bounds.maxTime + CLOCK_SKEW_TOLERANCE_SECONDS < currentSeconds) {
    throw Errors.badRequest(
      "intent_expired",
      `This ${resource} request has expired. Request a new transaction to sign and sign it promptly.`,
      {
        expiredAt: new Date(bounds.maxTime * 1000).toISOString(),
        clockSkewToleranceSeconds: CLOCK_SKEW_TOLERANCE_SECONDS,
      }
    );
  }

  // A transaction that is not valid *yet* is equally unusable, and would be
  // rejected by Horizon as tx_too_early.
  if (bounds.minTime > currentSeconds + CLOCK_SKEW_TOLERANCE_SECONDS) {
    throw Errors.badRequest(
      "xdr_mismatch",
      "Signed transaction is not valid yet"
    );
  }
}
