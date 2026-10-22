/**
 * Treasury-facing Horizon reads and XDR hashing, isolated from the HTTP layer.
 *
 * Issue #505: the treasury routes were the last place where Stellar SDK
 * objects were parsed and account snapshots were turned into response payloads
 * inline. `stellar.ts` owns the raw Horizon I/O; this module layers the
 * treasury's domain shape on top so a route handler only ever sees typed,
 * domain objects — and tests mock one service instead of the SDK.
 *
 * Every function here is a pure read over `stellar.loadAccount` or a
 * deterministic transformation of an envelope, so it is safe to call from
 * request handlers and cheap to fake.
 *
 * Issue #666 added the treasury envelope inspection layer
 * (`inspectTreasuryXdr` / `assertTreasuryEnvelopePolicy`). The signature
 * collector accepts an XDR this server never built, so before any signature is
 * stored — and before a merged envelope reaches Horizon — the envelope is
 * decoded and checked against the treasury account it claims to spend from:
 * source account, operation structure, fee band, and time bounds.
 */
import { StrKey, FeeBumpTransaction, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { config } from "../config";
import { AppError, Errors } from "../errors";
import { validateAmount } from "../lib/money";
import {
  stellar,
  assertTimeBoundsValid,
  MAX_FEE_STROOPS_PER_OP,
  MIN_FEE_STROOPS_PER_OP,
  type AccountSnapshot,
  type AssetSpec,
  type PaymentExpectation,
  validateSignedPaymentXdr,
} from "./stellar";
/**
 * The subset of a treasury account the API exposes to members: balances in
 * the order Horizon returned them, the signer list, and signature thresholds.
 */
export interface TreasuryAccountView {
  publicKey: string;
  balances: { assetCode: string; assetIssuer: string | null; balance: string }[];
  signers: { key: string; weight: number }[];
  thresholds: { low: number; med: number; high: number };
}

export interface TreasuryPaymentIntent {
  sourcePublicKey: string;
  sourceSequence: string;
  destination: string;
  asset: AssetSpec;
  amount: string;
  memoCode: string;
  validitySeconds?: number;
}

/**
 * Build the unsigned payment envelope used by a treasury intent.
 *
 * The returned XDR is deliberately unsigned. Wallets own all private keys and
 * sign the envelope on the client before sending it back for validation.
 */
export function buildTreasuryPaymentXdr(intent: TreasuryPaymentIntent): string {
  return stellar.buildPayment(intent);
}

/**
 * Parse and validate a wallet-produced treasury envelope against its intent.
 *
 * Multisig withdrawals set `skipSourceSignatureCheck` because a shared
 * treasury account is authorized by its co-signers rather than its master
 * key. The caller still verifies those co-signers and their threshold before
 * submitting the validated transaction.
 */
export function validateTreasurySignedXdr(
  signedXdr: string,
  intent: PaymentExpectation
): { tx: ReturnType<typeof validateSignedPaymentXdr> } {
  return { tx: validateSignedPaymentXdr(signedXdr, intent) };
}

/**
 * Map a raw `AccountSnapshot` into the treasury view shape the routes return.
 *
 * Kept in the service (not the route) so the HTTP layer never re-shapes
 * Horizon data and every caller gets an identical payload.
 *
 * @param publicKey - The treasury account's Stellar public key.
 * @param snapshot - A snapshot from `stellar.loadAccount`.
 * @returns The domain object routes serialize directly.
 */
export function toTreasuryAccountView(
  publicKey: string,
  snapshot: AccountSnapshot
): TreasuryAccountView {
  return {
    publicKey,
    balances: snapshot.balances.map((b) => ({
      assetCode: b.assetCode,
      assetIssuer: b.assetIssuer,
      balance: b.balance,
    })),
    signers: snapshot.signers,
    thresholds: snapshot.thresholds,
  };
}

/**
 * Load a treasury account and return its `TreasuryAccountView`.
 *
 * @param publicKey - The treasury account's Stellar public key.
 * @returns The account view (always `exists: true`-shaped data; unfunded
 *   accounts are surfaced through the empty defaults `stellar.loadAccount`
 *   already produces).
 * @throws Re-throws Horizon/network errors after retry exhaustion.
 */
export async function getTreasuryAccount(publicKey: string): Promise<TreasuryAccountView> {
  const snapshot = await stellar.loadAccount(publicKey);
  return toTreasuryAccountView(publicKey, snapshot);
}

/**
 * Load the treasury account's raw snapshot.
 *
 * Some consumers (signer-config validation) want the untouched
 * `AccountSnapshot` rather than the response-shaped view. Exposing the raw
 * read keeps the single rule that only service modules touch Horizon.
 *
 * @param publicKey - The treasury account's Stellar public key.
 * @returns The raw `AccountSnapshot` from `stellar.loadAccount`.
 */
export async function getTreasuryAccountSnapshot(
  publicKey: string
): Promise<AccountSnapshot> {
  return stellar.loadAccount(publicKey);
}

/**
 * Load a treasury account and build the multisig requirement its withdrawals
 * must satisfy.
 *
 * @param publicKey - The treasury account's Stellar public key.
 * @param requiredSigners - The group's configured signer threshold.
 * @returns `{ signers, threshold }` for `stellar.submitMultisigPayment`.
 * @throws {AppError} `treasury_unfunded` when the account does not exist —
 *   a withdrawal cannot be authorized against an account Horizon has never
 *   seen.
 */
export async function getTreasuryMultisigRequirement(
  publicKey: string,
  requiredSigners: number
): Promise<{ signers: string[]; threshold: number }> {
  const account = await stellar.loadAccount(publicKey);
  if (!account.exists) {
    throw Errors.badRequest(
      "treasury_unfunded",
      "The treasury account is not funded on-chain"
    );
  }
  return {
    signers: account.signers.map((s) => s.key),
    threshold: requiredSigners,
  };
}

/**
 * Compute the deterministic hash of an unsigned (or signed) envelope.
 *
 * The treasury deposit/withdraw endpoints store this hash as
 * `intendedTxHash`, and the confirm endpoint compares it against the hash of
 * the envelope the wallet signed back — the check that stops a signer from
 * submitting a signature for a transaction the API never issued.
 *
 * Delegating here keeps `Transaction` parsing out of the routes entirely.
 *
 * @param xdr - A base64 transaction envelope.
 * @returns The transaction's hex hash for the configured network passphrase.
 */
export function hashOfEnvelope(xdr: string): string {
  return stellar.hashOf(xdr);
}

/**
 * Validate that a signed envelope is the exact transaction an intent was
 * issued for, without submitting anything.
 *
 * @param signedXdr - The wallet-signed, base64 envelope.
 * @param intendedTxHash - The `intendedTxHash` recorded when the intent was
 *   created.
 * @throws {AppError} `xdr_mismatch` when the envelope hashes to a different
 *   transaction, or `xdr_malformed` when it cannot be parsed at all.
 */
export function assertSignedXdrMatchesIntent(
  signedXdr: string,
  intendedTxHash: string
): void {
  let submittedHash: string;
  try {
    submittedHash = stellar.hashOf(signedXdr);
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw Errors.badRequest("xdr_malformed", "Could not parse signed XDR");
  }
  if (submittedHash !== intendedTxHash) {
    throw Errors.badRequest(
      "xdr_mismatch",
      "Submitted signed XDR does not match the intended transaction"
    );
  }
}

/**
 * Largest operation count a treasury envelope may carry.
 *
 * A multisig treasury spends only what its signers have each reviewed, and
 * every operation adds to the fee the treasury itself pays. An envelope with
 * hundreds of operations is neither reviewable by a human signer nor a
 * transaction this API would ever have built, so the collector bounds it
 * instead of accepting whatever a coordination tool produced.
 */
export const MAX_TREASURY_OPERATIONS = 10;

/** The decoded fields the inspection reads. The SDK types these loosely. */
interface TreasuryOperation {
  type?: string;
  source?: string;
  amount?: string;
  destination?: string;
}

/** Operation types whose `amount` must be a positive, well-formed Stroop amount. */
const POSITIVE_AMOUNT_OPERATIONS = new Set(["payment"]);

/** Operation types whose `destination` names a Stellar account. */
const ACCOUNT_DESTINATION_OPERATIONS = new Set([
  "payment",
  "createAccount",
  "accountMerge",
]);

/**
 * What an externally built treasury envelope must match to be acceptable.
 *
 * Only the treasury account is required; the bounds exist so the collector's
 * own default cannot be quietly widened by a caller that means to.
 */
export interface TreasuryEnvelopePolicy {
  /** The group's configured treasury account — the only legal source. */
  treasuryAccountPublicKey: string;
  /** Upper bound on the operation count. Defaults to {@link MAX_TREASURY_OPERATIONS}. */
  maxOperations?: number;
  /** Absolute fee ceiling in stroops. Defaults to the per-operation maximum scaled by the operation count. */
  maxFeeStroops?: number;
}

/** What an inspected envelope was found to contain. */
export interface TreasuryEnvelopeInspection {
  tx: Transaction;
  /** The envelope's operation types, in order. */
  operationTypes: string[];
  /** The fee the envelope commits the treasury to paying, in stroops. */
  feeStroops: number;
}

/**
 * Reject an envelope that disagrees with treasury policy.
 *
 * `xdr_mismatch` is the code every existing envelope rejection in this API
 * already uses (src/services/stellar.ts), so clients keep branching on the one
 * code they know; `details.rule` says which rule fired, for support and tests,
 * without inventing a second error vocabulary.
 */
function policyRejected(
  rule: string,
  message: string,
  details?: Record<string, unknown>
): never {
  throw Errors.badRequest("xdr_mismatch", message, { rule, ...(details ?? {}) });
}

/**
 * Decode an untrusted treasury envelope for the configured network.
 *
 * Fee-bump wrappers are rejected: a fee-bump envelope is funded by a *different*
 * source account than the transaction it wraps, so accepting one would mean
 * collecting treasury signatures over a transaction whose payer the treasury
 * policy cannot see.
 *
 * @param xdr - The base64 envelope, signed or unsigned.
 * @param malformedMessage - Message used when the envelope cannot be parsed.
 * @returns The parsed `Transaction`.
 * @throws {AppError} `bad_request` (`xdr_malformed`) for unparseable input,
 *   `xdr_mismatch` for a fee-bump envelope.
 */
export function parseTreasuryXdr(
  xdr: string,
  malformedMessage = "Could not parse transaction XDR"
): Transaction {
  let parsed: Transaction | FeeBumpTransaction;
  try {
    parsed = TransactionBuilder.fromXDR(xdr, config.networkPassphrase);
  } catch {
    throw Errors.badRequest("xdr_malformed", malformedMessage);
  }
  if (parsed instanceof FeeBumpTransaction) {
    return policyRejected(
      "fee_bump",
      "Fee-bump transaction envelopes are not accepted"
    );
  }
  return parsed;
}

/**
 * Inspect an already-decoded treasury envelope against treasury policy (issue #666).
 *
 * Ordered cheapest and most decisive first, so the reported failure is the one
 * that matters: the account the envelope spends from, then its operation
 * structure, then the fee it commits that account to paying, then whether the
 * envelope is still submittable at all. Every rule fires before a signature is
 * stored or Horizon is contacted, because a treasury proposal that has already
 * collected signatures cannot be quietly replaced — the signers approved the
 * bytes they signed.
 *
 * @param tx - The parsed envelope.
 * @param policy - The treasury account it must be sourced from, and the bounds it must stay inside.
 * @returns `{ tx, operationTypes, feeStroops }` for the caller to reuse.
 * @throws {AppError} `bad_request` with `details.rule` naming the rule that
 *   rejected the envelope; `intent_expired` when the envelope's own window has
 *   already closed (raised by the shared time-bounds check).
 */
export function assertTreasuryEnvelopePolicy(
  tx: Transaction,
  policy: TreasuryEnvelopePolicy
): TreasuryEnvelopeInspection {
  const treasuryAccountPublicKey = policy.treasuryAccountPublicKey;

  if (tx.source !== treasuryAccountPublicKey) {
    policyRejected(
      "source_account",
      "Transaction source must be the group's treasury account"
    );
  }

  const operations = tx.operations as TreasuryOperation[];
  const maxOperations = policy.maxOperations ?? MAX_TREASURY_OPERATIONS;
  if (operations.length === 0) {
    policyRejected("operations", "Transaction must carry at least one operation");
  }
  if (operations.length > maxOperations) {
    policyRejected(
      "operations",
      `Transaction carries ${operations.length} operations; a treasury proposal may carry at most ${maxOperations}`,
      { operations: operations.length, maxOperations }
    );
  }

  for (const [index, operation] of operations.entries()) {
    // An operation may only be re-sourced to the treasury itself. A foreign
    // per-operation source is how a tampered envelope asks the treasury's
    // signers to authorize a movement that is not the treasury's to approve.
    if (operation.source && operation.source !== treasuryAccountPublicKey) {
      policyRejected(
        "operation_source",
        `Operation ${index} is sourced from an account other than the group's treasury`,
        { index, operationSource: operation.source }
      );
    }

    const type = operation.type ?? "";
    if (POSITIVE_AMOUNT_OPERATIONS.has(type)) {
      const amount = operation.amount ?? "";
      if (!validateAmount(amount).ok) {
        policyRejected(
          "operation_amount",
          `Operation ${index} does not carry a positive payment amount`,
          { index, amount }
        );
      }
    }
    if (ACCOUNT_DESTINATION_OPERATIONS.has(type)) {
      const destination = operation.destination ?? "";
      // A muxed (M...) destination is legal here: unlike SEP-10
      // authentication, a treasury payment may legitimately pay a sub-account.
      if (
        !StrKey.isValidEd25519PublicKey(destination) &&
        !StrKey.isValidMed25519PublicKey(destination)
      ) {
        policyRejected(
          "operation_destination",
          `Operation ${index} does not name a valid destination account`,
          { index, destination }
        );
      }
    }
  }

  // The same band the payment path enforces, scaled by what this envelope
  // actually does: below the network minimum the transaction can never be
  // included; above the ceiling the treasury pays away XLM no signer approved.
  const feeStroops = Number(tx.fee);
  const minFeeStroops = MIN_FEE_STROOPS_PER_OP * operations.length;
  const maxFeeStroops =
    policy.maxFeeStroops ?? MAX_FEE_STROOPS_PER_OP * operations.length;
  if (!Number.isFinite(feeStroops) || feeStroops < minFeeStroops) {
    policyRejected(
      "fee",
      "Transaction fee is below the network minimum for its operations",
      { feeStroops, minFeeStroops }
    );
  }
  if (feeStroops > maxFeeStroops) {
    policyRejected(
      "fee",
      "Transaction fee exceeds what this treasury proposal may pay",
      { feeStroops, maxFeeStroops }
    );
  }

  // An envelope with no expiry, or whose expiry has already passed, must never
  // reach Horizon: it would either sit submittable indefinitely or fail as
  // tx_too_late after the group believed the transaction was settled. No
  // intent expiry is supplied because the envelope carries its own window.
  assertTimeBoundsValid(tx, null, "treasury transaction");

  return {
    tx,
    operationTypes: operations.map((operation) => operation.type ?? "unknown"),
    feeStroops,
  };
}

/**
 * Decode an externally built treasury envelope and inspect it in one step.
 *
 * @param xdr - The base64 envelope, typically unsigned when a proposal is created.
 * @param policy - The treasury account it must be sourced from, and the bounds it must stay inside.
 * @returns The inspection result, including the parsed transaction.
 * @throws {AppError} Whatever {@link parseTreasuryXdr} or
 *   {@link assertTreasuryEnvelopePolicy} raises; see those for the codes.
 */
export function inspectTreasuryXdr(
  xdr: string,
  policy: TreasuryEnvelopePolicy
): TreasuryEnvelopeInspection {
  return assertTreasuryEnvelopePolicy(
    parseTreasuryXdr(xdr),
    policy
  );
}
