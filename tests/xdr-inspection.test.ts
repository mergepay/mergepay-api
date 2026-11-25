/**
 * Tests for `src/services/xdr-inspection.ts`.
 *
 * The module exists so a caller can ask "is this envelope the payment we
 * authorized?" and get a field-by-field answer instead of a thrown error. It
 * owns no rules of its own — it composes `parseSignedPaymentXdr`,
 * `assertTimeBoundsValid`, `matchPaymentIntent` and `verifySourceSignature`
 * from `src/services/stellar.ts` — so these tests are about the composition:
 *
 *  - which of the four rejection codes each failure produces;
 *  - which `field` a caller can branch on;
 *  - the ordering promise (shape before content before signature);
 *  - the accepted shape, including the hash a submitter needs; and
 *  - that a rejection never echoes envelope content back.
 *
 * No Horizon, no database, no network: every envelope is built and signed
 * locally with random keypairs.
 */
import { describe, it, expect } from "vitest";
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Memo,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

import { config } from "../src/config";
import { AppError } from "../src/lib/errors";
import { stellar, type PaymentExpectation } from "../src/services/stellar";
import {
  assertSignedTransactionMatchesIntent,
  inspectSignedTransaction,
  type XdrInspectionRejected,
} from "../src/services/xdr-inspection";

const source = Keypair.random();
const destination = Keypair.random();

/** The intent as the server would have recorded it before the wallet signed. */
const intent: PaymentExpectation = {
  sourcePublicKey: source.publicKey(),
  destination: destination.publicKey(),
  asset: { code: "XLM", issuer: null },
  amount: "12.5000000",
  memoCode: "ABC123",
  resource: "settlement",
};

/**
 * Build the unsigned envelope a wallet would hand back, with enough knobs to
 * reproduce each divergence the intent checks look for.
 */
function buildXdr(
  overrides: {
    sourcePublicKey?: string;
    destination?: string;
    asset?: { code: string; issuer?: string | null };
    amount?: string;
    memoCode?: string;
  } = {}
): string {
  return stellar.buildPayment({
    sourcePublicKey: overrides.sourcePublicKey ?? intent.sourcePublicKey,
    sourceSequence: "12345",
    destination: overrides.destination ?? intent.destination,
    asset: overrides.asset ?? intent.asset,
    amount: overrides.amount ?? intent.amount,
    memoCode: overrides.memoCode ?? intent.memoCode,
  });
}

/** Parse an unsigned envelope and sign it with `signer`. */
function sign(xdr: string, signer: Keypair): string {
  const tx = new Transaction(xdr, config.networkPassphrase);
  tx.sign(signer);
  return tx.toXDR();
}

/** A signed envelope that matches `intent` exactly. */
function validSignedXdr(): string {
  return sign(buildXdr(), source);
}

/** Narrow a result to its rejection arm, failing loudly if it was accepted. */
function expectRejected(
  result: ReturnType<typeof inspectSignedTransaction>
): XdrInspectionRejected {
  if (result.ok) {
    throw new Error("expected the envelope to be rejected, but it was accepted");
  }
  return result;
}

describe("inspectSignedTransaction — accepted envelopes", () => {
  it("accepts a signed envelope that matches the intent exactly", () => {
    const signedXdr = validSignedXdr();
    const result = inspectSignedTransaction(signedXdr, intent);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The caller that inspects an envelope usually goes on to submit it, so it
    // needs the parsed transaction and the on-chain identity, not just a boolean.
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.hash).toBe(new Transaction(signedXdr, config.networkPassphrase).hash().toString("hex"));
    expect(result.source).toBe(intent.sourcePublicKey);
    expect(result.sequence).toBe("12346");
    expect(result.tx).toBeInstanceOf(Transaction);
  });

  it("treats an equivalent amount written with trailing zeros as a match", () => {
    // The old copy in `src/utils/stellar-xdr.ts` compared amounts as raw
    // strings, so "12.5" never matched "12.5000000".
    const result = inspectSignedTransaction(sign(buildXdr({ amount: "12.5" }), source), intent);
    expect(result.ok).toBe(true);
  });

  it("accepts an unsigned envelope when the caller opts out of the signature requirement", () => {
    // For reading back an intent for display, authorship is established
    // elsewhere; the envelope is not an authorization yet.
    const result = inspectSignedTransaction(buildXdr(), intent, { requireSignature: false });
    expect(result.ok).toBe(true);
  });
});

