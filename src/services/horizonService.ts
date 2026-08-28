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
