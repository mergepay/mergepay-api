import { describe, it, expect } from "vitest";
import { Keypair, Transaction, TransactionBuilder, WebAuth } from "@stellar/stellar-sdk";
import {
  SEP10_TRANSACTION_XDR_MAX_LENGTH,
  sep10ChallengeRequestSchema,
  sep10QuerySchema,
  sep10VerifyRequestSchema,
} from "../../src/schemas/auth";
import { config } from "../../src/config";

/**
 * Unit tests for the SEP-10 request schemas (issue #519).
 *
 * The rules live in src/validations/sep10.ts; these tests exercise them
 * through the `src/schemas/auth` import point the issue names, so the published
 * contract is what is under test rather than a private copy of it.
 *
 * `POST /auth/verify` is the focus: the signed challenge envelope a wallet
 * submits has to be a plausible base64 XDR string before the SDK is asked to
 * parse it, and every way of getting that wrong must be a validation error
 * rather than an opaque authentication failure.
 */

/** A genuine signed SEP-10 challenge, built offline with the SDK. */
function signedChallenge(): string {
  const server = Keypair.random();
  const client = Keypair.random();
  const envelope = WebAuth.buildChallengeTx(
    server,
    client.publicKey(),
    config.SEP10_HOME_DOMAIN,
    300,
    config.networkPassphrase,
    config.WEB_AUTH_DOMAIN
  );
  const tx = new Transaction(envelope, config.networkPassphrase);
  tx.sign(client);
  return tx.toXDR();
}

const issuesFor = (result: ReturnType<typeof sep10VerifyRequestSchema.safeParse>) =>
  result.success ? [] : result.error.issues;

describe("auth schemas (src/schemas/auth)", () => {
  it("exports the canonical schema objects, not copies", async () => {
    const canonical = await import("../../src/validations/sep10");
    expect(sep10VerifyRequestSchema).toBe(canonical.sep10VerifyRequestSchema);
    expect(sep10ChallengeRequestSchema).toBe(canonical.sep10ChallengeRequestSchema);
    expect(sep10QuerySchema).toBe(canonical.sep10QuerySchema);
    expect(SEP10_TRANSACTION_XDR_MAX_LENGTH).toBe(
      canonical.SEP10_TRANSACTION_XDR_MAX_LENGTH
    );
  });
});

describe("sep10VerifyRequestSchema — accepts a real signed challenge", () => {
  it("passes a signed challenge envelope through unchanged", () => {
    const transaction = signedChallenge();
    const result = sep10VerifyRequestSchema.safeParse({ transaction });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ transaction });
      // The XDR is handed on byte for byte: a schema that normalized it would
      // invalidate the signature the wallet just produced.
      expect(result.data.transaction).toBe(transaction);
    }
  });

  it("passes the unsigned challenge the wallet is handed by /auth/challenge", () => {
    // Whether the envelope carries the client's signature is the SDK's call,
    // not the schema's — a valid challenge must survive either way.
    const envelope = WebAuth.buildChallengeTx(
      Keypair.random(),
      Keypair.random().publicKey(),
      config.SEP10_HOME_DOMAIN,
      300,
      config.networkPassphrase,
      config.WEB_AUTH_DOMAIN
    );

    expect(sep10VerifyRequestSchema.safeParse({ transaction: envelope }).success).toBe(
      true
    );
  });

  it("accepts a fee-bump wrapped envelope, which is also a valid XDR value", () => {
    const server = Keypair.random();
    const client = Keypair.random();
    const inner = new Transaction(
      WebAuth.buildChallengeTx(
        server,
        client.publicKey(),
        config.SEP10_HOME_DOMAIN,
        300,
        config.networkPassphrase,
        config.WEB_AUTH_DOMAIN
      ),
      config.networkPassphrase
    );
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      server,
      "100",
      inner,
      config.networkPassphrase
    );
    feeBump.sign(server);

    expect(sep10VerifyRequestSchema.safeParse({ transaction: feeBump.toXDR() }).success).toBe(
      true
    );
  });

  it("accepts the boundary lengths: one XDR word and the maximum envelope", () => {
    // "AAAAAA==" decodes to exactly one 4-byte word, and the longest accepted
    // envelope is well inside XDR's word alignment (37 500 bytes).
    expect(sep10VerifyRequestSchema.safeParse({ transaction: "AAAAAA==" }).success).toBe(
      true
    );
    expect(
      sep10VerifyRequestSchema.safeParse({
        transaction: "A".repeat(SEP10_TRANSACTION_XDR_MAX_LENGTH),
      }).success
    ).toBe(true);
  });

  it("keeps the optional domain fields, in both spellings", () => {
    const transaction = signedChallenge();
    const result = sep10VerifyRequestSchema.safeParse({
      transaction,
      home_domain: "anchor.example.com",
      client_domain: "wallet.example.com",
      clientDomain: "wallet.example.com",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        transaction,
        home_domain: "anchor.example.com",
        client_domain: "wallet.example.com",
        clientDomain: "wallet.example.com",
      });
    }
  });
});

