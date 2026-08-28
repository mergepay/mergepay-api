/**
 * Settlement preflight — can this account actually pay this settlement?
 *
 * ## Why this exists
 *
 * Mergepay builds an unsigned envelope, a wallet signs it, and only then does
 * Horizon get a say. Without a preflight the first time anyone learns the payer
 * cannot afford the payment is `tx_insufficient_balance` or `op_underfunded`
 * *after* the user has already signed — a confusing wallet error for something
 * the API could have said up front.
 *
 * This module answers the question before the envelope is built, and returns a
 * distinct outcome per cause so the caller can say something actionable.
 *
 * ## What "spendable" means on Stellar
 *
 * An account's XLM balance is not all spendable. Two deductions apply:
 *
 *  - **base reserve.** Every account holds `(2 + subentries) * 0.5 XLM` that
 *    cannot be sent. Trustlines, offers, signers, and data entries are each a
 *    subentry, so an account with a USDC trustline reserves more than a bare
 *    one. Sending into the reserve is rejected by the network.
 *  - **the fee.** The envelope this API builds pays `BASE_FEE * 2` stroops per
 *    operation, and the fee always comes out of XLM regardless of which asset
 *    is being sent.
 *
 * A USDC balance is *not* spendable XLM and never offsets either deduction.
 * That is the mistake this module exists to prevent: for an issued asset the
 * asset balance and the XLM fee capacity are two separate checks, and both
 * must pass.
 *
 * ## What it does not do
 *
 * Preflight does not replace intent validation or signed-XDR validation — it
 * runs *before* the envelope exists, and those checks still run afterwards on
 * what the wallet returns. It reads Horizon and writes nothing, and it never
 * accepts a balance from the client: every figure comes from a fresh account
 * load. Horizon state can also move between preflight and submission, so a pass
 * here is a strong signal, not a guarantee; submission errors are still handled.
 */

import { BASE_FEE } from "@stellar/stellar-sdk";
import type { AccountSnapshot } from "./stellar";
import { stellar } from "./stellar";
import { fromStroops, toStroops } from "./money";
import { Errors } from "../errors";

/**
 * Parse a balance string Horizon reported.
 *
 * Horizon renders amounts at a fixed 7 decimal places ("100.0000000"), which
 * `toStroops` rejects as non-canonical, and `normalizeAmount` rejects for a
 * different reason: it requires a strictly positive value, and a zero balance
 * is both legitimate and exactly what a fresh trustline holds. So the trailing
 * zeros are trimmed here and the result handed to `toStroops`.
 *
 * A balance that cannot be parsed is treated as zero rather than throwing: an
 * unreadable balance must never read as *more* than the account holds.
 */
function parseHorizonBalance(balance: string): bigint {
  try {
    const trimmed = balance.includes(".")
      ? balance.replace(/0+$/, "").replace(/\.$/, "")
      : balance;
    return toStroops(trimmed);
  } catch {
    return 0n;
  }
}

/**
 * The network's base reserve, in stroops (0.5 XLM).
 *
 * Protocol-level and unchanged since protocol 11. It is a constant rather than
 * a Horizon read because a preflight that needed an extra network round-trip to
 * answer would be a worse trade than a value that has not moved in years.
 */
export const BASE_RESERVE_STROOPS = 5_000_000n;

/**
 * Subentries every account carries before any trustline or signer is added.
 * The minimum balance is `(2 + subentries) * baseReserve`.
 */
const BASE_SUBENTRY_COUNT = 2n;

/**
 * Fee for the envelope this API builds, in stroops.
 *
 * Mirrors `stellar.buildPayment`, which sets `BASE_FEE * 2` on a single-
 * operation transaction. Kept in step with it deliberately: a preflight that
 * assumed a cheaper fee than the envelope actually carries would pass an
 * account that then cannot pay.
 */
export const SETTLEMENT_FEE_STROOPS = BigInt(Number(BASE_FEE) * 2);

/** Every distinct reason a preflight can fail. */
export type PreflightFailureReason =
  /** The source account does not exist on the network (never funded). */
  | "account_not_found"
  /** The source account holds no trustline for the issued asset being sent. */
  | "missing_trustline"
  /** Not enough of the asset being sent. */
  | "insufficient_asset_balance"
  /** Enough of the asset, but not enough XLM left for the fee and reserve. */
  | "insufficient_fee_balance"
  /** Horizon could not be reached or did not answer. */
  | "upstream_unavailable";