describe("inspectSignedTransaction — xdr_malformed", () => {
  it("rejects input that does not decode, reporting the envelope as the field", () => {
    const result = expectRejected(inspectSignedTransaction("not-xdr", intent));

    expect(result.code).toBe("xdr_malformed");
    expect(result.field).toBe("envelope");
  });
});

describe("inspectSignedTransaction — signature", () => {
  it("rejects an unsigned envelope when a signature is required", () => {
    const result = expectRejected(inspectSignedTransaction(buildXdr(), intent));

    expect(result.code).toBe("xdr_unsigned");
    expect(result.field).toBe("signature");
  });

  it("rejects an envelope signed by an account other than the expected source", () => {
    // A compromised wallet can return a perfectly valid signature — just not
    // from the account whose funds we meant to spend.
    const result = expectRejected(inspectSignedTransaction(sign(buildXdr(), Keypair.random()), intent));

    expect(result.code).toBe("xdr_unsigned");
    expect(result.field).toBe("signature");
  });
});

describe("inspectSignedTransaction — xdr_mismatch", () => {
  it("rejects a payment to a different destination", () => {
    const other = Keypair.random().publicKey();
    const result = expectRejected(inspectSignedTransaction(sign(buildXdr({ destination: other }), source), intent));

    expect(result.code).toBe("xdr_mismatch");
    expect(result.field).toBe("destination");
  });

  it("rejects a different amount", () => {
    const result = expectRejected(inspectSignedTransaction(sign(buildXdr({ amount: "99" }), source), intent));

    expect(result.code).toBe("xdr_mismatch");
    expect(result.field).toBe("amount");
  });

  it("rejects a different asset code", () => {
    // USDC with the configured issuer is a supported asset, so this envelope
    // builds; what diverges is the code against an XLM intent.
    const result = expectRejected(
      inspectSignedTransaction(
        sign(buildXdr({ asset: { code: "USDC", issuer: config.STABLE_ASSET_ISSUER } }), source),
        intent
      )
    );

    expect(result.code).toBe("xdr_mismatch");
    expect(result.field).toBe("asset");
  });

  it("rejects the same asset code from a different issuer", () => {
    // An issuer swap keeps the familiar code and changes what the recipient
    // actually receives, so it is reported under its own field. The envelope is
    // built by hand: `buildPayment` validates the issuer, and the point here is
    // to inspect an envelope carrying an unsupported one.
    const usdcIntent: PaymentExpectation = {
      ...intent,
      asset: { code: "USDC", issuer: config.STABLE_ASSET_ISSUER },
    };
    const impostor = Keypair.random().publicKey();

    const txb = new TransactionBuilder(new Account(intent.sourcePublicKey, "12345"), {
      fee: String(BASE_FEE),
      networkPassphrase: config.networkPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination: intent.destination,
          asset: new Asset("USDC", impostor),
          amount: intent.amount,
        })
      )
      .addMemo(Memo.text(`MP:${intent.memoCode}`))
      .setTimeout(300)
      .build();

    txb.sign(source);
    const result = expectRejected(inspectSignedTransaction(txb.toXDR(), usdcIntent));

    expect(result.code).toBe("xdr_mismatch");
    expect(result.field).toBe("assetIssuer");
  });

  it("rejects a different memo", () => {
    const result = expectRejected(inspectSignedTransaction(sign(buildXdr({ memoCode: "DIFFERENT" }), source), intent));

    expect(result.code).toBe("xdr_mismatch");
    expect(result.field).toBe("memo");
  });

  it("rejects a envelope built on a different source account", () => {
    const other = Keypair.random();
    const stolenIntent: PaymentExpectation = { ...intent, sourcePublicKey: other.publicKey() };
    const result = expectRejected(inspectSignedTransaction(sign(buildXdr(), source), stolenIntent));

    expect(result.code).toBe("xdr_mismatch");
    expect(result.field).toBe("source");
  });

  it("rejects extra operations", () => {
    const txb = new TransactionBuilder(new Account(intent.sourcePublicKey, "12345"), {
      fee: String(BASE_FEE),
      networkPassphrase: config.networkPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination: intent.destination,
          asset: Asset.native(),
          amount: intent.amount,
        })
      )
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: "1",
        })
      )
      .addMemo(Memo.text(`MP:${intent.memoCode}`))
      .setTimeout(300)
      .build();

    txb.sign(source);
    const result = expectRejected(inspectSignedTransaction(txb.toXDR(), intent));

    expect(result.code).toBe("xdr_mismatch");
    expect(result.field).toBe("operationCount");
  });

  it("rejects a fee outside the accepted band", () => {
    const txb = new TransactionBuilder(new Account(intent.sourcePublicKey, "12345"), {
      fee: "999999",
      networkPassphrase: config.networkPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination: intent.destination,
          asset: Asset.native(),
          amount: intent.amount,
        })
      )
      .addMemo(Memo.text(`MP:${intent.memoCode}`))
      .setTimeout(300)
      .build();

    txb.sign(source);
    const result = expectRejected(inspectSignedTransaction(txb.toXDR(), intent));

    expect(result.code).toBe("xdr_mismatch");
    expect(result.field).toBe("fee");
  });

  it("rejects a payment operation carrying its own source account", () => {
    const txb = new TransactionBuilder(new Account(intent.sourcePublicKey, "12345"), {
      fee: String(BASE_FEE),
      networkPassphrase: config.networkPassphrase,
    })
      .addOperation(
        Operation.payment({
          source: Keypair.random().publicKey(),
          destination: intent.destination,
          asset: Asset.native(),
          amount: intent.amount,
        })
      )
      .addMemo(Memo.text(`MP:${intent.memoCode}`))
      .setTimeout(300)
      .build();

    txb.sign(source);
    const result = expectRejected(inspectSignedTransaction(txb.toXDR(), intent));

    expect(result.code).toBe("xdr_mismatch");
    expect(result.field).toBe("operationSource");
  });

  it("rejects a non-payment operation", () => {
    const txb = new TransactionBuilder(new Account(intent.sourcePublicKey, "12345"), {
      fee: String(BASE_FEE),
      networkPassphrase: config.networkPassphrase,
    })
      .addOperation(
        Operation.manageData({
          name: "note",
          value: "not a payment",
        })
      )
      .addMemo(Memo.text(`MP:${intent.memoCode}`))
      .setTimeout(300)
      .build();

    txb.sign(source);
    const result = expectRejected(inspectSignedTransaction(txb.toXDR(), intent));

    expect(result.code).toBe("xdr_mismatch");
    expect(result.field).toBe("operationType");
  });

  it("rejects a fee-bump wrapper as a different transaction", () => {
    // A fee-bump wraps someone else's transaction. It is reported as a shape
    // mismatch, never as "must contain exactly one operation".
    const inner = new Transaction(validSignedXdr(), config.networkPassphrase);
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      Keypair.random(),
      String(Number(BASE_FEE) * 10),
      inner,
      config.networkPassphrase
    );
    feeBump.sign(Keypair.random());

    const result = expectRejected(inspectSignedTransaction(feeBump.toXDR(), intent));

    expect(result.code).toBe("xdr_mismatch");
    expect(result.field).toBe("envelope");
  });
});

