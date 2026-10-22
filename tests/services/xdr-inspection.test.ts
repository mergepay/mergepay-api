/**
 * Issue #694 — signed-XDR inspection against a stored settlement intent.
 *
 * Mergepay never holds a private key: it builds an unsigned payment, a wallet
 * signs it, and a later request hands the envelope back. Every field a wallet
 * could change in that gap is checked here, with sample envelopes built by the
 * same `stellar.buildPayment` the API serves to clients, so a fixture cannot
 * drift from what a real wallet is asked to sign.
 *
 * The suite asserts three things the module exists for:
 *
 *  1. the accepted case returns the parsed envelope, its hash, and the source
 *     and sequence it declares;
 *  2. every divergence is reported with its own `field`, not just prose, and
 *     the rejection never echoes the envelope's contents back;
 *  3. an unsigned or wrongly signed envelope is rejected — the check the
 *     removed `src/utils/stellar-xdr.ts` validator never performed, which is
 *     how a "validated" envelope could carry nobody's authorization.
 *
 * Shape-level checks (source, sequence, operation count, fee band) are
 * asserted against the shared matcher's order: an envelope with two operations
 * must be reported as such rather than as an incidental asset or amount
 * mismatch further down.
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
import {
  assertSignedTransactionMatchesIntent,
  inspectSignedTransaction,
} from "../../src/services/xdr-inspection";
import { stellar, type PaymentExpectation } from "../../src/services/stellar";
import { AppError } from "../../src/errors/app-error";
import { config } from "../../src/config";

const payer = Keypair.random();
const recipient = Keypair.random();
/** The account sequence Horizon reported when the intent was built. */
const ACCOUNT_SEQUENCE = "12345";
/** The envelope's own sequence: one past the account's, as the builder sets it. */
const TX_SEQUENCE = "12346";

/** The stored intent every envelope below is judged against. */
const intent: PaymentExpectation = {
  sourcePublicKey: payer.publicKey(),
  destination: recipient.publicKey(),
  asset: { code: "XLM", issuer: null },
  amount: "50.0000000",
  memoCode: "ABC234",
  resource: "settlement",
};

/** An unsigned envelope for the intent, optionally with fields diverging. */
function buildXdr(overrides: Partial<PaymentExpectation> = {}): string {
  return stellar.buildPayment({
    sourcePublicKey: overrides.sourcePublicKey ?? intent.sourcePublicKey,
    // `buildPayment` takes the *account* sequence; the envelope it returns
    // carries TX_SEQUENCE.
    sourceSequence: ACCOUNT_SEQUENCE,
    destination: overrides.destination ?? intent.destination,
    asset: overrides.asset ?? intent.asset,
    amount: overrides.amount ?? intent.amount,
    memoCode: overrides.memoCode ?? intent.memoCode,
  });
}

/** Sign an envelope with `signer` (the payer unless told otherwise). */
function sign(xdr: string, signer: Keypair = payer): string {
  const tx = new Transaction(xdr, config.networkPassphrase);
  tx.sign(signer);
  return tx.toXDR();
}

/** A hand-built envelope, for shapes `buildPayment` will not produce. */
function buildCustomXdr(
  options: {
    fee?: string;
    operations?: number;
    operationSource?: string;
    memo?: string | null;
    operationType?: "payment" | "manageData";
    asset?: Asset;
  } = {}
): string {
  const {
    fee = BASE_FEE,
    operations = 1,
    operationSource,
    memo = `MP:${intent.memoCode}`,
    operationType = "payment",
    asset = Asset.native(),
  } = options;

  const builder = new TransactionBuilder(
    new Account(intent.sourcePublicKey, ACCOUNT_SEQUENCE),
    { fee, networkPassphrase: config.networkPassphrase }
  );

  for (let i = 0; i < operations; i++) {
    builder.addOperation(
      operationType === "manageData"
        ? Operation.manageData({ name: "not-a-payment", value: "x" })
        : Operation.payment({
            source: operationSource,
            destination: intent.destination,
            asset,
            amount: intent.amount,
          })
    );
  }

  if (memo !== null) builder.addMemo(Memo.text(memo));
  return builder.setTimeout(300).build().toXDR();
}

