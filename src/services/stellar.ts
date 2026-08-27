/**
 * Stellar service — all Horizon I/O and transaction construction lives here so
 * tests can mock a single module. Mergepay only ever builds UNSIGNED envelopes;
 * the user's wallet signs, then we submit the signed XDR.
 *
 * Every external Horizon call has a bounded timeout. Timeout and transport
 * errors are classified so callers (API routes, worker) can distinguish them
 * from business-logic errors.
 */

import {
  Account,
  Asset,
  BASE_FEE,
  FeeBumpTransaction,
  Horizon,
  Keypair,
  Memo,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import pino from "pino";
import { config } from "../config";
import { Errors } from "../errors";
import { validateAssetSpec, assetConfigToSpec } from "./assets";
import { withTimeout, TimeoutError, TransportError } from "./timeout";
import {
  INTENT_VALIDITY_SECONDS,
  assertTimeBoundsMatchIntent,
  readTimeBounds,
} from "../lib/time-bounds";

let _server: Horizon.Server | null = null;
const log = pino({ name: "stellar" });
function server(): Horizon.Server {
  if (!_server) _server = new Horizon.Server(config.HORIZON_URL);
  return _server;
}

function logUpstreamError(e: unknown, codes: unknown): void {
  console.error("[stellar] Upstream error:", e instanceof Error ? e.message : String(e), codes ? JSON.stringify(codes) : "");
}

export interface AssetSpec {
  code: string;
  issuer?: string | null;
}

export function toAsset(spec: AssetSpec): Asset {
  // Validate the asset is supported before constructing the SDK object.
  const config = validateAssetSpec(spec);
  if (config.type === "native") return Asset.native();
  return new Asset(config.code, config.issuer!);
}

export function memoText(code: string): string {
  // Keep within Stellar's 28-byte text memo limit.
  const text = `MP:${code}`;
  return text.length > 28 ? text.slice(0, 28) : text;
}

export interface AccountSnapshot {
  exists: boolean;
  sequence: string;
  balances: { assetCode: string; assetIssuer: string | null; balance: string }[];
  signers: { key: string; weight: number }[];
  thresholds: { low: number; med: number; high: number };
}

/**
 * A server-issued payment intent. `PaymentExpectation` (below) is the same
 * shape plus the optional expiry and resource name used when validating a
 * signed envelope against it.
 */
export type PaymentIntent = Pick<
  PaymentExpectation,
  "sourcePublicKey" | "destination" | "asset" | "amount" | "memoCode"
>;

export interface MultisigRequirement {
  /** Public keys of the accounts authorized to sign for this treasury. */
  signers: string[];
  /** Minimum number of distinct authorized signers required. */
  threshold: number;
}

export const stellar = {
  /** Load an account. Returns exists=false for unfunded accounts (404). */
  async loadAccount(publicKey: string): Promise<AccountSnapshot> {
    try {
      const acct = await withTimeout(
        "Horizon.loadAccount",
        config.HORIZON_ACCOUNT_TIMEOUT_MS,
        async (signal) => {
          // Horizon.Server.loadAccount doesn't accept AbortSignal directly,
          // but we wrap it so timeout still fires and rejects the promise.
          return server().loadAccount(publicKey);
        }
      );
      return {
        exists: true,
        sequence: acct.sequenceNumber(),
        balances: acct.balances.map((b: any) => ({
          assetCode: b.asset_type === "native" ? "XLM" : b.asset_code,
          assetIssuer: b.asset_type === "native" ? null : b.asset_issuer ?? null,
          balance: b.balance,
        })),
        signers: acct.signers.map((s: any) => ({ key: s.key, weight: s.weight })),
        thresholds: {
          low: acct.thresholds.low_threshold,
          med: acct.thresholds.med_threshold,
          high: acct.thresholds.high_threshold,
        },
      };
    } catch (e: any) {
      if (e?.response?.status === 404 || e?.name === "NotFoundError") {
        return {
          exists: false,
          sequence: "0",
          balances: [],
          signers: [],
          thresholds: { low: 0, med: 0, high: 0 },
        };
      }
      throw e;
    }
  },

  /**
   * Build an unsigned single-payment transaction.
   * Caller provides the source account's current sequence (loaded separately).
   */
  buildPayment(params: {
    sourcePublicKey: string;
    sourceSequence: string;
    destination: string;
    asset: AssetSpec;
    amount: string;
    memoCode: string;
    /**
     * Seconds the built envelope stays valid. Defaults to the shared intent
     * window so the transaction's own `maxTime` and the intent expiry the
     * caller records describe the same deadline. Callers pass the value they
     * persisted, never a client-supplied one.
     */
    validitySeconds?: number;
  }): string {
    const source = new Account(params.sourcePublicKey, params.sourceSequence);
    const tx = new TransactionBuilder(source, {
      fee: String(Number(BASE_FEE) * 2),
      networkPassphrase: config.networkPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination: params.destination,
          asset: toAsset(params.asset),
          amount: params.amount,
        })
      )
      .addMemo(Memo.text(memoText(params.memoCode)))
      // An unbounded envelope could be submitted indefinitely, so the timeout
      // is what puts the intent's deadline on-chain: past it, Horizon itself
      // rejects the transaction as tx_too_late.
      .setTimeout(params.validitySeconds ?? INTENT_VALIDITY_SECONDS)
      .build();
    return tx.toXDR();
  },

  /**
   * Validate a signed payment XDR matches an expected intent, then submit it.
   * Throws AppError on mismatch or Horizon failure. Returns the tx hash.
   */
  async submitPayment(signedXdr: string, expected: PaymentExpectation): Promise<string> {
    const tx = parseSignedPaymentXdr(signedXdr, "Malformed transaction envelope");
    validatePaymentTx(tx, expected);
    return submitToHorizon(tx);
  },

  /**
   * Same as `submitPayment`, but additionally requires the envelope to carry
   * signatures from at least `threshold` distinct accounts in
   * `multisig.signers`. Every signature on the envelope must be attributable
   * to a configured signer — an envelope carrying any signature outside that
   * set is rejected outright rather than having the extra signature ignored.
   * All checks happen before any Horizon submission is attempted.
   */
  async submitMultisigPayment(
    signedXdr: string,
    expected: {
      sourcePublicKey: string;
      destination: string;
      asset: AssetSpec;
      amount: string;
      memoCode: string;
      /**
       * The intent's recorded expiry. When present, the envelope's own time
       * bounds are validated against it and an expired intent is rejected
       * *before* anything is sent to Horizon.
       */
      expiresAt?: Date | null;
      /** Names the resource in the expiration error, e.g. "settlement". */
      resource?: string;
    },
    requirement: MultisigRequirement
  ): Promise<string> {
    const { tx } = validateSignedXdr(signedXdr, {
      ...expected,
      skipSourceSignatureCheck: true,
    });
    verifyMultisig(tx, requirement);
    try {
      const res = await withTimeout(
        "Horizon.submitTransaction",
        config.HORIZON_SUBMIT_TIMEOUT_MS,
        async (signal) => {
          // Horizon.Server.submitTransaction doesn't accept AbortSignal directly,
          // but we wrap it so timeout still fires and rejects the promise.
          return server().submitTransaction(tx);
        }
      );
      return res.hash;
    } catch (e: any) {
      // Re-throw TimeoutError and TransportError as-is for retry classification
      if (e instanceof TimeoutError || e instanceof TransportError) {
        throw e;
      }
      const codes =
        e?.response?.data?.extras?.result_codes ??
        e?.response?.data?.result_codes;
      logUpstreamError(e, codes);
      throw Errors.upstream("Stellar rejected the transaction");
    }
  },

  /**
   * Submit a fully-signed envelope without a content-level matching check.
   * Used by the multisig proposal flow, which has already verified each
   * signer against the proposal's stored transaction hash.
   */
  async submitSigned(signedXdr: string): Promise<string> {
    const tx = new Transaction(signedXdr, config.networkPassphrase);
    try {
      return submitWithRetry(tx);
    } catch (e: any) {
      const codes =
        e?.response?.data?.extras?.result_codes ??
        e?.response?.data?.result_codes;
      const detail = codes ? JSON.stringify(codes) : e?.message ?? "submit failed";
      throw Errors.upstream(`Stellar rejected the transaction: ${detail}`);
    }
  },

  /** Look up a transaction by hash. Returns null if not yet visible. */
  async getTransaction(
    hash: string
  ): Promise<{ successful: boolean } | null> {
    try {
      const tx = await withTimeout(
        "Horizon.getTransaction",
        config.HORIZON_STATUS_TIMEOUT_MS,
        async (signal) => {
          return server().transactions().transaction(hash).call();
        }
      );
      return { successful: (tx as any).successful };
    } catch (e: any) {
      if (e?.response?.status === 404) return null;
      throw e;
    }
  },

  /**
   * Compute the hash a signed XDR will submit under, without submitting it.
   * Used to check Horizon for an already-applied transaction when a prior
   * submission attempt's response was lost (network timeout, worker crash)
   * — the hash is deterministic from the envelope, so it's known before we
   * ever call Horizon again.
   */
  hashOf(signedXdr: string): string {
    return new Transaction(signedXdr, config.networkPassphrase).hash().toString("hex");
  },
};

