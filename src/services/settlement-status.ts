/**
 * Public settlement status: the single source of truth a client can poll after
 * creating or signing a settlement.
 *
 * ## Why this exists
 *
 * The `settlements.status` column is an internal field that has accumulated
 * several values over time (`pending`, `submitted`, `confirmed`, `failed`,
 * `expired`, and whatever a future flow adds). Clients should not have to know
 * that set, nor infer progress from an unrelated group or expense response. This
 * module maps persisted state to a small, documented, stable set of public
 * values and combines it with an on-chain lookup.
 *
 * ## Public status values
 *
 *   awaiting_signature — the unsigned XDR has been issued; the wallet has not
 *                        returned a signed one yet. Client action: sign it.
 *   submitted          — a signed envelope has been accepted and is being
 *                        submitted; not yet visible or successful on-chain.
 *                        Client action: keep polling.
 *   confirmed          — the payment succeeded on-chain. Terminal.
 *   failed             — submission was rejected, or the transaction failed
 *                        on-chain. Terminal; `failure` explains why.
 *   expired            — the signing window closed before submission. Terminal;
 *                        the remedy is a new settlement, not a retry.
 *
 * ## "Not found on-chain" is not "confirmed"
 *
 * A transaction hash that Horizon does not yet know about is the *normal* state
 * for the first few seconds after submission — Horizon only sees a transaction
 * once it is in a closed ledger. Treating that as success would report a payment
 * that may still fail. So `onChain.found` is reported as `false` and the status
 * stays `submitted`; only an explicitly successful Horizon record advances it to
 * `confirmed`, and only an explicitly unsuccessful one to `failed`.
 *
 * ## What is never returned
 *
 * No signed or unsigned XDR, no anchor or session token, no provider
 * credentials, and no upstream error text or stack. Failure information is
 * limited to a short, already-scrubbed reason recorded by the worker.
 */
import { stellar } from "./stellar";
import { isIntentExpired, secondsUntilExpiry } from "../lib/time-bounds";
import {
  isSettlementFailureCategory,
  type SettlementFailureCategory,
} from "./settlement-failure";

/** The documented, stable set of public statuses. */
export const SETTLEMENT_STATUSES = [
  "awaiting_signature",
  "submitted",
  "confirmed",
  "failed",
  "expired",
] as const;

export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

/** Whether a public status can still change. */
export function isTerminalSettlementStatus(status: SettlementStatus): boolean {
  return status === "confirmed" || status === "failed" || status === "expired";
}

/**
 * How long a Horizon lookup may take before the endpoint answers without it.
 *
 * A status read must never block on a slow provider: the persisted state is
 * always available and is the authoritative record of what this API did, so a
 * timeout degrades the response (`onChain.checked: false`) rather than failing
 * it.
 */
export const HORIZON_LOOKUP_TIMEOUT_MS = 2_500;

