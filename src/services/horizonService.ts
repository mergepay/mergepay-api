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
    const tx = await withTimeout(
      "Horizon.getTransactionDetails",
      config.HORIZON_STATUS_TIMEOUT_MS,
      async () => {
        return server().transactions().transaction(txHash).call();
      }
    );
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
    const result = await withTimeout(
      "Horizon.getTransactionPayments",
      config.HORIZON_STATUS_TIMEOUT_MS,
      async () => {
        const payments = server()
          .operations()
          .forTransaction(txHash)
          .limit(100);
        const records = await payments.call();
        return records.records.filter(
          (op: any) => op.type === "payment"
        ) as unknown as HorizonPaymentOperation[];
      }
    );
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
 *  - Transaction has a memo
 *  - Memo type is "text" (the only type Mergepay uses)
 *  - Memo content matches the expected value exactly
 *
 * Returns { verified: true } on success.
 * Throws descriptive AppErrors on any verification failure.
 *
 * @param txHash - The hex transaction hash to fetch and verify.
 * @param expectedMemo - The exact memo expected on chain — the `MP:`-prefixed
 *   text the transaction was built with (see `memoText` in `stellar.ts`),
 *   e.g. `MP:SETL123`.
 * @returns `{ verified: true }` when the transaction exists, succeeded, and
 *   carries a text memo equal to `expectedMemo`.
 * @throws {AppError} `not_found` when Horizon has no such transaction yet.
 * @throws {AppError} `bad_request` (`transaction_verification_failed`) when the
 *   transaction failed on-chain, has no memo, uses a non-text memo type, or
 *   carries a different memo.
 * @throws {TimeoutError} when the Horizon read exceeds its deadline.
 * @throws {TransportError} on a connection failure to Horizon.
 * @throws {AppError} `upstream` for other Horizon failures.
 */
export async function verifyTransactionMemo(
  txHash: string,
  expectedMemo: string
): Promise<{ verified: true }> {
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

  if (!tx.memo_type || tx.memo_type === "none") {
    throw Errors.badRequest(
      "transaction_verification_failed",
      "Transaction has no memo"
    );
  }

  if (tx.memo_type !== "text") {
    throw Errors.badRequest(
      "transaction_verification_failed",
      `Unexpected memo type: expected "text", got "${tx.memo_type}"`
    );
  }

  if (tx.memo !== expectedMemo) {
    throw Errors.badRequest(
      "transaction_verification_failed",
      "Transaction memo does not match the expected settlement reference"
    );
  }

  return { verified: true };
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
