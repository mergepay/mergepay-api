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
  Horizon,
  Keypair,
  Memo,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { config } from "../config";
import { Errors } from "../errors";
import { validateAssetSpec, assetConfigToSpec } from "./assets";
import { withTimeout, TimeoutError, TransportError } from "./timeout";

let _server: Horizon.Server | null = null;
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
      .setTimeout(300)
      .build();
    return tx.toXDR();
  },

  /**
   * Validate a signed payment XDR matches an expected intent, then submit it.
   * Throws AppError on mismatch or Horizon failure. Returns the tx hash.
   */
  async submitPayment(
    signedXdr: string,
    expected: {
      sourcePublicKey: string;
      destination: string;
      asset: AssetSpec;
      amount: string;
      memoCode: string;
    }
  ): Promise<string> {
    const { tx } = validateSignedXdr(signedXdr, expected);
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
};

/**
 * Strict validation that a transaction is exactly the payment we authorized.
 * This is the guardrail that stops a wallet returning a different transaction.
 */
export function validatePaymentTx(
  tx: Transaction,
  expected: {
    sourcePublicKey: string;
    destination: string;
    asset: AssetSpec;
    amount: string;
    memoCode: string;
  }
): void {
  if (tx.source !== expected.sourcePublicKey) {
    throw Errors.badRequest("xdr_mismatch", "Transaction source does not match");
  }
  const expectedFee = String(Number(BASE_FEE) * 2);
  if (String(tx.fee) !== expectedFee) {
    throw Errors.badRequest("xdr_mismatch", "Transaction fee does not match");
  }
  if (tx.operations.length !== 1) {
    throw Errors.badRequest("xdr_mismatch", "Expected exactly one operation");
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
    throw Errors.badRequest("xdr_mismatch", "Payment asset does not match");
  }
  if (normalizeAmount(op.amount) !== normalizeAmount(expected.amount)) {
    throw Errors.badRequest("xdr_mismatch", "Payment amount does not match");
  }
  const wantMemo = memoText(expected.memoCode);
  const gotMemo =
    tx.memo && (tx.memo as any).value
      ? (tx.memo as any).value.toString()
      : "";
  if (gotMemo !== wantMemo) {
    throw Errors.badRequest("xdr_mismatch", "Memo does not match the expense reference");
  }

  // Verify at least one signature matches the expected source account.
  // This implicitly validates the network passphrase, as the signature hash includes it.
  const sourceKeypair = Keypair.fromPublicKey(expected.sourcePublicKey);
  const txHash = tx.hash();
  const hasValidSignature = tx.signatures.some((sig) =>
    sourceKeypair.verify(txHash, sig.signature())
  );
  if (!hasValidSignature) {
    throw Errors.badRequest("xdr_mismatch", "Transaction signature is invalid or for the wrong network");
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
 * persisting them, so Horizon is never called for transactions that fail
 * structural validation.
 */
export interface SignedXdrValidation {
  tx: Transaction;
  hash: string;
}

export function validateSignedXdr(
  signedXdr: string,
  expected: {
    sourcePublicKey: string;
    destination: string;
    asset: AssetSpec;
    amount: string;
    memoCode: string;
  }
): SignedXdrValidation {
  let tx: Transaction;
  try {
    tx = new Transaction(signedXdr, config.networkPassphrase);
  } catch {
    throw Errors.badRequest("xdr_mismatch", "Malformed or unsupported signed XDR");
  }
  validatePaymentTx(tx, expected);
  return { tx, hash: tx.hash().toString("hex") };
}