describe("sep10VerifyRequestSchema — rejects invalid payloads", () => {
  it.each([
    ["a missing transaction", {}],
    ["a null transaction", { transaction: null }],
    ["a numeric transaction", { transaction: 7 }],
    ["a boolean transaction", { transaction: true }],
    ["an object transaction", { transaction: { xdr: "AAAA" } }],
    ["an array transaction", { transaction: ["AAAA"] }],
    ["an empty transaction", { transaction: "" }],
    ["a whitespace-only transaction", { transaction: "   " }],
    ["a transaction with surrounding whitespace", { transaction: " AAAA " }],
    ["a transaction with an embedded newline", { transaction: "AAAA\n" }],
    ["a non-base64 transaction", { transaction: "not-xdr!" }],
    ["a base64url transaction", { transaction: "a-_b" }],
    ["a URL-encoded transaction", { transaction: "AAAA%3D%3D" }],
    ["a hex digest sent as the envelope", { transaction: "deadbeef" }],
    ["a transaction with non-canonical padding bits", { transaction: "AB==" }],
    ["a transaction with an over-long padding run", { transaction: "AAAA=" }],
    ["a transaction that decodes to a partial XDR word", { transaction: "AAAA" }],
    ["a transaction one character over the maximum", { transaction: `A${"A".repeat(SEP10_TRANSACTION_XDR_MAX_LENGTH)}` }],
  ])("rejects %s", (_label, payload) => {
    const result = sep10VerifyRequestSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("reports every rejected payload against the transaction field", () => {
    const rejected = [
      {},
      { transaction: null },
      { transaction: 7 },
      { transaction: "" },
      { transaction: "not-xdr!" },
      { transaction: "AB==" },
      { transaction: "AAAA" },
      { transaction: "A".repeat(SEP10_TRANSACTION_XDR_MAX_LENGTH + 1) },
    ];

    for (const payload of rejected) {
      const result = sep10VerifyRequestSchema.safeParse(payload);
      expect(result.success).toBe(false);
      expect(issuesFor(result).map((issue) => issue.path)).toContainEqual(["transaction"]);
    }
  });

  it("names a missing field and a wrong type in the message", () => {
    const missing = issuesFor(sep10VerifyRequestSchema.safeParse({}));
    expect(missing[0]?.message).toBe("transaction is required");

    const wrongType = issuesFor(sep10VerifyRequestSchema.safeParse({ transaction: 7 }));
    expect(wrongType[0]?.message).toBe("transaction must be a string");
  });

  it("names the encoding rule that rejected the envelope", () => {
    // A client that gets these two can fix itself; the message has to say which
    // encoding it broke, not just "invalid".
    const notBase64 = issuesFor(
      sep10VerifyRequestSchema.safeParse({ transaction: "not-xdr!" })
    );
    expect(notBase64[0]?.message).toMatch(/base64/i);

    const misaligned = issuesFor(sep10VerifyRequestSchema.safeParse({ transaction: "AAAA" }));
    expect(misaligned[0]?.message).toMatch(/XDR words/i);
  });

  it.each([
    ["an empty string", { transaction: "" }, /required/i],
    ["a non-base64 string", { transaction: "not-xdr!" }, /standard base64/i],
    ["non-canonical padding bits", { transaction: "AB==" }, /canonical base64/i],
    ["a partial XDR word", { transaction: "AAAA" }, /XDR words/i],
    ["a numeric value", { transaction: 7 }, /must be a string/i],
    ["a missing field", {}, /is required/i],
  ])("reports exactly the first problem with %s", (_label, payload, message) => {
    // Every rule that fires would otherwise restate the same mistake in a
    // different vocabulary, burying the one line the client has to act on.
    const issues = issuesFor(sep10VerifyRequestSchema.safeParse(payload));

    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(message);
  });

  it("rejects an envelope one character over the maximum", () => {
    const result = sep10VerifyRequestSchema.safeParse({
      transaction: "A".repeat(SEP10_TRANSACTION_XDR_MAX_LENGTH + 1),
    });

    expect(result.success).toBe(false);
    expect(issuesFor(result)[0]?.message).toMatch(/maximum size/i);
  });

  it("rejects unknown keys instead of stripping them", () => {
    const result = sep10VerifyRequestSchema.safeParse({
      transaction: signedChallenge(),
      account: Keypair.random().publicKey(),
    });

    expect(result.success).toBe(false);
    expect(issuesFor(result)[0]?.code).toBe("unrecognized_keys");
  });

  it.each([null, undefined, "AAAA", 42, ["AAAA"]])(
    "rejects a non-object body (%s)",
    (payload) => {
      expect(sep10VerifyRequestSchema.safeParse(payload).success).toBe(false);
    }
  );

  it("still validates the optional domain fields", () => {
    const transaction = signedChallenge();
    for (const domain of [
      { home_domain: "" },
      { home_domain: "example" },
      { home_domain: "-anchor.example.com" },
      { client_domain: "wallet_example.com" },
      { client_domain: 42 },
      { clientDomain: "wallet.example.com.evil.com/path" },
    ]) {
      const result = sep10VerifyRequestSchema.safeParse({ transaction, ...domain });
      expect(result.success).toBe(false);
    }
  });
});

describe("sep10VerifyRequestSchema — what it deliberately leaves to the SDK", () => {
  /**
   * The schema answers "is this a plausible base64 XDR string?"; the SDK
   * answers "is this a challenge this server issued?". A well-formed envelope
   * that is not ours must therefore pass validation and be refused during
   * verification, so these cases must not be tightened into the schema — doing
   * so would duplicate the SDK's rules in a second place.
   */
  it.each([
    ["a syntactically valid envelope that is not a transaction", "AAAAAA=="],
    ["an envelope of zeroes", "AAAAAAAAAAAAAAAA"],
  ])("accepts %s and leaves the verdict to verification", (_label, transaction) => {
    expect(sep10VerifyRequestSchema.safeParse({ transaction }).success).toBe(true);
  });
});