export interface PreflightOk {
  ok: true;
  /** Fee the built envelope will carry, as a decimal XLM string. */
  feeXlm: string;
}

export interface PreflightFailure {
  ok: false;
  reason: PreflightFailureReason;
  /**
   * Short, client-safe explanation. Deliberately free of balance figures: a
   * settlement's counterparty can trigger this path, and the concise message is
   * enough to act on without disclosing what the payer holds.
   */
  message: string;
}

export type PreflightResult = PreflightOk | PreflightFailure;

export interface PreflightParams {
  /** Account that will send the payment. */
  sourcePublicKey: string;
  /** Asset code being sent ("XLM" or an issued code such as "USDC"). */
  assetCode: string;
  /** Issuer of the asset; null for native XLM. */
  assetIssuer: string | null;
  /** Payment amount as a decimal string. */
  amount: string;
}

/**
 * Minimum XLM this account must retain, in stroops.
 *
 * `(2 + subentries) * baseReserve`. Subentries are counted from the balances
 * Horizon reports: every non-native balance line is a trustline, and each
 * trustline is one subentry. Signers beyond the master key and any offers or
 * data entries also count, so this is a *lower bound* on the true reserve —
 * erring toward accepting a marginal account rather than rejecting a valid one,
 * since Horizon has the final say at submission either way.
 */
export function minimumBalanceStroops(account: AccountSnapshot): bigint {
  const trustlines = BigInt(
    account.balances.filter((b) => b.assetIssuer !== null).length
  );
  // Horizon always reports at least the master key, but a snapshot that omits
  // signers still yields a valid (slightly lower) reserve rather than throwing.
  const signerCount = Array.isArray(account.signers) ? account.signers.length : 0;
  const extraSigners = BigInt(Math.max(0, signerCount - 1));
  return (BASE_SUBENTRY_COUNT + trustlines + extraSigners) * BASE_RESERVE_STROOPS;
}

/** The account's native XLM balance in stroops, or 0n if it holds none. */
export function nativeBalanceStroops(account: AccountSnapshot): bigint {
  const native = account.balances.find(
    (b) => b.assetIssuer === null && b.assetCode === "XLM"
  );
  return native ? parseHorizonBalance(native.balance) : 0n;
}

/**
 * XLM that may actually leave the account: balance minus the reserve it must
 * retain. Never negative — an account already at or under its reserve has zero
 * spendable, not a negative amount.
 */
export function spendableXlmStroops(account: AccountSnapshot): bigint {
  const spendable = nativeBalanceStroops(account) - minimumBalanceStroops(account);
  return spendable > 0n ? spendable : 0n;
}

/**
 * Locate the balance line for an issued asset. Matches on code *and* issuer:
 * two assets can share a code, and paying the wrong issuer's asset is exactly
 * the confusion this rejects.
 */
function issuedBalanceStroops(
  account: AccountSnapshot,
  assetCode: string,
  assetIssuer: string
): bigint | null {
  const line = account.balances.find(
    (b) => b.assetCode === assetCode && b.assetIssuer === assetIssuer
  );
  return line ? parseHorizonBalance(line.balance) : null;
}

function failure(
  reason: PreflightFailureReason,
  message: string
): PreflightFailure {
  return { ok: false, reason, message };
}

/**
 * Decide a preflight from an already-loaded account snapshot.
 *
 * Pure: no I/O, no clock, no ledger mutation. `checkSettlementPreflight` wraps
 * it with the Horizon load, and tests drive this directly with a fixture.
 *
 * Order matters. Existence, then the asset the payment is denominated in, then
 * fee capacity — so an account that is short on *both* the asset and XLM is
 * reported against the asset it is trying to send, which is the more useful
 * answer.
 */