describe("inspectSignedTransaction — accepted envelope", () => {
  it("accepts the signed envelope the API itself built", () => {
    const signedXdr = sign(buildXdr());
    const result = inspectSignedTransaction(signedXdr, intent);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe(payer.publicKey());
    expect(result.sequence).toBe(TX_SEQUENCE);
    expect(result.hash).toBe(
      new Transaction(signedXdr, config.networkPassphrase).hash().toString("hex")
    );
  });

  it("accepts an amount written with different trailing precision", () => {
    // "50" and "50.0000000" are the same payment; a raw string comparison
    // would reject one of them, which is a real wallet behaviour.
    const result = inspectSignedTransaction(sign(buildXdr({ amount: "50" })), intent);
    expect(result).toMatchObject({ ok: true });
  });

  it("accepts an unsigned envelope only when the caller opts out of the check", () => {
    const unsigned = buildXdr();
    expect(inspectSignedTransaction(unsigned, intent)).toMatchObject({
      ok: false,
      code: "xdr_unsigned",
    });
    expect(
      inspectSignedTransaction(unsigned, intent, { requireSignature: false })
    ).toMatchObject({ ok: true });
  });

  it("checks the sequence only when the intent recorded one", () => {
    const signedXdr = sign(buildXdr());
    expect(
      inspectSignedTransaction(signedXdr, { ...intent, sourceSequence: TX_SEQUENCE })
    ).toMatchObject({ ok: true });
    expect(
      inspectSignedTransaction(signedXdr, { ...intent, sourceSequence: "999" })
    ).toMatchObject({ ok: false, field: "sequence" });
  });
});

describe("inspectSignedTransaction — signature verification", () => {
  it("rejects an unsigned envelope", () => {
    expect(inspectSignedTransaction(buildXdr(), intent)).toMatchObject({
      ok: false,
      code: "xdr_unsigned",
      field: "signature",
    });
  });

  it("rejects an envelope signed by someone other than the source account", () => {
    const result = inspectSignedTransaction(sign(buildXdr(), Keypair.random()), intent);
    expect(result).toMatchObject({ ok: false, code: "xdr_unsigned", field: "signature" });
  });

  it("rejects a signature produced for a different network", () => {
    // The transaction hash is computed over bytes that include the network
    // passphrase, so a testnet signature cannot verify against a public-network
    // envelope even with the right key.
    const unsigned = buildXdr();
    const otherNetwork = new Transaction(unsigned, "Other Network ; 2037");
    otherNetwork.sign(payer);
    const signatures = otherNetwork.signatures;

    const tx = new Transaction(unsigned, config.networkPassphrase);
    for (const signature of signatures) tx.signatures.push(signature);

    expect(inspectSignedTransaction(tx.toXDR(), intent)).toMatchObject({
      ok: false,
      code: "xdr_unsigned",
    });
  });
});

describe("inspectSignedTransaction — intent divergence", () => {
  it("reports a different source account", () => {
    const other = Keypair.random();
    const xdr = buildXdr({ sourcePublicKey: other.publicKey() });
    expect(inspectSignedTransaction(sign(xdr, other), intent)).toMatchObject({
      ok: false,
      code: "xdr_mismatch",
      field: "source",
    });
  });

  it("reports a different destination", () => {
    const xdr = buildXdr({ destination: Keypair.random().publicKey() });
    expect(inspectSignedTransaction(sign(xdr), intent)).toMatchObject({
      ok: false,
      code: "xdr_mismatch",
      field: "destination",
    });
  });

  it("reports a different amount", () => {
    expect(
      inspectSignedTransaction(sign(buildXdr({ amount: "999.0000000" })), intent)
    ).toMatchObject({ ok: false, code: "xdr_mismatch", field: "amount" });
  });

  it("reports a different asset", () => {
    const usdc = { code: config.STABLE_ASSET_CODE, issuer: config.STABLE_ASSET_ISSUER };
    expect(
      inspectSignedTransaction(sign(buildXdr({ asset: usdc })), intent)
    ).toMatchObject({ ok: false, code: "xdr_mismatch", field: "asset" });
  });

  it("reports an issuer swap separately from a code mismatch", () => {
    // Same familiar asset code, a different issuer: the recipient receives a
    // different asset entirely, and nothing in the amount or the memo shows
    // it — so it gets its own field rather than the generic asset mismatch.
    const impostor = new Asset(config.STABLE_ASSET_CODE, Keypair.random().publicKey());
    const xdr = buildCustomXdr({ asset: impostor });
    const result = inspectSignedTransaction(sign(xdr), {
      ...intent,
      asset: { code: config.STABLE_ASSET_CODE, issuer: config.STABLE_ASSET_ISSUER },
    });
    expect(result).toMatchObject({
      ok: false,
      code: "xdr_mismatch",
      field: "assetIssuer",
    });
  });

  it("reports a memo that does not name the stored reference", () => {
    expect(
      inspectSignedTransaction(sign(buildXdr({ memoCode: "ZZZ999" })), intent)
    ).toMatchObject({ ok: false, code: "xdr_mismatch", field: "memo" });
  });

  it("reports a missing memo", () => {
    expect(
      inspectSignedTransaction(sign(buildCustomXdr({ memo: null })), intent)
    ).toMatchObject({ ok: false, code: "xdr_mismatch", field: "memo" });
  });
});

