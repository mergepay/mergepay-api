/**
 * Inspect a wallet-signed Stellar envelope against the intent it must match,
 * and report what diverged instead of throwing (issue #694).
 *
 * ## Why this exists alongside `validateSignedXdr`
 *
 * Mergepay never holds a private key. It builds an unsigned XDR, hands it to a
 * wallet, and gets *something* back — a compromised or buggy wallet can return
 * a validly signed transaction that pays a different account, a different
 * asset, or a different amount, and Horizon would accept it happily. The
 * submission paths guard against that with `validateSignedXdr`, which throws
 * the first divergence as a 400 so the request stops.
 *
 * Some callers need the same judgement without the throw: an operator tool
 * explaining why an envelope was refused, a reconciliation pass classifying a
 * stored envelope, a validator that wants the field name rather than prose.
 * Writing a second validator for them is how a weaker one ends up in
 * production — it was: `src/utils/stellar-xdr.ts` carried a copy that never
 * checked signatures or sequence numbers, compared amounts as raw strings (so
 * `"10"` did not match `"10.0000000"`), and reported a fee-bump envelope as
 * "must contain exactly one operation".
 *
 * So this module adds no rules of its own. It composes the same three
 * primitives the submission paths use:
 *
 *  1. `parseSignedPaymentXdr` — decode, and reject fee-bump wrappers;
 *  2. `assertTimeBoundsValid`  — the envelope's validity window against the
 *     intent's recorded expiry;
 *  3. `matchPaymentIntent`     — source, sequence, operation count, fee band,
 *     operation type and source, destination, asset code and issuer, amount,
 *     and memo;
 *  4. `verifySourceSignature`  — a signature that verifies against the
 *     expected source account for the configured network passphrase.
 *
 * ## Order
 *
 * Shape before content, content before signature. An envelope that is not the
 * payment we authorized is reported as *that*, not as a signature problem —
 * which is the more useful answer, since a wallet returning the wrong payment
 * will have signed it perfectly.
 *
 * ## What a rejection may say
 *
 * Only which field diverged, never the value found. The envelope is untrusted
 * input and a rejection is logged and returned to a client, so echoing its
 * contents back would both leak the caller's own payload into logs and turn
 * this into an oracle for probing stored intents.
 */
import { AppError } from "../lib/errors";
import {
  assertTimeBoundsValid,
  matchPaymentIntent,
  parseSignedPaymentXdr,
  verifySourceSignature,
  type PaymentExpectation,
  type PaymentIntentField,
} from "./stellar";
import type { Transaction } from "@stellar/stellar-sdk";

/**
 * Why an envelope was refused.
 *
 *  - `xdr_malformed`  — it did not decode as a transaction envelope at all;
 *  - `xdr_mismatch`   — it decoded, but is not the payment that was authorized
 *                       (including a fee-bump wrapper, which is a different
 *                       transaction than the one we built);
 *  - `intent_expired` — it decoded and matched, but its validity window has
 *                       lapsed, or the intent behind it has;
 *  - `xdr_unsigned`   — it matched the intent but carries no signature from the
 *                       source account for this network.
 *
 * The first three are the codes the submission paths already raise, so a
 * caller that handles one handles both layers.
 */
export type XdrRejectionCode =
  | "xdr_malformed"
  | "xdr_mismatch"
  | "intent_expired"
  | "xdr_unsigned";

/** Which part of the envelope was refused. */
export type XdrRejectionField =
  | PaymentIntentField
  | "envelope"
  | "timeBounds"
  | "signature";

export interface XdrInspectionRejected {
  ok: false;
  code: XdrRejectionCode;
  /** The part of the envelope that diverged, for callers that branch on it. */
  field: XdrRejectionField;
  /** Operator- and client-safe description. Never contains envelope content. */
  message: string;
}

export interface XdrInspectionAccepted {
  ok: true;
  /** The parsed envelope, for a caller that goes on to submit it. */
  tx: Transaction;
  /** Its hex transaction hash — the on-chain identity of this payment. */
  hash: string;
  /** Source account and sequence, as the envelope declares them. */
  source: string;
  sequence: string;
}

export type XdrInspection = XdrInspectionAccepted | XdrInspectionRejected;