export function evaluatePreflight(
  account: AccountSnapshot,
  params: PreflightParams
): PreflightResult {
  // A snapshot that is absent or missing its balance array tells us nothing
  // about the account. That is an upstream problem, not evidence the payer is
  // short — and it must not throw: this runs inside the worker's job loop,
  // where an unexpected Horizon shape should degrade, not abort the job.
  if (!account || !Array.isArray(account.balances)) {
    return failure(
      "upstream_unavailable",
      "Could not read your Stellar account to check your balance. Try again shortly."
    );
  }

  if (!account.exists) {
    return failure(
      "account_not_found",
      "Your Stellar account is not funded yet. Fund it before settling."
    );
  }

  // The amount reaches here from a Prisma Decimal as often as from a validated
  // request body, and `Decimal.toString()` is not always canonical. It is
  // parsed the same forgiving way as a Horizon balance — but an unparseable
  // amount is a caller bug, not a zero payment, so it is rejected outright
  // rather than silently treated as free.
  const amount = parseHorizonBalance(params.amount);
  if (amount <= 0n) {
    return failure(
      "insufficient_asset_balance",
      "Settlement amount must be greater than zero."
    );
  }
  const isNative = params.assetIssuer === null;
  const feeXlm = fromStroops(SETTLEMENT_FEE_STROOPS);

  if (isNative) {
    // One balance covers both the payment and its fee, so they are checked
    // together against a single spendable figure — checking them separately
    // would pass an account that can afford either but not both.
    if (spendableXlmStroops(account) < amount + SETTLEMENT_FEE_STROOPS) {
      return failure(
        "insufficient_asset_balance",
        "Not enough XLM to cover this payment, the network fee, and the account reserve."
      );
    }
    return { ok: true, feeXlm };
  }

  // Issued asset: the trustline must exist before its balance means anything.
  // A missing trustline and a zero balance are different problems with
  // different fixes (establish a trustline vs. acquire the asset), so they get
  // different outcomes.
  const assetBalance = issuedBalanceStroops(
    account,
    params.assetCode,
    params.assetIssuer as string
  );
  if (assetBalance === null) {
    return failure(
      "missing_trustline",
      `Your account has no ${params.assetCode} trustline. Add one before settling in ${params.assetCode}.`
    );
  }
  if (assetBalance < amount) {
    return failure(
      "insufficient_asset_balance",
      `Not enough ${params.assetCode} to cover this payment.`
    );
  }

  // The fee is always paid in XLM, never in the asset being sent. An account
  // rich in USDC and empty of XLM cannot settle, and this is the check that
  // says so rather than letting Horizon reject it after signing.
  if (spendableXlmStroops(account) < SETTLEMENT_FEE_STROOPS) {
    return failure(
      "insufficient_fee_balance",
      "Not enough XLM to cover the network fee and the account reserve."
    );
  }

  return { ok: true, feeXlm };
}

/**
 * Load the payer's account and evaluate the preflight against it.
 *
 * Read-only. Horizon being unreachable is its own outcome rather than an
 * exception, so the caller decides whether to refuse the settlement or proceed
 * — a preflight that could not run is not the same as one that failed.
 */
export async function checkSettlementPreflight(
  params: PreflightParams
): Promise<PreflightResult> {
  let account: AccountSnapshot;
  try {
    account = await stellar.loadAccount(params.sourcePublicKey);
  } catch {
    // The upstream error text may carry provider detail we do not surface, and
    // an unreachable Horizon says nothing about the account's balance.
    return failure(
      "upstream_unavailable",
      "Could not reach the Stellar network to check your balance. Try again shortly."
    );
  }

  return evaluatePreflight(account, params);
}

/** Maps each failure reason to the error the API responds with. */
const FAILURE_ERRORS: Record<PreflightFailureReason, (message: string) => Error> = {
  account_not_found: (message) => Errors.badRequest("account_unfunded", message),
  missing_trustline: (message) => Errors.badRequest("missing_trustline", message),
  insufficient_asset_balance: (message) =>
    Errors.badRequest("insufficient_balance", message),
  insufficient_fee_balance: (message) =>
    Errors.badRequest("insufficient_fee_balance", message),
  // Not the caller's fault, and retrying may well succeed — so 502, not 400.
  upstream_unavailable: (message) => Errors.upstream(message),
};

/**
 * Throw the `AppError` matching a failed preflight, or return it unchanged if
 * it passed.
 *
 * Split out from the async entry point so a caller that already holds an
 * account snapshot — the settlement route, which loads the account anyway for
 * its sequence number — gets identical error mapping without a second Horizon
 * read. This is what keeps the route and the worker from drifting on what a
 * given failure reports.
 */
export function assertPreflightResult(result: PreflightResult): PreflightOk {
  if (result.ok) return result;
  throw FAILURE_ERRORS[result.reason](result.message);
}

/**
 * Load the account, run the preflight, and throw on failure.
 *
 * The entry point for callers with no snapshot of their own.
 */
export async function assertSettlementPreflight(
  params: PreflightParams
): Promise<PreflightOk> {
  return assertPreflightResult(await checkSettlementPreflight(params));
}
