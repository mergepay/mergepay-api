import { describe, expect, it } from "vitest";
import {
  Account,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { signedXdrRequestSchema } from "../../src/validations/stellar-transaction";

function signedTransactionXdr(): string {
  const signer = Keypair.random();
  const transaction = new TransactionBuilder(new Account(signer.publicKey(), "0"), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.manageData({ name: "validation", value: "signed" }))
    .setTimeout(60)
    .build();
  transaction.sign(signer);
  return transaction.toXDR();
}

describe("signedXdrRequestSchema", () => {
  it("accepts a signed Stellar transaction XDR", () => {
    expect(signedXdrRequestSchema.safeParse({ signedXdr: signedTransactionXdr() }).success).toBe(
      true
    );
  });

  it.each([undefined, "", "not-base64!", "AAAA"]) (
    "rejects malformed signed XDR input %s",
    (signedXdr) => {
      expect(signedXdrRequestSchema.safeParse({ signedXdr }).success).toBe(false);
    }
  );

  it("rejects a missing signedXdr field", () => {
    expect(signedXdrRequestSchema.safeParse({}).success).toBe(false);
  });
});