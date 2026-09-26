/**
 * Horizon transaction verification service.
 *
 * Verifies on-chain transaction details (memo, payment operations) against
 * expected settlement values by fetching transaction data directly from
 * Horizon. This is the defensive check that ensures a confirmed on-chain
 * transaction actually matches what the API authorized.
 *
 * Horizon I/O is kept in this module so tests can mock a single dependency.
 */
import { Horizon, Memo } from "@stellar/stellar-sdk";
import { config } from "../config";
import { Errors } from "../errors";
import { withTimeout, TimeoutError, TransportError } from "./timeout";
import {
  classifyHorizonError,
  horizonRetryDelayMs,
  withHorizonRetry,
  type HorizonRetryPolicy,
} from "./horizon-retry";
import {
  parseMemo,
  validatePaymentMemo,
  type PaymentMemoFailureReason,
} from "../lib/memo";

let _server: Horizon.Server | null = null;
/**
 * Lazily constructed Horizon client, shared by every call in this module so
 * connection reuse is the default and tests only need to mock `HORIZON_URL`.
 */
function server(): Horizon.Server {
  if (!_server) _server = new Horizon.Server(config.HORIZON_URL);
  return _server;
}

/**
 * Retry policy for Horizon query reads, driven by the documented
 * HORIZON_READ_RETRY_* environment variables (see README "Horizon read
 * retries"). Resolved per call so tests and runtime overrides take effect.
 */
function readRetryPolicy(): HorizonRetryPolicy {
  return {
    maxAttempts: config.HORIZON_READ_RETRY_MAX_ATTEMPTS,
    initialDelayMs: config.HORIZON_READ_RETRY_INITIAL_DELAY_MS,
    maxDelayMs: config.HORIZON_READ_RETRY_MAX_DELAY_MS,
    jitterRatio: 0.25,
  };
}

/**
 * Bounded sleep used between retry attempts. Injectable delay inside
 * `withHorizonRetry` keeps the backoff schedule testable without real time.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a Horizon query read with bounded retries, exponential backoff, and
 * jitter (issue #531).
 *
 * Horizon query endpoints occasionally return transient failures — rate
 * limits, 5xx, dropped connections — that a later attempt survives. Rather
 * than failing the read (and every caller behind it) on the first blip, the
 * call is retried up to the configured budget. Non-retryable client errors
 * (400 validation, 404 "not visible yet", rejected transaction result codes)
 * are classified by `classifyHorizonError` and surfaced immediately, without
 * spending attempts.
 *
 * Every call here is a pure read — repeating it yields the same or a fresher
 * answer and creates nothing — so retrying cannot duplicate an on-chain
 * effect. Transaction submission never goes through this helper.
 *
 * @param operation - Label used in errors and logs.
 * @param fn - The single-attempt Horizon query, already timeout-bounded.
 * @returns The query's result once an attempt succeeds.
 * @throws The last error after the budget is exhausted, or immediately for
 *   a non-retryable classification.
 */
async function withQueryRetry<T>(
  operation: string,
  fn: () => Promise<T>
): Promise<T> {
  const policy = readRetryPolicy();
  const outcome = await withHorizonRetry(
    () => withTimeout(operation, config.HORIZON_STATUS_TIMEOUT_MS, async () => fn()),
    {
      classify: classifyHorizonError,
      policy,
      // withHorizonRetry computes the backoff itself; this injectable delay
      // applies it, so the schedule is observable in tests.
      delay: (ms) => sleep(ms),
    }
  );
  if (outcome.ok) return outcome.value;

  // Retries exhausted (or a permanent failure): map onto the module's stable
  // upstream shape, preserving TimeoutError/TransportError for callers that
  // classify outcomes themselves (the worker's reconciliation).
  const last = outcome.lastError;
  if (last instanceof TimeoutError || last instanceof TransportError) throw last;
  if (last instanceof Error && last.name === "NotFoundError") throw last;
  const status = (last as { response?: { status?: number } } | null)?.response?.status;
  if (status === 404) throw last;
  if (last instanceof Error) {
    throw Errors.upstream(`Horizon request failed: ${last.message}`);
  }
  throw Errors.upstream("Horizon request failed with unknown error");
}

/**
 * Minimal representation of a Horizon transaction record.
 * Only the fields needed for verification are included.
 */
export interface HorizonTransactionRecord {
  hash: string;
  successful: boolean;
  memo?: string;
  memo_type?: string;
  memo_bytes?: string;
  source_account: string;
  fee_charged: number | string;
  operation_count: number;
  created_at: string;
}

/**
 * A single payment operation from a Horizon transaction.
 */
export interface HorizonPaymentOperation {
  type: string;
  destination: string;
  amount: string;
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  source_account?: string;
}

