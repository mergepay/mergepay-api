/**
 * A wallet-signed envelope must match the settlement intent the API created.
 * Everything between "here is an unsigned XDR" and "here is a signed one" is
 * outside our control, so every field a wallet could alter is checked against
 * the persisted intent before submission.
 *
 * The API never handles a private key: these tests sign locally with throwaway
 * keypairs the way a wallet would, and only ever hand the *signed envelope* to
 * the code under test.
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
  stellar,
  parseSignedPaymentXdr,
  assertTimeBoundsValid,
  validateSignedPaymentXdr,
} from "../src/services/stellar";
import {
  settlementPaymentIntent,
  validateSettlementXdr,
} from "../src/services/settlement-xdr";
import { config } from "../src/config";

const wallet = Keypair.random();
const recipient = Keypair.random();

/** The settlement row the API persisted when it issued the unsigned XDR. */
const settlement = {
  shortCode: "ABC123",
  amount: "12.5000000",
  assetCode: "XLM",
  assetIssuer: null,
  expiresAt: null,
  from: { stellarPublicKey: wallet.publicKey() },
  to: { stellarPublicKey: recipient.publicKey() },
};

const intent = settlementPaymentIntent(settlement);

function buildXdr(overrides: Partial<typeof settlement> = {}): string {
  const merged = { ...settlement, ...overrides };
  return stellar.buildPayment({
    sourcePublicKey: merged.from.stellarPublicKey,
    sourceSequence: "12345",
    destination: merged.to.stellarPublicKey,
    asset: { code: merged.assetCode, issuer: merged.assetIssuer },
    amount: String(merged.amount),
    memoCode: merged.shortCode,
  });
}

/** Sign the way a wallet would: locally, with a key the API never sees. */
function sign(xdr: string, signer: Keypair = wallet): string {
  const tx = new Transaction(xdr, config.networkPassphrase);
  tx.sign(signer);
  return tx.toXDR();
}

function buildCustomXdr({
  fee = String(Number(BASE_FEE) * 2),
  operationSource,
  extraOperation = false,
  memo = "MP:ABC123",
  timeoutSeconds = 300,
  sequence = "12345",
}: {
  fee?: string;
  operationSource?: string;
  extraOperation?: boolean;
  memo?: string;
  timeoutSeconds?: number;
  sequence?: string;
} = {}): string {
  const txb = new TransactionBuilder(
    new Account(settlement.from.stellarPublicKey, sequence),
    { fee, networkPassphrase: config.networkPassphrase }
  ).addOperation(
    Operation.payment({
      source: operationSource,
      destination: settlement.to.stellarPublicKey,
      asset: Asset.native(),
      amount: String(settlement.amount),
    })
  );

  if (extraOperation) {
    txb.addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: "1",
      })
    );
  }

  return txb.addMemo(Memo.text(memo)).setTimeout(timeoutSeconds).build().toXDR();
}

describe("parseSignedPaymentXdr", () => {
  it("parses a well-formed transaction envelope", () => {
    expect(parseSignedPaymentXdr(buildXdr())).toBeInstanceOf(Transaction);
  });

  it("rejects malformed base64/XDR without throwing an uncaught exception", () => {
    expect(() => parseSignedPaymentXdr("not-a-valid-xdr-envelope")).toThrow(
      /could not be parsed/i
    );
  });

  it("rejects fee-bump transaction envelopes", () => {
    const inner = new Transaction(sign(buildXdr()), config.networkPassphrase);
    const feeBumpXdr = TransactionBuilder.buildFeeBumpTransaction(
      wallet,
      String(Number(BASE_FEE) * 10),
      inner,
      config.networkPassphrase
    ).toXDR();

    expect(() => parseSignedPaymentXdr(feeBumpXdr)).toThrow(/fee-bump/i);
  });
});

describe("assertTimeBoundsValid", () => {
  it("accepts an envelope inside its validity window", () => {
    const tx = new Transaction(buildXdr(), config.networkPassphrase);
    expect(() => assertTimeBoundsValid(tx)).not.toThrow();
  });

  it("rejects an envelope whose time bounds have already lapsed", () => {
    const tx = new TransactionBuilder(
      new Account(settlement.from.stellarPublicKey, "12345"),
      { fee: String(Number(BASE_FEE) * 2), networkPassphrase: config.networkPassphrase }
    )
      .addOperation(
        Operation.payment({
          destination: settlement.to.stellarPublicKey,
          asset: Asset.native(),
          amount: "1",
        })
      )
      .setTimebounds(1, Math.floor(Date.now() / 1000) - 600)
      .build();

    expect(() => assertTimeBoundsValid(tx)).toThrow(/expired/i);
  });

  it("rejects an envelope that never expires", () => {
    const tx = new TransactionBuilder(
      new Account(settlement.from.stellarPublicKey, "12345"),
      { fee: String(Number(BASE_FEE) * 2), networkPassphrase: config.networkPassphrase }
    )
      .addOperation(
        Operation.payment({
          destination: settlement.to.stellarPublicKey,
          asset: Asset.native(),
          amount: "1",
        })
      )
      .setTimebounds(0, 0)
      .build();

    expect(() => assertTimeBoundsValid(tx)).toThrow(/time bound/i);
  });

  it("rejects an envelope valid longer than the intent it was built for", () => {
    const tx = new Transaction(buildXdr(), config.networkPassphrase);
    const alreadyClosing = new Date(Date.now() + 10_000);

    expect(() => assertTimeBoundsValid(tx, alreadyClosing, "settlement")).toThrow(
      /valid longer/i
    );
  });
});