/**
 * Parse an envelope against **our** network passphrase, rejecting malformed
 * input and fee-bump wrappers as client errors.
 *
 * A fee-bump envelope wraps someone else's transaction and pays for it with a
 * different source account. Nothing in this API builds one, so accepting one
 * would mean submitting a transaction whose outer envelope we never authored.
 */
export function parseSignedPaymentXdr(
  signedXdr: string,
  malformedMessage = "Signed transaction could not be parsed"
): Transaction {
  let parsed: Transaction | FeeBumpTransaction;
  try {
    parsed = TransactionBuilder.fromXDR(signedXdr, config.networkPassphrase);
  } catch {
    throw Errors.badRequest("xdr_malformed", malformedMessage);
  }

  if (parsed instanceof FeeBumpTransaction) {
    throw Errors.badRequest(
      "xdr_mismatch",
      "Fee-bump transaction envelopes are not accepted"
    );
  }

  return parsed;
}

export interface HorizonRetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  random?: () => number;
  delay?: (ms: number) => Promise<void>;
}

function isTransientSubmissionError(error: any): boolean {
  const status = error?.response?.status ?? error?.statusCode;
  if (typeof status === "number") return status === 429 || status >= 500;
  const message = String(error?.message ?? error).toLowerCase();
  return /timeout|timed out|socket|econnreset|econnrefused|enotfound|network/.test(message);
}