/**
 * Fetch a transaction by hash from Horizon.
 *
 * Returns the transaction record if found, or null for 404 (not yet visible).
 * Transient Horizon failures are retried with bounded exponential backoff
 * before the error surfaces (issue #531); a 404 is a domain answer and never
 * consumes the retry budget. Throws descriptive AppErrors for network,
 * timeout, or Horizon failures after the budget is exhausted.
 * Throws descriptive AppErrors for network, timeout, or Horizon failures.
 *
 * @param txHash - The hex transaction hash to look up.
 * @returns The Horizon record when found, or `null` when Horizon reports 404 —
 *   a transaction that has not yet been ingested is "not visible yet", not an
 *   error, so the caller decides whether to poll again.
 * @throws {TimeoutError} when the call exceeds `HORIZON_STATUS_TIMEOUT_MS`;
 *   re-thrown unmapped so callers can distinguish "unknown outcome".
 * @throws {TransportError} on DNS/socket/connection failures; re-thrown unmapped.
 * @throws {AppError} `upstream` for any other Horizon failure (5xx, rate limit,
 *   malformed response), carrying only the sanitized upstream message.
 */
export async function getTransactionFromHorizon(
  txHash: string
): Promise<HorizonTransactionRecord | null> {
  try {
    const tx = await withQueryRetry("Horizon.getTransactionDetails", async () => {
      return server().transactions().transaction(txHash).call();
    });
    return tx as unknown as HorizonTransactionRecord;
  } catch (e: any) {
    if (e?.response?.status === 404 || e?.name === "NotFoundError") {
      return null;
    }
    // Re-throw TimeoutError and TransportError as-is so callers can classify them.
    if (e instanceof TimeoutError || e instanceof TransportError) {
      throw e;
    }
    // Map other Horizon errors to descriptive backend errors.
    if (e instanceof Error) {
      throw Errors.upstream(`Horizon request failed: ${e.message}`);
    }
    throw Errors.upstream("Horizon request failed with unknown error");
  }
}

/**
 * Fetch the payment operations for a given transaction from Horizon.
 *
 * Returns an array of payment operations (may be empty if the transaction
 * has no payment operations). Transient Horizon failures are retried with
 * bounded exponential backoff before the error surfaces (issue #531).
 * Throws descriptive AppErrors for network failures after the budget is
 * exhausted.
 * has no payment operations). Throws descriptive AppErrors for network failures.
 *
 * @param txHash - The hex transaction hash whose operations are read.
 * @returns The transaction's payment operations, at most 100 (Horizon's page
 *   limit for this call). Non-payment operations are filtered out; a
 *   transaction with no payments yields `[]`, not an error.
 * @throws {TimeoutError} when the call exceeds `HORIZON_STATUS_TIMEOUT_MS`.
 * @throws {TransportError} on DNS/socket/connection failures.
 * @throws {AppError} `upstream` for any other failure Horizon reports (4xx/5xx,
 *   an unknown or still-ingesting transaction).
 */
export async function getTransactionPayments(
  txHash: string
): Promise<HorizonPaymentOperation[]> {
  try {
    const result = await withQueryRetry("Horizon.getTransactionPayments", async () => {
      const payments = server()
        .operations()
        .forTransaction(txHash)
        .limit(100);
      const records = await payments.call();
      return records.records.filter(
        (op: any) => op.type === "payment"
      ) as unknown as HorizonPaymentOperation[];
    });
    return result;
  } catch (e: any) {
    if (e instanceof TimeoutError || e instanceof TransportError) {
      throw e;
    }
    if (e instanceof Error) {
      throw Errors.upstream(`Horizon request failed: ${e.message}`);
    }
    throw Errors.upstream("Horizon request failed with unknown error");
  }
}

/**
 * Verify a transaction fetched from Horizon has the expected memo.
 *
 * Checks:
 *  - Transaction exists (returns null for not-found, caller decides)
 *  - Transaction was successful on-chain
 *  - The on-chain memo passes `validatePaymentMemo` (src/lib/memo.ts): it is
 *    a `text` memo that parses as `MP:<code>` with exactly the expected code.
 *    Missing, hash (well-formed or not), id, return, malformed, and
 *    mismatched memos are all rejected, each with a distinct reason.
 *
 * Returns the verified on-chain memo and its parsed code on success.
 * Throws descriptive AppErrors on any verification failure.
 *
 * @param txHash - The hex transaction hash to fetch and verify.
 * @param expectedMemo - The exact memo expected on chain — the `MP:`-prefixed
 *   text the transaction was built with (see `memoText` in `stellar.ts`),
 *   e.g. `MP:SETL123`.
 * @returns `{ verified: true, memo, code }` — `memo` is the text read from
 *   the ledger, so callers resolve records from what was actually paid.
 * @throws {AppError} `not_found` when Horizon has no such transaction yet.
 * @throws {AppError} `bad_request` (`transaction_verification_failed`) when
 *   `expectedMemo` is not itself a valid `MP:<code>` memo, or when the
 *   transaction failed on-chain or carries a memo that cannot be attributed
 *   to `expectedMemo`. `details.memoFailure` carries the
 *   {@link PaymentMemoFailureReason}.
 * @throws {TimeoutError} when the Horizon read exceeds its deadline.
 * @throws {TransportError} on a connection failure to Horizon.
 * @throws {AppError} `upstream` for other Horizon failures.
 */
