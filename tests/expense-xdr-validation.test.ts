/**
 * Automated validation tests for signed XDR transaction payloads against expected group expense intents.
 *
 * Per project security principles, the API never handles user private keys.
 * It decodes signed XDR payloads submitted by client wallets, inspects operations,
 * destination accounts, asset types, amounts, and memos, and compares them against
 * stored pending expense records to prevent tampering before submission to the Stellar network.
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
import { stellar } from "../src/services/stellar";
import {
  expensePaymentIntent,
  validateExpenseXdr,
  type ExpenseIntentRecord,
} from "../src/services/expense-xdr";
import { config } from "../src/config";

const payer = Keypair.random();
const recipient = Keypair.random();

/** The stored group expense intent record persisted in the database. */
const expenseIntent: ExpenseIntentRecord = {
  shortCode: "EXP123",
  amount: "25.5000000",
  assetCode: "XLM",
  assetIssuer: null,
  expiresAt: null,
  from: { stellarPublicKey: payer.publicKey() },
  to: { stellarPublicKey: recipient.publicKey() },
};

function buildExpenseXdr(overrides: Partial<ExpenseIntentRecord> = {}): string {
  const merged = { ...expenseIntent, ...overrides };
  return stellar.buildPayment({
    sourcePublicKey: merged.from.stellarPublicKey,
    sourceSequence: "987654321",
    destination: merged.to.stellarPublicKey,
    asset: { code: merged.assetCode, issuer: merged.assetIssuer },
    amount: String(merged.amount),
    memoCode: merged.shortCode ?? "EXP123",
  });
}

function signTx(xdr: string, signer: Keypair = payer): string {
  const tx = new Transaction(xdr, config.networkPassphrase);
  tx.sign(signer);
  return tx.toXDR();
}

function buildCustomExpenseXdr({
  fee = String(Number(BASE_FEE) * 2),
  operationSource,
  extraOperation = false,
  memo = "MP:EXP123",
  timeoutSeconds = 300,
  sequence = "987654321",
}: {
  fee?: string;
  operationSource?: string;
  extraOperation?: boolean;
  memo?: string;
  timeoutSeconds?: number;
  sequence?: string;
} = {}): string {
  const txb = new TransactionBuilder(
    new Account(expenseIntent.from.stellarPublicKey, sequence),
    { fee, networkPassphrase: config.networkPassphrase }
  ).addOperation(
    Operation.payment({
      source: operationSource,
      destination: expenseIntent.to.stellarPublicKey,
      asset: Asset.native(),
      amount: String(expenseIntent.amount),
    })
  );

  if (extraOperation) {
    txb.addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: "5.0000000",
      })
    );
  }

  return txb.addMemo(Memo.text(memo)).setTimeout(timeoutSeconds).build().toXDR();
}

describe("expensePaymentIntent", () => {
  it("rebuilds payment expectation from stored expense intent record", () => {
    const expectation = expensePaymentIntent(expenseIntent);
    expect(expectation.sourcePublicKey).toBe(payer.publicKey());
    expect(expectation.destination).toBe(recipient.publicKey());
    expect(expectation.amount).toBe("25.5000000");
    expect(expectation.asset.code).toBe("XLM");
    expect(expectation.asset.issuer).toBeNull();
    expect(expectation.memoCode).toBe("EXP123");
    expect(expectation.resource).toBe("expense");
  });
});