/** Submit with bounded full-jitter retries for transport/service failures only. */
export async function submitWithRetry(
  tx: Transaction,
  options: HorizonRetryOptions = {}
): Promise<string> {
  const maxRetries = options.maxRetries ?? Number(process.env.HORIZON_SUBMIT_MAX_RETRIES ?? 3);
  const baseDelayMs = options.baseDelayMs ?? Number(process.env.HORIZON_SUBMIT_RETRY_BASE_MS ?? 1_000);
  const random = options.random ?? Math.random;
  const delay = options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await server().submitTransaction(tx);
      return res.hash;
    } catch (error: any) {
      if (!isTransientSubmissionError(error) || attempt >= maxRetries) {
        const codes = error?.response?.data?.extras?.result_codes ?? error?.response?.data?.result_codes;
        const detail = codes ? JSON.stringify(codes) : error?.message ?? "submit failed";
        throw Errors.upstream(`Stellar rejected the transaction: ${detail}`);
      }
      const delayMs = Math.max(0, Math.round(baseDelayMs * 2 ** attempt * random()));
      log.warn(
        { attempt: attempt + 1, delayMs, errorCode: error?.response?.status ?? error?.code ?? "transport" },
        "transient submission failure; retrying"
      );
      await delay(delayMs);
    }
  }
}

async function submitToHorizon(tx: Transaction): Promise<string> {
  return submitWithRetry(tx);
}

/**
 * Verify the envelope carries valid signatures from at least `threshold`
 * distinct accounts in `signers`, and no signature from outside that set.
 * Independent of Horizon — this is enforced before any network submission.
 */
export function verifyMultisig(tx: Transaction, requirement: MultisigRequirement): void {
  if (requirement.signers.length === 0) {
    throw Errors.badRequest(
      "treasury_misconfigured",
      "No signers are configured for this treasury account"
    );
  }
  if (tx.signatures.length === 0) {
    throw Errors.unauthorized("Transaction has no signatures");
  }

  const txHash = tx.hash();
  const matchedSigners = new Set<string>();

  for (const decorated of tx.signatures) {
    const signature = decorated.signature();
    const matched = requirement.signers.find((signer) => {
      try {
        return Keypair.fromPublicKey(signer).verify(txHash, signature);
      } catch {
        return false;
      }
    });
    if (!matched) {
      throw Errors.unauthorized(
        "Transaction contains a signature from an unauthorized signer"
      );
    }
    matchedSigners.add(matched);
  }

  if (matchedSigners.size < requirement.threshold) {
    throw Errors.unauthorized(
      `At least ${requirement.threshold} authorized signer(s) must sign this transaction`
    );
  }
}