export async function verifyTransactionMemo(
  txHash: string,
  expectedMemo: string
): Promise<{ verified: true; memo: string; code: string }> {
  const expected = parseMemo(expectedMemo);
  if (!expected.ok) {
    throw Errors.badRequest(
      "transaction_verification_failed",
      `Expected memo is not a valid Mergepay reference: ${expected.message}`
    );
  }

  const tx = await getTransactionFromHorizon(txHash);

  if (tx === null) {
    throw Errors.notFound("Transaction not found on Horizon");
  }

  if (!tx.successful) {
    throw Errors.badRequest(
      "transaction_verification_failed",
      "Transaction was not successful on Stellar"
    );
  }

  const result = validatePaymentMemo(
    { memoType: tx.memo_type, memo: tx.memo },
    expected.code
  );
  if (!result.ok) {
    const details: { memoFailure: PaymentMemoFailureReason } = {
      memoFailure: result.reason,
    };
    throw Errors.badRequest("transaction_verification_failed", result.message, details);
  }

  return { verified: true, memo: result.memo, code: result.code };
}

/**
 * Verify a single payment operation from a Horizon transaction matches
 * the expected destination, amount, and asset.
 *
 * This is defensive: it inspects what actually landed on-chain, not what
 * was in the signed XDR envelope. Only payment operations are treated as
 * evidence of a settlement payment — other operation types are ignored.
 *
 * Pure and synchronous: no Horizon I/O, so it is safe to call on records
 * already in hand.
 *
 * @param op - The operation record read from Horizon (via
 *   {@link getTransactionPayments}).
 * @param expected - `{ destination, amount, assetCode, assetIssuer }`; pass
 *   `assetCode: "XLM"` with `assetIssuer: null` for the native asset.
 * @returns `void` — resolves when the operation matches on every field.
 * @throws {AppError} `bad_request` (`transaction_verification_failed`) when
 *   `op` is not a payment operation.
 * @throws {AppError} `bad_request` (`settlement_verification_failed`) when the
 *   destination, amount, asset code, or asset issuer differs. Amounts are
 *   compared at stroop precision (7 decimal places), so trailing-zero
 *   formatting differences are not treated as mismatches.
 */
export function verifyPaymentOperation(
  op: HorizonPaymentOperation,
  expected: {
    destination: string;
    amount: string;
    assetCode: string;
    assetIssuer: string | null;
  }
): void {
  if (op.type !== "payment") {
    throw Errors.badRequest(
      "transaction_verification_failed",
      `Expected a payment operation, got "${op.type}"`
    );
  }

  if (op.destination !== expected.destination) {
    throw Errors.badRequest(
      "settlement_verification_failed",
      "Payment destination does not match the expected recipient"
    );
  }

  if (normalizeAmount(op.amount) !== normalizeAmount(expected.amount)) {
    throw Errors.badRequest(
      "settlement_verification_failed",
      "Payment amount does not match the expected settlement amount"
    );
  }

  // Verify the asset matches. Native XLM is represented as asset_type "native".
  if (expected.assetCode === "XLM" && expected.assetIssuer === null) {
    if (op.asset_type !== "native") {
      throw Errors.badRequest(
        "settlement_verification_failed",
        "Payment asset does not match: expected native XLM"
      );
    }
  } else {
    if (op.asset_code !== expected.assetCode) {
      throw Errors.badRequest(
        "settlement_verification_failed",
        `Payment asset code does not match: expected "${expected.assetCode}", got "${op.asset_code}"`
      );
    }
    if (op.asset_issuer !== expected.assetIssuer) {
      throw Errors.badRequest(
        "settlement_verification_failed",
        `Payment asset issuer does not match: expected "${expected.assetIssuer}", got "${op.asset_issuer}"`
      );
    }
  }
}

/**
 * Normalize a Stellar amount string for comparison.
 * Compares at 7 decimal places (stroops precision) regardless of trailing zeros.
 */
function normalizeAmount(a: string): string {
  const [w, f = ""] = a.split(".");
  return `${w}.${(f + "0000000").slice(0, 7)}`;
}