describe("validateExpenseXdr", () => {
  it("accepts a valid signed XDR envelope matching the group expense intent", () => {
    const signedXdr = signTx(buildExpenseXdr());
    const { tx, hash } = validateExpenseXdr(signedXdr, expenseIntent);

    expect(tx).toBeInstanceOf(Transaction);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects an envelope with a modified/tampered amount", () => {
    const tamperedSignedXdr = signTx(buildExpenseXdr({ amount: "100.0000000" }));

    expect(() => validateExpenseXdr(tamperedSignedXdr, expenseIntent)).toThrow(/amount/i);
  });

  it("rejects an envelope with a modified/swapped destination account", () => {
    const attacker = Keypair.random();
    const tamperedSignedXdr = signTx(
      buildExpenseXdr({ to: { stellarPublicKey: attacker.publicKey() } })
    );

    expect(() => validateExpenseXdr(tamperedSignedXdr, expenseIntent)).toThrow(/destination/i);
  });

  it("rejects an envelope with a modified asset code", () => {
    const tamperedSignedXdr = signTx(
      buildExpenseXdr({
        assetCode: config.STABLE_ASSET_CODE,
        assetIssuer: config.STABLE_ASSET_ISSUER,
      })
    );

    expect(() => validateExpenseXdr(tamperedSignedXdr, expenseIntent)).toThrow(/asset/i);
  });

  it("rejects an envelope with an asset issuer swap keeping the code", () => {
    const customAssetIntent: ExpenseIntentRecord = {
      ...expenseIntent,
      assetCode: config.STABLE_ASSET_CODE,
      assetIssuer: config.STABLE_ASSET_ISSUER,
    };

    const tamperedTx = new TransactionBuilder(
      new Account(expenseIntent.from.stellarPublicKey, "987654321"),
      { fee: String(Number(BASE_FEE) * 2), networkPassphrase: config.networkPassphrase }
    )
      .addOperation(
        Operation.payment({
          destination: expenseIntent.to.stellarPublicKey,
          asset: new Asset(config.STABLE_ASSET_CODE, Keypair.random().publicKey()),
          amount: String(expenseIntent.amount),
        })
      )
      .addMemo(Memo.text("MP:EXP123"))
      .setTimeout(300)
      .build();

    tamperedTx.sign(payer);

    expect(() => validateExpenseXdr(tamperedTx.toXDR(), customAssetIntent)).toThrow(
      /issuer mismatch/i
    );
  });

  it("rejects an envelope with a modified memo reference", () => {
    const tamperedSignedXdr = signTx(buildExpenseXdr({ shortCode: "TAMPERED" }));

    expect(() => validateExpenseXdr(tamperedSignedXdr, expenseIntent)).toThrow(/memo/i);
  });

  it("rejects an envelope where the source account is not the expected payer", () => {
    const impostor = Keypair.random();
    const tamperedSignedXdr = signTx(
      buildExpenseXdr({ from: { stellarPublicKey: impostor.publicKey() } }),
      impostor
    );

    expect(() => validateExpenseXdr(tamperedSignedXdr, expenseIntent)).toThrow(/source/i);
  });

  it("rejects a payment operation with an overridden operation source", () => {
    const tamperedSignedXdr = signTx(
      buildCustomExpenseXdr({ operationSource: Keypair.random().publicKey() })
    );

    expect(() => validateExpenseXdr(tamperedSignedXdr, expenseIntent)).toThrow(
      /operation source/i
    );
  });

  it("rejects an envelope containing unexpected extra operations", () => {
    const tamperedSignedXdr = signTx(buildCustomExpenseXdr({ extraOperation: true }));

    expect(() => validateExpenseXdr(tamperedSignedXdr, expenseIntent)).toThrow(/one operation/i);
  });

  it("rejects an envelope with an inflated transaction fee", () => {
    const tamperedSignedXdr = signTx(buildCustomExpenseXdr({ fee: "100000" }));

    expect(() => validateExpenseXdr(tamperedSignedXdr, expenseIntent)).toThrow(/fee/i);
  });

  it("rejects an envelope signed by someone other than the expected payer", () => {
    const stranger = Keypair.random();
    const tamperedSignedXdr = signTx(buildExpenseXdr(), stranger);

    expect(() => validateExpenseXdr(tamperedSignedXdr, expenseIntent)).toThrow(
      /signature is invalid/i
    );
  });

  it("rejects an unsigned envelope", () => {
    const unsignedXdr = buildExpenseXdr();

    expect(() => validateExpenseXdr(unsignedXdr, expenseIntent)).toThrow(
      /signature is invalid/i
    );
  });

  it("rejects an envelope signed for a wrong Stellar network passphrase", () => {
    const wrongNetworkPassphrase = "Test SDF Network ; September 2015";
    const tx = new Transaction(buildExpenseXdr(), wrongNetworkPassphrase);
    tx.sign(payer);

    expect(() => validateExpenseXdr(tx.toXDR(), expenseIntent)).toThrow(/network/i);
  });

  it("rejects an envelope whose time bounds have expired", () => {
    const expiredIntent: ExpenseIntentRecord = {
      ...expenseIntent,
      expiresAt: new Date(Date.now() - 300_000),
    };

    expect(() => validateExpenseXdr(signTx(buildExpenseXdr()), expiredIntent)).toThrow(
      /valid longer|expired/i
    );
  });

  it("rejects fee-bump transaction wrappers", () => {
    const innerTx = new Transaction(signTx(buildExpenseXdr()), config.networkPassphrase);
    const feeBumpXdr = TransactionBuilder.buildFeeBumpTransaction(
      payer,
      String(Number(BASE_FEE) * 10),
      innerTx,
      config.networkPassphrase
    ).toXDR();

    expect(() => validateExpenseXdr(feeBumpXdr, expenseIntent)).toThrow(/fee-bump/i);
  });

  it("rejects malformed XDR string payload", () => {
    expect(() => validateExpenseXdr("not-valid-base64-xdr", expenseIntent)).toThrow(/malformed/i);
  });

  it("returns 400 Bad Request error structure with XDR_MISMATCH code and no echoed payload", () => {
    try {
      validateExpenseXdr(signTx(buildExpenseXdr({ amount: "999.0000000" })), expenseIntent);
      throw new Error("Expected validation to fail");
    } catch (err: any) {
      expect(err.statusCode).toBe(400);
      expect(err.code).toBe("XDR_MISMATCH");
      expect(err.message).not.toMatch(/AAAA/);
    }
  });
});
