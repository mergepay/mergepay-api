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
 */
import { AppError, Errors } from "../errors";
import {
  stellar,
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