/**
 * Parse, authenticate, and intent-check a signed payment XDR before it's
 * ever handed to Horizon. This is the single choke point every settlement
 * and treasury confirmation submission goes through:
 *
 *  1. malformed XDRs fail to parse and are rejected outright
 *  2. expired time bounds are rejected without a network round-trip
 *  3. the transaction must carry a signature that verifies against its own
 *     source account for *our* configured network passphrase — this is what
 *     catches unsigned transactions and transactions signed for the wrong
 *     network (a signature made against a different passphrase produces a
 *     different hash and will not verify here)
 *  4. the transaction's source/destination/asset/amount/memo/operation shape
 *     must match the server-issued payment intent (see validatePaymentTx)
 *
 * Never touches private key material — only verifies signatures already
 * present on the envelope.
 */
export function verifySignedPaymentXdr(
  signedXdr: string,
  expected: PaymentExpectation
): Transaction {
  const tx = parseSignedPaymentXdr(signedXdr);

  assertTimeBoundsValid(tx, expected.expiresAt, expected.resource);

  if (!hasValidSourceSignature(tx)) {
    throw Errors.badRequest(
      "xdr_unsigned",
      "Transaction is not validly signed by its source account for the configured network"
    );
  }

  assertMatchesIntent(tx, expected);
  return tx;
}

/**
 * True only if at least one signature on the envelope verifies against the
 * transaction's own source account, hashed with our configured network
 * passphrase. An empty signature list (unsigned) or a signature produced
 * against a different network passphrase both fail this check.
 */
function hasValidSourceSignature(tx: Transaction): boolean {
  if (!tx.signatures || tx.signatures.length === 0) return false;
  let sourceKeypair: Keypair;
  try {
    sourceKeypair = Keypair.fromPublicKey(tx.source);
  } catch {
    return false;
  }
  const hash = tx.hash();
  return tx.signatures.some((sig) => {
    try {
      return sourceKeypair.verify(hash, sig.signature());
    } catch {
      return false;
    }
  });
}

/**
 * What a signed envelope must match to be the payment this API authorized.
 * Every field a wallet could alter between XDR creation and submission is
 * named here; anything absent from an intent is not checked, so callers pass
 * the whole intent, never a subset.
 */
export interface PaymentExpectation {
  sourcePublicKey: string;
  destination: string;
  asset: AssetSpec;
  amount: string;
  memoCode: string;
  /** Recorded intent expiry; when present, the envelope's bounds must agree. */
  expiresAt?: Date | null;
  /** Names the resource in the expiration error, e.g. "settlement". */
  resource?: string;
  /**
   * Skip the "source account itself signed" check. Set this for multisig
   * accounts, where the source is a shared account that never signs with
   * its own key — `verifyMultisig` checks authorization instead, against
   * the account's actual configured co-signers and threshold.
   */
  skipSourceSignatureCheck?: boolean;
}

/**
 * Lower bound for an acceptable fee: the network's own minimum per operation.
 * Below it the transaction cannot be included at all.
 */
const MIN_FEE_STROOPS_PER_OP = Number(BASE_FEE);

/**
 * Upper bound: the fee this API builds into its envelopes. A wallet may return
 * a *cheaper* transaction, but never a more expensive one — an inflated fee is
 * money leaving the user's account beyond what they agreed to.
 */
const MAX_FEE_STROOPS_PER_OP = Number(BASE_FEE) * 2;

/**
 * Validate a transaction's own validity window.
 *
 * Three distinct failures, each with its own meaning: an envelope with no
 * expiry (submittable forever), one valid longer than the intent it was built
 * for, and one that has already lapsed. An intent-less call still rejects the
 * first and the third.
 */
export function assertTimeBoundsValid(
  tx: Transaction,
  expiresAt?: Date | null,
  resource = "transaction"
): void {
  assertTimeBoundsMatchIntent(
    readTimeBounds(
      tx as unknown as {
        timeBounds?: { minTime: number | string; maxTime: number | string } | null;
      }
    ),
    expiresAt ?? null,
    resource
  );
}

/**
 * Structural check that a transaction is exactly the payment we authorized.
 *
 * Ordered deliberately: shape before content, so an envelope carrying extra
 * operations is reported as such rather than as an incidental fee or asset
 * mismatch further down.
 */