describe("validateSignedPaymentXdr", () => {
  it("accepts an envelope that matches the intent", () => {
    expect(validateSignedPaymentXdr(buildXdr(), intent)).toBeInstanceOf(Transaction);
  });

  it("rejects garbage input without throwing an uncaught exception", () => {
    expect(() => validateSignedPaymentXdr("////not-xdr////", intent)).toThrow(
      /could not be parsed/i
    );
  });
});

describe("validateSettlementXdr", () => {
  it("accepts the signed envelope the API issued for this settlement", () => {
    const { hash } = validateSettlementXdr(sign(buildXdr()), settlement);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a destination swapped between XDR creation and signing", () => {
    const signedXdr = sign(
      buildXdr({ to: { stellarPublicKey: Keypair.random().publicKey() } })
    );

    expect(() => validateSettlementXdr(signedXdr, settlement)).toThrow(/destination/i);
  });

  it("rejects an amount changed after the fact", () => {
    expect(() => validateSettlementXdr(sign(buildXdr({ amount: "999" })), settlement)).toThrow(
      /amount/i
    );
  });

  it("rejects an asset swapped for a different one", () => {
    const signedXdr = sign(
      buildXdr({
        assetCode: config.STABLE_ASSET_CODE,
        assetIssuer: config.STABLE_ASSET_ISSUER,
      })
    );

    expect(() => validateSettlementXdr(signedXdr, settlement)).toThrow(/asset/i);
  });

  it("rejects an issuer swap that keeps the familiar asset code", () => {
    const stableSettlement = {
      ...settlement,
      assetCode: config.STABLE_ASSET_CODE,
      assetIssuer: config.STABLE_ASSET_ISSUER,
    };
    // The envelope names the same code with a different issuer — a different
    // token entirely, and the one case a code-only check would wave through.
    const tx = new TransactionBuilder(
      new Account(settlement.from.stellarPublicKey, "12345"),
      { fee: String(Number(BASE_FEE) * 2), networkPassphrase: config.networkPassphrase }
    )
      .addOperation(
        Operation.payment({
          destination: settlement.to.stellarPublicKey,
          asset: new Asset(config.STABLE_ASSET_CODE, Keypair.random().publicKey()),
          amount: String(settlement.amount),
        })
      )
      .addMemo(Memo.text("MP:ABC123"))
      .setTimeout(300)
      .build();
    tx.sign(wallet);

    expect(() => validateSettlementXdr(tx.toXDR(), stableSettlement)).toThrow(
      /issuer mismatch/i
    );
  });

  it("rejects a memo that no longer references this settlement", () => {
    expect(() =>
      validateSettlementXdr(sign(buildXdr({ shortCode: "OTHER99" })), settlement)
    ).toThrow(/memo/i);
  });

  it("rejects a transaction source that is not the settlement's payer", () => {
    const impostor = Keypair.random();
    const signedXdr = sign(
      buildXdr({ from: { stellarPublicKey: impostor.publicKey() } }),
      impostor
    );

    expect(() => validateSettlementXdr(signedXdr, settlement)).toThrow(/source/i);
  });

  it("rejects a payment operation with an overridden source account", () => {
    const signedXdr = sign(
      buildCustomXdr({ operationSource: Keypair.random().publicKey() })
    );

    expect(() => validateSettlementXdr(signedXdr, settlement)).toThrow(
      /operation source/i
    );
  });

  it("rejects unexpected extra operations", () => {
    const signedXdr = sign(buildCustomXdr({ extraOperation: true }));

    expect(() => validateSettlementXdr(signedXdr, settlement)).toThrow(/one operation/i);
  });

  it("rejects a fee inflated beyond what the API authorized", () => {
    const signedXdr = sign(buildCustomXdr({ fee: "999" }));

    expect(() => validateSettlementXdr(signedXdr, settlement)).toThrow(/fee/i);
  });

  it("rejects an envelope with a different source sequence when the intent records one", () => {
    const intentWithSequence = { ...settlement, sourceSequence: "12345" };
    const signedXdr = sign(buildCustomXdr({ sequence: "12346" }));

    expect(() => validateSettlementXdr(signedXdr, intentWithSequence)).toThrow(/sequence/i);
  });

  it("rejects an envelope signed for a different network", () => {
    const wrongNetwork = "Wrong SDF Network ; September 2015";
    const tx = new Transaction(buildXdr(), wrongNetwork);
    tx.sign(wallet);

    expect(() => validateSettlementXdr(tx.toXDR(), settlement)).toThrow(/network/i);
  });

  it("rejects an unsigned envelope", () => {
    expect(() => validateSettlementXdr(buildXdr(), settlement)).toThrow(
      /signature is invalid/i
    );
  });

  it("rejects an envelope signed by someone other than the payer", () => {
    expect(() => validateSettlementXdr(sign(buildXdr(), Keypair.random()), settlement)).toThrow(
      /signature is invalid/i
    );
  });

  it("rejects an envelope whose window closed before submission", () => {
    const expired = { ...settlement, expiresAt: new Date(Date.now() - 600_000) };

    expect(() => validateSettlementXdr(sign(buildXdr()), expired)).toThrow(
      /valid longer|expired/i
    );
  });

  it("rejects malformed XDR", () => {
    expect(() => validateSettlementXdr("not-xdr", settlement)).toThrow(/malformed/i);
  });

  it("reports a stable client error code and never echoes the envelope", () => {
    try {
      validateSettlementXdr(sign(buildXdr({ amount: "999" })), settlement);
      throw new Error("expected validation to reject");
    } catch (error: any) {
      expect(error.statusCode).toBe(400);
      expect(error.code).toBe("XDR_MISMATCH");
      expect(error.message).not.toMatch(/AAAA/);
    }
  });
});