describe("inspectSignedTransaction — time bounds", () => {
  it("rejects an envelope that declares no expiry", () => {
    const txb = new TransactionBuilder(new Account(intent.sourcePublicKey, "12345"), {
      fee: String(BASE_FEE),
      networkPassphrase: config.networkPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination: intent.destination,
          asset: Asset.native(),
          amount: intent.amount,
        })
      )
      .addMemo(Memo.text(`MP:${intent.memoCode}`))
      .setTimebounds(0, 0)
      .build();

    txb.sign(source);
    const result = expectRejected(inspectSignedTransaction(txb.toXDR(), intent));

    expect(result.code).toBe("xdr_mismatch");
    expect(result.field).toBe("timeBounds");
  });

  it("rejects an envelope whose validity window has already lapsed", () => {
    const txb = new TransactionBuilder(new Account(intent.sourcePublicKey, "12345"), {
      fee: String(BASE_FEE),
      networkPassphrase: config.networkPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination: intent.destination,
          asset: Asset.native(),
          amount: intent.amount,
        })
      )
      .addMemo(Memo.text(`MP:${intent.memoCode}`))
      .setTimebounds(1, Math.floor(Date.now() / 1000) - 600)
      .build();

    txb.sign(source);
    const result = expectRejected(inspectSignedTransaction(txb.toXDR(), intent));

    expect(result.code).toBe("intent_expired");
    expect(result.field).toBe("timeBounds");
  });

  it("rejects an envelope valid longer than the intent it was built for", () => {
    const expiringIntent: PaymentExpectation = {
      ...intent,
      expiresAt: new Date(),
    };
    // buildPayment uses a 300s window; an intent expiring now is far shorter.
    const result = expectRejected(inspectSignedTransaction(validSignedXdr(), expiringIntent));

    expect(result.code).toBe("xdr_mismatch");
    expect(result.field).toBe("timeBounds");
  });
});