function assertMatchesIntent(tx: Transaction, expected: PaymentExpectation): void {
  if (tx.source !== expected.sourcePublicKey) {
    throw Errors.badRequest("xdr_mismatch", "Transaction source does not match");
  }

  if (tx.operations.length !== 1) {
    throw Errors.badRequest("xdr_mismatch", "Expected exactly one operation");
  }

  const fee = Number(tx.fee);
  if (
    !Number.isFinite(fee) ||
    fee < MIN_FEE_STROOPS_PER_OP * tx.operations.length ||
    fee > MAX_FEE_STROOPS_PER_OP * tx.operations.length
  ) {
    throw Errors.badRequest(
      "xdr_mismatch",
      "Transaction fee is outside the accepted range"
    );
  }

  const op = tx.operations[0] as any;
  if (op.type !== "payment") {
    throw Errors.badRequest("xdr_mismatch", "Expected a payment operation");
  }
  if (op.source && op.source !== expected.sourcePublicKey) {
    throw Errors.badRequest("xdr_mismatch", "Payment operation source does not match");
  }
  if (op.destination !== expected.destination) {
    throw Errors.badRequest("xdr_mismatch", "Payment destination does not match");
  }

  const wantAsset = toAsset(expected.asset);
  const gotAsset: Asset = op.asset;
  if (!gotAsset.equals(wantAsset)) {
    // An issuer swap keeps the familiar code and changes what the recipient
    // actually receives, so it is called out separately from a code mismatch.
    if (gotAsset.getCode() === wantAsset.getCode()) {
      throw Errors.badRequest("xdr_mismatch", "Payment asset issuer mismatch");
    }
    throw Errors.badRequest("xdr_mismatch", "Payment asset does not match");
  }

  if (normalizeAmount(op.amount) !== normalizeAmount(expected.amount)) {
    throw Errors.badRequest("xdr_mismatch", "Payment amount does not match");
  }

  const wantMemo = memoText(expected.memoCode);
  const gotMemo =
    tx.memo && (tx.memo as any).value ? (tx.memo as any).value.toString() : "";
  if (gotMemo !== wantMemo) {
    throw Errors.badRequest("xdr_mismatch", "Memo does not match the expense reference");
  }
}

/**
 * Parse an envelope and check it against an intent, without requiring a
 * signature. Used where the envelope's authorship is established elsewhere
 * (an unsigned intent readback, a multisig proposal), and as the shared core
 * of the signed paths below.
 */
export function validateSignedPaymentXdr(
  signedXdr: string,
  expected: PaymentExpectation
): Transaction {
  const tx = parseSignedPaymentXdr(signedXdr);
  assertTimeBoundsValid(tx, expected.expiresAt, expected.resource);
  assertMatchesIntent(tx, expected);
  return tx;
}

/**
 * Strict validation that a *signed* transaction is exactly the payment we
 * authorized. This is the guardrail that stops a wallet returning a different
 * transaction than the one it was handed.
 */
export function validatePaymentTx(tx: Transaction, expected: PaymentExpectation): void {
  // Checked first: a stale envelope should be reported as expired, not as some
  // incidental mismatch further down, and an expired intent must never reach
  // Horizon or an anchor.
  assertTimeBoundsValid(tx, expected.expiresAt, expected.resource);
  assertMatchesIntent(tx, expected);

  // A signature is computed over bytes that include the network passphrase, so
  // verifying it against the expected source account also proves the envelope
  // was signed for *our* network. An unsigned envelope fails here too.
  // Skipped for multisig accounts, whose own key never signs — verifyMultisig
  // checks authorization there instead.
  if (!expected.skipSourceSignatureCheck) {
    const sourceKeypair = Keypair.fromPublicKey(expected.sourcePublicKey);
    const txHash = tx.hash();
    const hasValidSignature = tx.signatures.some((sig) => {
      try {
        return sourceKeypair.verify(txHash, sig.signature());
      } catch {
        return false;
      }
    });
    if (!hasValidSignature) {
      throw Errors.badRequest(
        "xdr_mismatch",
        "Transaction signature is invalid or for the wrong network"
      );
    }
  }
}

function normalizeAmount(a: string): string {
  // Compare at 7dp precision regardless of trailing zeros.
  const [w, f = ""] = a.split(".");
  return `${w}.${(f + "0000000").slice(0, 7)}`;
}

/**
 * Parse and validate a signed XDR against the expected payment intent
 * without submitting it to Horizon. Returns the parsed transaction and its
 * hash on success. Throws AppError (400 XDR_MISMATCH) on any mismatch.
 *
 * Callers use this in API routes to reject invalid signed XDRs *before*
 * persisting them, so Horizon is never called for a transaction that fails
 * validation and no settlement is advanced on the strength of one.
 */
export interface SignedXdrValidation {
  tx: Transaction;
  hash: string;
}

export function validateSignedXdr(
  signedXdr: string,
  expected: PaymentExpectation
): SignedXdrValidation {
  const tx = parseSignedPaymentXdr(signedXdr, "Malformed or unsupported signed XDR");
  validatePaymentTx(tx, expected);
  return { tx, hash: tx.hash().toString("hex") };
}