/** The persisted fields this module needs. Deliberately excludes the XDR. */
export interface SettlementStatusInput {
  status: string;
  stellarTxHash: string | null;
  transactionXdr?: string | null;
  failureReason: string | null;
  /**
   * Stable failure category. Optional so a row read before this column existed
   * — or by a caller selecting a narrower shape — still satisfies the type.
   */
  failureCategory?: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OnChainStatus {
  /** Whether a Horizon lookup was attempted and answered in time. */
  checked: boolean;
  /** Whether Horizon has a record of the transaction yet. */
  found: boolean;
  /** Horizon's own success flag; null when not found or not checked. */
  successful: boolean | null;
  transactionHash: string | null;
}

/**
 * Why a settlement failed. Present only on a failed settlement.
 *
 * `category` is the stable, machine-readable half — clients branch on it.
 * `reason` is the sanitized human-readable half, already scrubbed of XDRs,
 * credentials, and upstream payloads before it was persisted.
 */
export interface SettlementFailureInfo {
  category: SettlementFailureCategory;
  reason: string;
}

export interface SettlementStatusResult {
  status: SettlementStatus;
  onChain: OnChainStatus;
  failure: SettlementFailureInfo | null;
  expiresAt: string | null;
  expiresInSeconds: number | null;
  checkedAt: string;
}

/**
 * Build the client-visible failure block for a settlement.
 *
 * Two rules, both deliberate:
 *
 *  - **Only for failures.** A settlement carries a `failureReason` while it is
 *    still retrying — the worker records each attempt's reason before deciding
 *    whether to try again. Surfacing that on a `submitted` settlement would
 *    report a payment as broken while it is still perfectly likely to succeed.
 *    The public status, not the persisted column, decides.
 *  - **Always a category.** A row that failed before the category column
 *    existed still returns a usable shape; an unrecognised or absent value
 *    reads as "internal" rather than being passed through, so a client can
 *    exhaustively switch on the documented set.
 */
export function toFailureInfo(
  settlement: SettlementStatusInput,
  publicStatus: SettlementStatus
): SettlementFailureInfo | null {
  if (publicStatus !== "failed") return null;

  const reason = settlement.failureReason?.trim();
  const category = isSettlementFailureCategory(settlement.failureCategory)
    ? settlement.failureCategory
    : "internal";

  return {
    category,
    reason: reason && reason.length > 0 ? reason : "Settlement failed",
  };
}

/**
 * Map persisted state to a public status, without consulting Horizon.
 *
 * Expiry is evaluated for non-terminal rows only: a settlement that already
 * confirmed keeps that status even if its intent window has since passed —
 * the payment happened, and reporting it as expired would be wrong.
 */
export function toPublicStatus(
  settlement: SettlementStatusInput,
  now: Date = new Date()
): SettlementStatus {
  switch (settlement.status) {
    case "confirmed":
      return "confirmed";
    case "failed":
      return "failed";
    case "expired":
      return "expired";
    case "submitted":
      // An intent whose window closed before it reached the ledger is expired,
      // not merely in flight — the worker will mark the row shortly, and
      // reporting "submitted" would suggest it may still land.
      return isIntentExpired(settlement.expiresAt, now) ? "expired" : "submitted";
    case "pending":
    default:
      // "pending" means the unsigned XDR was issued and no signed one has come
      // back. Anything unrecognised is reported the same conservative way: not
      // yet signed, definitely not paid.
      return isIntentExpired(settlement.expiresAt, now)
        ? "expired"
        : "awaiting_signature";
  }
}

/** Resolve a Horizon lookup, or give up quietly after the timeout. */
async function lookupOnChain(hash: string): Promise<OnChainStatus> {
  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), HORIZON_LOOKUP_TIMEOUT_MS)
  );

  let result: Awaited<ReturnType<typeof stellar.getTransaction>> | null;
  try {
    result = await Promise.race([stellar.getTransaction(hash), timeout]);
  } catch {
    // A Horizon error is not a client error, and its text may carry upstream
    // detail we do not surface. The persisted state still answers the request.
    return { checked: false, found: false, successful: null, transactionHash: hash };
  }

  if (result === null) {
    // Either the race timed out, or Horizon has no record of the hash yet.
    // `getTransaction` returns null for a 404, which is the ordinary state for
    // a few seconds after submission — never treated as success.
    return { checked: true, found: false, successful: null, transactionHash: hash };
  }

  return {
    checked: true,
    found: true,
    successful: result.successful,
    transactionHash: hash,
  };
}

/**
 * Combine persisted state with an on-chain lookup into the public status.
 *
 * The lookup runs only when it can change the answer: there is a transaction
 * hash and the persisted status is not already terminal. A confirmed or failed
 * settlement is answered from the database alone, so polling a finished
 * settlement costs no Horizon request.
 */
export async function resolveSettlementStatus(
  settlement: SettlementStatusInput,
  now: Date = new Date()
): Promise<SettlementStatusResult> {
  let status = toPublicStatus(settlement, now);

  let onChain: OnChainStatus = {
    checked: false,
    found: false,
    successful: null,
    transactionHash: settlement.stellarTxHash ?? null,
  };

  if (settlement.stellarTxHash && !isTerminalSettlementStatus(status)) {
    onChain = await lookupOnChain(settlement.stellarTxHash);

    if (onChain.found && onChain.successful === true) {
      status = "confirmed";
    } else if (onChain.found && onChain.successful === false) {
      status = "failed";
    }
    // Not found (or not checked) leaves the status as it was — pending is
    // pending, and an absent Horizon record is never evidence of payment.
  }

  return {
    status,
    onChain,
    // Resolved against the *final* status, so a settlement the Horizon lookup
    // just moved to failed reports its reason in the same response.
    failure: toFailureInfo(settlement, status),
    expiresAt: settlement.expiresAt ? settlement.expiresAt.toISOString() : null,
    expiresInSeconds: settlement.expiresAt
      ? secondsUntilExpiry(settlement.expiresAt, now)
      : null,
    checkedAt: now.toISOString(),
  };
}