describe("inspectSignedTransaction — unexpected operations", () => {
  it("rejects an envelope carrying more than one operation", () => {
    expect(
      inspectSignedTransaction(sign(buildCustomXdr({ operations: 2, fee: "200" })), intent)
    ).toMatchObject({ ok: false, code: "xdr_mismatch", field: "operationCount" });
  });

  it("rejects an operation that is not a payment", () => {
    expect(
      inspectSignedTransaction(
        sign(buildCustomXdr({ operationType: "manageData" })),
        intent
      )
    ).toMatchObject({ ok: false, code: "xdr_mismatch", field: "operationType" });
  });

  it("rejects a payment whose operation source is a third account", () => {
    // An operation-level source lets an envelope spend a *different* account
    // than the transaction declares, which is not the payment we authorized.
    const xdr = buildCustomXdr({ operationSource: Keypair.random().publicKey() });
    expect(inspectSignedTransaction(sign(xdr), intent)).toMatchObject({
      ok: false,
      code: "xdr_mismatch",
      field: "operationSource",
    });
  });

  it("rejects a fee outside the accepted band", () => {
    expect(
      inspectSignedTransaction(sign(buildCustomXdr({ fee: "100000" })), intent)
    ).toMatchObject({ ok: false, code: "xdr_mismatch", field: "fee" });
  });
});

describe("inspectSignedTransaction — malformed and expired envelopes", () => {
  it.each(["", "   ", "not-xdr!!", "signed XDR goes here"])(
    "rejects input that is not an envelope at all: %j",
    (value) => {
      expect(inspectSignedTransaction(value, intent)).toMatchObject({
        ok: false,
        code: "xdr_malformed",
        field: "envelope",
      });
    }
  );

  it("rejects a fee-bump wrapper as a different transaction, not a bad operation count", () => {
    const inner = new Transaction(buildXdr(), config.networkPassphrase);
    inner.sign(payer);
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      Keypair.random().publicKey(),
      String(Number(BASE_FEE) * 2),
      inner,
      config.networkPassphrase
    );

    const result = inspectSignedTransaction(feeBump.toXDR(), intent);
    expect(result).toMatchObject({ ok: false, code: "xdr_mismatch", field: "envelope" });
    if (result.ok) return;
    expect(result.message).toMatch(/fee-bump/i);
  });

  it("reports an envelope whose validity window has lapsed as expired", () => {
    const expired = new TransactionBuilder(
      new Account(intent.sourcePublicKey, ACCOUNT_SEQUENCE),
      {
        fee: BASE_FEE,
        networkPassphrase: config.networkPassphrase,
        timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) - 3600 },
      }
    )
      .addOperation(
        Operation.payment({
          destination: intent.destination,
          asset: Asset.native(),
          amount: intent.amount,
        })
      )
      .addMemo(Memo.text(`MP:${intent.memoCode}`))
      .build();
    expired.sign(payer);

    expect(inspectSignedTransaction(expired.toXDR(), intent)).toMatchObject({
      ok: false,
      code: "intent_expired",
      field: "timeBounds",
    });
  });

  it("rejects an envelope that never expires", () => {
    const unbounded = new TransactionBuilder(
      new Account(intent.sourcePublicKey, ACCOUNT_SEQUENCE),
      { fee: BASE_FEE, networkPassphrase: config.networkPassphrase }
    )
      .addOperation(
        Operation.payment({
          destination: intent.destination,
          asset: Asset.native(),
          amount: intent.amount,
        })
      )
      .addMemo(Memo.text(`MP:${intent.memoCode}`))
      .setTimeout(0)
      .build();
    unbounded.sign(payer);

    expect(inspectSignedTransaction(unbounded.toXDR(), intent)).toMatchObject({
      ok: false,
      field: "timeBounds",
    });
  });
});

describe("inspectSignedTransaction — what a rejection may disclose", () => {
  it("never echoes the envelope or its values back in the message", () => {
    const signedXdr = sign(buildXdr({ amount: "999.0000000" }));
    const result = inspectSignedTransaction(signedXdr, intent);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).not.toContain("999");
    expect(result.message).not.toContain(signedXdr.slice(0, 24));
    expect(result.message).not.toContain(payer.publicKey());
  });
});

describe("assertSignedTransactionMatchesIntent", () => {
  it("returns the accepted inspection for a valid envelope", () => {
    const result = assertSignedTransactionMatchesIntent(sign(buildXdr()), intent);
    expect(result.source).toBe(payer.publicKey());
    expect(result.hash).toHaveLength(64);
  });

  it("throws a 400 carrying the stable code and the diverging field", () => {
    try {
      assertSignedTransactionMatchesIntent(sign(buildXdr({ amount: "1" })), intent);
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.status).toBe(400);
      expect(appError.code).toBe("XDR_MISMATCH");
      expect(appError.details).toEqual({ field: "amount" });
    }
  });

  it("throws XDR_UNSIGNED for an envelope nobody signed", () => {
    try {
      assertSignedTransactionMatchesIntent(buildXdr(), intent);
      throw new Error("expected a rejection");
    } catch (error) {
      expect((error as AppError).code).toBe("XDR_UNSIGNED");
    }
  });
});