export interface InspectOptions {
  /**
   * Require a signature from the expected source account. On by default: an
   * unsigned envelope is not an authorization, and accepting one is how a
   * "validated" envelope reaches a submission path on nobody's authority.
   *
   * Turn it off only where authorship is established elsewhere — an unsigned
   * intent being read back for display, or a multisig proposal whose shared
   * source account never signs with its own key (`verifyMultisig` checks
   * authorization there instead).
   */
  requireSignature?: boolean;
}

/**
 * Inspect `signedXdr` against `expected` and report the first divergence.
 *
 * @param signedXdr - The base64 transaction envelope as the wallet returned it.
 * @param expected - The server-issued intent, rebuilt from stored state —
 *   never from anything the client sent in the same request.
 * @param options - See {@link InspectOptions}.
 * @returns `{ ok: true, tx, hash, source, sequence }` when the envelope is
 *   exactly the authorized payment, otherwise `{ ok: false, code, field,
 *   message }`.
 */
export function inspectSignedTransaction(
  signedXdr: string,
  expected: PaymentExpectation,
  options: InspectOptions = {}
): XdrInspection {
  const requireSignature = options.requireSignature ?? true;

  let tx: Transaction;
  try {
    tx = parseSignedPaymentXdr(signedXdr, "Signed transaction could not be parsed");
  } catch (error) {
    // `parseSignedPaymentXdr` raises `xdr_malformed` for undecodable input and
    // `xdr_mismatch` for a fee-bump wrapper; both arrive here as an AppError
    // whose code is already the one this result reports.
    return fromAppError(error, "envelope");
  }

  try {
    assertTimeBoundsValid(tx, expected.expiresAt, expected.resource);
  } catch (error) {
    return fromAppError(error, "timeBounds");
  }

  let mismatch;
  try {
    mismatch = matchPaymentIntent(tx, expected);
  } catch (error) {
    // Only reachable when the *expectation* names an asset this deployment
    // does not support, which is a fault in the stored intent rather than in
    // the envelope. Reported rather than thrown so one bad row cannot crash a
    // caller that is inspecting a batch.
    return fromAppError(error, "asset");
  }
  if (mismatch) {
    return {
      ok: false,
      code: "xdr_mismatch",
      field: mismatch.field,
      message: mismatch.message,
    };
  }

  if (requireSignature && !verifySourceSignature(tx, expected.sourcePublicKey)) {
    return {
      ok: false,
      code: "xdr_unsigned",
      field: "signature",
      message:
        "Transaction is not validly signed by its source account for the configured network",
    };
  }

  return {
    ok: true,
    tx,
    hash: tx.hash().toString("hex"),
    source: tx.source,
    sequence: tx.sequence.toString(),
  };
}

/**
 * {@link inspectSignedTransaction} as an assertion, for a route that wants the
 * standard 400 envelope rather than a result to branch on.
 *
 * The thrown error carries the rejection's `field` in its details, so a client
 * can tell "you changed the amount" from "you changed the destination" without
 * parsing the message.
 */
export function assertSignedTransactionMatchesIntent(
  signedXdr: string,
  expected: PaymentExpectation,
  options: InspectOptions = {}
): XdrInspectionAccepted {
  const result = inspectSignedTransaction(signedXdr, expected, options);
  if (!result.ok) {
    throw new AppError(400, result.code.toUpperCase(), result.message, {
      field: result.field,
    });
  }
  return result;
}

/**
 * Re-shape an `AppError` raised by one of the shared primitives into a
 * rejection, preserving its code so both layers speak the same vocabulary.
 *
 * A non-`AppError` would mean a primitive failed for a reason this module has
 * no account of; it is re-thrown rather than flattened into a "mismatch",
 * because reporting an internal fault as a client error is how a real defect
 * gets mistaken for a bad request.
 */
function fromAppError(error: unknown, field: XdrRejectionField): XdrInspectionRejected {
  if (!(error instanceof AppError)) {
    throw error;
  }
  const code = error.code.toLowerCase();
  return {
    ok: false,
    code: isRejectionCode(code) ? code : "xdr_mismatch",
    field,
    message: error.message,
  };
}

function isRejectionCode(code: string): code is XdrRejectionCode {
  return (
    code === "xdr_malformed" ||
    code === "xdr_mismatch" ||
    code === "intent_expired" ||
    code === "xdr_unsigned"
  );
}
