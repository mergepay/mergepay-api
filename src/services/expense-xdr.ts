/**
 * Bind a wallet-signed envelope to the expense intent the API created for a group expense.
 *
 * Mergepay never holds a private key: it builds an unsigned XDR, hands it to a
 * wallet, and gets a signed envelope back. Everything between those two moments is
 * outside our control — a compromised or buggy wallet can return a validly signed
 * transaction that pays a different account, a different asset, or a different amount.
 *
 * This module rebuilds the expectation from the stored group expense record —
 * never from anything the client sent — and checks the envelope against it before submission.
 * A mismatch stops the request with a 400 Bad Request error.
 */
import { Errors } from "../errors";
import {
  validateSignedXdr,
  type PaymentExpectation,
  type SignedXdrValidation,
} from "./stellar";

/** The persisted fields a group expense intent is rebuilt from. */
export interface ExpenseIntentRecord {
  shortCode?: string;
  memoCode?: string;
  amount: unknown;
  assetCode: string;
  assetIssuer: string | null;
  /** Server-controlled signing deadline; null on rows predating expiry tracking. */
  expiresAt?: Date | null;
  /** Sequence used to build the persisted unsigned payment intent, when stored. */
  sourceSequence?: string;
  from: { stellarPublicKey: string };
  to: { stellarPublicKey: string };
}

/**
 * Rebuild the payment expectation authorized by a group expense intent.
 *
 * Every field comes from the stored database record. The memo code ties an
 * on-chain payment back to this record.
 */
export function expensePaymentIntent(
  expense: ExpenseIntentRecord
): PaymentExpectation {
  const memoCode = expense.memoCode ?? expense.shortCode ?? "";
  return {
    sourcePublicKey: expense.from.stellarPublicKey,
    destination: expense.to.stellarPublicKey,
    asset: { code: expense.assetCode, issuer: expense.assetIssuer },
    amount: String(expense.amount),
    memoCode,
    sourceSequence: expense.sourceSequence,
    expiresAt: expense.expiresAt ?? null,
    resource: "expense",
  };
}

/**
 * Validate a wallet-signed envelope against a group expense's own intent.
 *
 * Covers: parseability (and rejection of fee-bump wrappers), validity window
 * against recorded expiry, transaction source, operation count, fee bounds,
 * operation type and source, destination account, asset code and issuer, amount,
 * memo, and signature verification against the source account for configured
 * network passphrase.
 *
 * Throws `AppError` (400 `XDR_MISMATCH`, `XDR_MALFORMED`, or `INTENT_EXPIRED`)
 * with a stable message.
 */
export function validateExpenseXdr(
  signedXdr: string,
  expense: ExpenseIntentRecord
): SignedXdrValidation {
  return validateSignedXdr(signedXdr, expensePaymentIntent(expense));
}