describe("inspectSignedTransaction — ordering", () => {
  it("reports a content mismatch before the signature, so a wrong payment is not called unsigned", () => {
    // A wallet returning the wrong payment will have signed it perfectly.
    // Reporting "unsigned" there would send the operator down the wrong path.
    const wrongPayment = sign(buildXdr({ destination: Keypair.random().publicKey() }), Keypair.random());

    const result = expectRejected(inspectSignedTransaction(wrongPayment, intent));

    expect(result.code).toBe("xdr_mismatch");
    expect(result.field).toBe("destination");
  });

  it("reports an undefined envelope before its time bounds", () => {
    const result = expectRejected(inspectSignedTransaction("still-not-xdr", intent));

    expect(result.code).toBe("xdr_malformed");
    expect(result.field).toBe("envelope");
  });
});

describe("inspectSignedTransaction — rejection messages", () => {
  it("never echoes envelope content back in the message", () => {
    // The envelope is untrusted input and the message reaches logs and the
    // client, so it names the diverging field and nothing else.
    const secretDestination = Keypair.random().publicKey();
    const result = expectRejected(inspectSignedTransaction(sign(buildXdr({ destination: secretDestination }), source), intent));

    expect(result.message).not.toContain(secretDestination);
    expect(result.message.toLowerCase()).toContain("destination");
  });
});

describe("assertSignedTransactionMatchesIntent", () => {
  it("returns the parsed envelope when the transaction matches", () => {
    const result = assertSignedTransactionMatchesIntent(validSignedXdr(), intent);

    expect(result.ok).toBe(true);
    expect(result.source).toBe(intent.sourcePublicKey);
  });

  it("throws a 400 carrying the rejection code and the diverging field", () => {
    // The point of the assertion form: a client can branch on `field` without
    // parsing prose, and the status is the standard validation 400.
    let thrown: unknown;
    try {
      assertSignedTransactionMatchesIntent(sign(buildXdr({ amount: "99" }), source), intent);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    const appError = thrown as AppError;
    expect(appError.statusCode).toBe(400);
    expect(appError.code).toBe("XDR_MISMATCH");
    expect(appError.details).toMatchObject({ field: "amount" });
  });

  it("throws with the xdr_unsigned code when no valid signature is present", () => {
    let thrown: unknown;
    try {
      assertSignedTransactionMatchesIntent(buildXdr(), intent);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    const appError = thrown as AppError;
    expect(appError.code).toBe("XDR_UNSIGNED");
    expect(appError.details).toMatchObject({ field: "signature" });
  });
});
