/**
 * Treasury envelope inspection (issue #666).
 *
 * `src/services/treasury-stellar.ts` decodes an XDR this server never built and
 * decides whether a multisig treasury may sign it. Two layers are covered here:
 *
 *   1. the utility itself — every rule of `assertTreasuryEnvelopePolicy`, fed
 *      real envelopes built with `@stellar/stellar-sdk` and tampered with the
 *      way a hostile coordination tool would, plus the service-level seam;
 *   2. the two treasury multisig entry points in
 *      `src/services/treasury-signatures.ts`, proving the rejection happens
 *      before a proposal row, a signature row, or a Horizon call.
 *
 * The prisma mock and the `stellar` spies follow
 * `tests/services/treasury.test.ts`: real SDK cryptography, no network.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  Asset,
  Account,
  FeeBumpTransaction,
  Keypair,
  Memo,
  Operation,
  StrKey,
  Transaction,
  Transaction,
  TransactionBuilder,
  type Operation as StellarOperation,
} from "@stellar/stellar-sdk";

const h = vi.hoisted(() => {
  const prisma: any = {
    group: { findUnique: vi.fn() },
    groupMember: { findMany: vi.fn() },
    treasuryTxProposal: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    treasurySignature: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

import { prisma } from "../src/db";
import { config } from "../src/config";
import { AppError } from "../src/errors";
import { stellar } from "../src/services/stellar";
import {
  MAX_TREASURY_OPERATIONS,
  assertTreasuryEnvelopePolicy,
  inspectTreasuryXdr,
  parseTreasuryXdr,
  type TreasuryEnvelopePolicy,
} from "../src/services/treasury-stellar";
import {
  STATUS,
  treasurySignaturesService,
} from "../src/services/treasury-signatures";

const treasury = Keypair.random();
const outsider = Keypair.random();
const admin1 = Keypair.random();
const admin2 = Keypair.random();
const destination = Keypair.random().publicKey();

const GROUP_ID = "group_1";
const PROPOSAL_ID = "proposal_1";

/** Every rule is checked against the treasury account configured for the group. */
const policy: TreasuryEnvelopePolicy = {
  treasuryAccountPublicKey: treasury.publicKey(),
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * Build a real envelope for the inspection tests.
 *
 * Defaults produce the envelope this API itself would build for a treasury
 * payment: sourced from the treasury, one payment operation, the fee band the
 * payment path uses, and a 300-second window that has not lapsed.
 */
function envelope(
  opts: {
    /** Public key the envelope is sourced from. Defaults to the treasury. */
    source?: string;
    /** Fee per operation, in stroops. Defaults to the 2 x base this API builds. */
    fee?: string;
    /** Operation count, or explicit operations. Defaults to one payment. */
    operations?: number | StellarOperation[];
    /** Validity window; `undefined` is the default 300s from now. */
    timeBounds?: { minTime: number; maxTime: number };
  } = {}
): string {
  const operations = Array.isArray(opts.operations)
    ? opts.operations
    : Array.from({ length: opts.operations ?? 1 }, () => paymentOperation());
  const builder = new TransactionBuilder(
    new Account(opts.source ?? treasury.publicKey(), "1"),
    {
      // The builder takes a per-operation fee; the decoded envelope exposes the
      // total (per-op x operation count), which is what the policy compares.
      fee: opts.fee ?? "200",
      networkPassphrase: config.networkPassphrase,
      // `timebounds` is the builder's option name; the decoded transaction
      // exposes the same window as `timeBounds`.
      timebounds: opts.timeBounds ?? {
        minTime: 0,
        maxTime: nowSeconds() + 300,
      },
    }
  );

  for (const operation of operations) builder.addOperation(operation);
  return builder.addMemo(Memo.text("MP:SEEDGRANT2")).build().toXDR();
}

function paymentOperation(
  overrides: { source?: string; destination?: string; amount?: string } = {}
): StellarOperation {
  return Operation.payment({
    destination: overrides.destination ?? destination,
    asset: new Asset("XLM"),
    amount: overrides.amount ?? "10.0000000",
    ...(overrides.source ? { source: overrides.source } : {}),
  });
}

/** Decode an envelope back into the SDK transaction the policy receives. */
function decode(xdr: string): Transaction {
  const parsed = TransactionBuilder.fromXDR(xdr, config.networkPassphrase);
  if (parsed instanceof FeeBumpTransaction) {
    throw new Error("Test helper expects a transaction envelope, not a fee bump");
  }
  return parsed;
}

/** Run `fn` and return the `AppError` it raised, failing if it raised none. */
function thrownAppError(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    expect(error, `expected an AppError, got ${String(error)}`).toBeInstanceOf(
      AppError
    );
    return error as AppError;
  }
  throw new Error("Expected the call to throw an AppError, but it returned");
}

/** Assert a 400 `XDR_MISMATCH` carrying the `details.rule` that rejected the envelope. */
function expectRejectedByRule(fn: () => unknown, rule: string): AppError {
  const error = thrownAppError(fn);
  expect(error.status).toBe(400);
  expect(error.code).toBe("XDR_MISMATCH");
  expect(error.details).toMatchObject({ rule });
  return error;
}

describe("parseTreasuryXdr", () => {
  it("decodes a well-formed envelope for the configured network", () => {
    const tx = parseTreasuryXdr(envelope());

    expect(tx).toBeInstanceOf(Transaction);
    expect(tx.source).toBe(treasury.publicKey());
    expect(tx.operations).toHaveLength(1);
  });

  it("raises xdr_malformed for input that is not a transaction envelope", () => {
    const error = thrownAppError(() => parseTreasuryXdr("not-an-envelope"));

    expect(error.status).toBe(400);
    expect(error.code).toBe("XDR_MALFORMED");
    expect(error.message).toBe("Could not parse transaction XDR");
  });

  it("uses the caller's message for an unparseable envelope", () => {
    const error = thrownAppError(() =>
      parseTreasuryXdr("", "Could not parse signed XDR")
    );

    expect(error.code).toBe("XDR_MALFORMED");
    expect(error.message).toBe("Could not parse signed XDR");
  });

  it("rejects a fee-bump envelope, whose payer the treasury policy cannot see", () => {
    const inner = decode(envelope());
    inner.sign(treasury);
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      outsider.publicKey(),
      "200",
      inner,
      config.networkPassphrase
    );

    const error = expectRejectedByRule(
      () => parseTreasuryXdr(feeBump.toXDR()),
      "fee_bump"
    );
    expect(error.message).toBe("Fee-bump transaction envelopes are not accepted");
  });

  it("parses a signed envelope as readily as an unsigned one", () => {
    const signedXdr = (() => {
      const tx = decode(envelope());
      tx.sign(treasury);
      return tx.toXDR();
    })();

    expect(parseTreasuryXdr(signedXdr).signatures).toHaveLength(1);
  });
});

describe("assertTreasuryEnvelopePolicy", () => {
  it("accepts the envelope this API would build for a treasury payment", () => {
    const inspection = assertTreasuryEnvelopePolicy(decode(envelope()), policy);

    expect(inspection.operationTypes).toEqual(["payment"]);
    expect(inspection.feeStroops).toBe(200);
    expect(inspection.tx.source).toBe(treasury.publicKey());
  });

  it("accepts a muxed (M...) payment destination", () => {
    // A treasury payment may legitimately pay a sub-account, so the rule that
    // names the destination accepts both account key forms.
    const recipient = Keypair.random();
    const muxed = StrKey.encodeMed25519PublicKey(
      // A med25519 address is the 32-byte ed25519 key plus an 8-byte id.
      Buffer.concat([recipient.rawPublicKey(), Buffer.alloc(8)])
    );
    const xdr = envelope({
      operations: [paymentOperation({ destination: muxed })],
    });

    // The SDK decodes a muxed destination back into its `M...` string form, so
    // that is the value the rule actually inspects.
    const decoded = decode(xdr).operations[0] as unknown as {
      type: string;
      destination: string;
    };
    expect(decoded.type).toBe("payment");
    expect(decoded.destination).toBe(muxed);
    expect(assertTreasuryEnvelopePolicy(decode(xdr), policy).operationTypes).toEqual(
      ["payment"]
    );
  });

  it("rejects an envelope sourced from an account that is not the treasury", () => {
    const error = expectRejectedByRule(
      () => assertTreasuryEnvelopePolicy(decode(envelope({ source: outsider.publicKey() })), policy),
      "source_account"
    );
    expect(error.message).toBe(
      "Transaction source must be the group's treasury account"
    );
  });

  it("rejects an operation re-sourced to a foreign account", () => {
    const xdr = envelope({
      operations: [paymentOperation({ source: outsider.publicKey() })],
    });

    const error = expectRejectedByRule(
      () => assertTreasuryEnvelopePolicy(decode(xdr), policy),
      "operation_source"
    );
    expect(error.details).toMatchObject({
      rule: "operation_source",
      index: 0,
      operationSource: outsider.publicKey(),
    });
  });

  it("accepts an operation explicitly sourced from the treasury itself", () => {
    const xdr = envelope({
      operations: [paymentOperation({ source: treasury.publicKey() })],
    });

    expect(assertTreasuryEnvelopePolicy(decode(xdr), policy).feeStroops).toBe(200);
  });

  it("accepts an envelope at the operation cap", () => {
    const xdr = envelope({ operations: MAX_TREASURY_OPERATIONS });

    const inspection = assertTreasuryEnvelopePolicy(decode(xdr), policy);
    expect(inspection.operationTypes).toHaveLength(MAX_TREASURY_OPERATIONS);
    expect(inspection.feeStroops).toBe(MAX_TREASURY_OPERATIONS * 200);
  });

  it("rejects an envelope one operation past the cap, and reports the bound", () => {
    const xdr = envelope({ operations: MAX_TREASURY_OPERATIONS + 1 });

    const error = expectRejectedByRule(
      () => assertTreasuryEnvelopePolicy(decode(xdr), policy),
      "operations"
    );
    expect(error.details).toMatchObject({
      operations: MAX_TREASURY_OPERATIONS + 1,
      maxOperations: MAX_TREASURY_OPERATIONS,
    });
  });

  it("honours a caller-supplied operation bound", () => {
    const xdr = envelope({ operations: 3 });

    expectRejectedByRule(
      () =>
        assertTreasuryEnvelopePolicy(decode(xdr), { ...policy, maxOperations: 2 }),
      "operations"
    );
    expect(assertTreasuryEnvelopePolicy(decode(xdr), { ...policy, maxOperations: 3 }).feeStroops).toBe(600);
  });

  it("rejects a fee below the network minimum for its operations", () => {
    // The SDK will encode any fee it can represent, so a 50-stroop envelope for
    // one operation is a real transaction — and a real one that can never
    // land on-ledger.
    const error = expectRejectedByRule(
      () =>
        assertTreasuryEnvelopePolicy(decode(envelope({ fee: "50" })), policy),
      "fee"
    );
    expect(error.details).toMatchObject({ feeStroops: 50, minFeeStroops: 100 });
  });

  it("rejects a fee above what the treasury may pay, and reports the ceiling", () => {
    const error = expectRejectedByRule(
      () =>
        assertTreasuryEnvelopePolicy(decode(envelope({ fee: "300" })), policy),
      "fee"
    );
    expect(error.message).toBe(
      "Transaction fee exceeds what this treasury proposal may pay"
    );
    expect(error.details).toMatchObject({ feeStroops: 300, maxFeeStroops: 200 });
  });

  it("scales the fee ceiling by the operation count", () => {
    // 3 operations: accepted total is 200 x 3 = 600 stroops.
    expect(
      assertTreasuryEnvelopePolicy(decode(envelope({ operations: 3 })), policy).feeStroops
    ).toBe(600);
    expectRejectedByRule(
      () =>
        assertTreasuryEnvelopePolicy(
          decode(envelope({ operations: 3, fee: "250" })),
          policy
        ),
      "fee"
    );
  });

  it("honours a caller-supplied fee ceiling", () => {
    const xdr = envelope({ fee: "300" });

    expect(assertTreasuryEnvelopePolicy(decode(xdr), { ...policy, maxFeeStroops: 500 }).feeStroops).toBe(300);
  });

  it("reports the fee rule before the window rule when both fail", () => {
    // Ordering matters for support: an over-charged, expired envelope is a fee
    // problem the signers approved, and the cheaper check runs first.
    const xdr = envelope({
      fee: "300",
      timeBounds: { minTime: 0, maxTime: nowSeconds() - 60 },
    });

    expectRejectedByRule(
      () => assertTreasuryEnvelopePolicy(decode(xdr), policy),
      "fee"
    );
  });

  it("rejects an envelope with no expiring window", () => {
    const error = thrownAppError(() =>
      assertTreasuryEnvelopePolicy(
        decode(envelope({ timeBounds: { minTime: 0, maxTime: 0 } })),
        policy
      )
    );

    expect(error.status).toBe(400);
    expect(error.code).toBe("XDR_MISMATCH");
    expect(error.message).toBe(
      "Signed transaction must declare a time bound that expires"
    );
    // The shared time-bounds check owns this error, so it carries no `rule`.
    expect(error.details).toBeUndefined();
  });

  it("rejects an envelope whose window has already lapsed", () => {
    // This is the case a stored proposal ages into: created in time, signed
    // after the deadline. Caught here rather than as tx_too_late at Horizon.
    const xdr = envelope({
      timeBounds: { minTime: 0, maxTime: nowSeconds() - 60 },
    });

    const error = thrownAppError(() =>
      assertTreasuryEnvelopePolicy(decode(xdr), policy)
    );
    expect(error.status).toBe(400);
    expect(error.code).toBe("INTENT_EXPIRED");
    expect(error.message).toContain("treasury transaction");
    expect(error.details).toMatchObject({ clockSkewToleranceSeconds: 30 });
  });

  it("rejects an envelope that is not valid yet", () => {
    const xdr = envelope({
      timeBounds: {
        minTime: nowSeconds() + 3600,
        maxTime: nowSeconds() + 7200,
      },
    });

    const error = thrownAppError(() =>
      assertTreasuryEnvelopePolicy(decode(xdr), policy)
    );
    expect(error.code).toBe("XDR_MISMATCH");
    expect(error.message).toBe("Signed transaction is not valid yet");
  });

  it("accepts a window inside the clock-skew tolerance", () => {
    const xdr = envelope({
      timeBounds: { minTime: 0, maxTime: nowSeconds() - 10 },
    });

    expect(assertTreasuryEnvelopePolicy(decode(xdr), policy).feeStroops).toBe(200);
  });

  // The SDK validates operation payloads at build time, so these three shapes
  // cannot be encoded into a real envelope. They are the guard's own logic: the
  // decoded operation is typed loosely on purpose (`TreasuryOperation`), so a
  // future decoder, or a differently-encoded envelope, must still be refused.
  describe("against decoded operations the SDK refuses to build", () => {
    const loose = (fields: Record<string, unknown>): Transaction =>
      ({
        source: treasury.publicKey(),
        fee: "200",
        operations: [],
        timeBounds: { minTime: "0", maxTime: String(nowSeconds() + 300) },
        ...fields,
      }) as unknown as Transaction;

    it("rejects an envelope with no operations at all", () => {
      expectRejectedByRule(
        () => assertTreasuryEnvelopePolicy(loose({}), policy),
        "operations"
      );
    });

    it("rejects a payment whose amount is not positive", () => {
      for (const amount of ["0", "0.0000000", "-1", "1e7", " 10"]) {
        const error = expectRejectedByRule(
          () =>
            assertTreasuryEnvelopePolicy(
              loose({ operations: [{ type: "payment", amount, destination }] }),
              policy
            ),
          "operation_amount"
        );
        expect(error.details).toMatchObject({ rule: "operation_amount", amount });
      }
    });

    it("rejects a payment that names no valid destination account", () => {
      for (const dest of ["", "GNOTAVALIDSTELLARACCOUNT", destination + "x"]) {
        expectRejectedByRule(
          () =>
            assertTreasuryEnvelopePolicy(
              loose({
                operations: [{ type: "payment", amount: "10.0000000", destination: dest }],
              }),
              policy
            ),
          "operation_destination"
        );
      }
    });

    it("leaves an operation with no amount and no destination alone", () => {
      // Only payment-shaped operations carry an amount, and only the
      // account-destination operation types name a destination; a changeTrust
      // or manageData operation must not be rejected for what it lacks.
      const inspection = assertTreasuryEnvelopePolicy(
        loose({ operations: [{ type: "manageData" }, { type: "bumpSequence" }] }),
        policy
      );
      expect(inspection.operationTypes).toEqual(["manageData", "bumpSequence"]);
    });

    it("reports an operation whose type the decoder did not name", () => {
      const inspection = assertTreasuryEnvelopePolicy(
        loose({ operations: [{}] }),
        policy
      );
      expect(inspection.operationTypes).toEqual(["unknown"]);
    });
  });
});

describe("inspectTreasuryXdr", () => {
  it("decodes and inspects in one call", () => {
    const xdr = envelope();
    const inspection = inspectTreasuryXdr(xdr, policy);

    expect(inspection.tx.hash()).toEqual(decode(xdr).hash());
    expect(inspection.operationTypes).toEqual(["payment"]);
  });

  it("surfaces the parse error for unparseable input", () => {
    expect(thrownAppError(() => inspectTreasuryXdr("nonsense", policy)).code).toBe(
      "XDR_MALFORMED"
    );
  });

  it("surfaces the policy rule for a compliant-looking but foreign envelope", () => {
    expectRejectedByRule(
      () => inspectTreasuryXdr(envelope({ source: outsider.publicKey() }), policy),
      "source_account"
    );
  });
});

describe("the signature collector applies the policy before any state change", () => {
  let storedProposal: any;
  let storedSignatures: any[];

  /** Persist a proposal row directly, bypassing `createProposal`. */
  function seedProposal(overrides: Record<string, unknown> = {}) {
    const xdr = envelope();
    storedProposal = {
      id: PROPOSAL_ID,
      groupId: GROUP_ID,
      creatorId: "creator_1",
      xdr,
      txHash: decode(xdr).hash().toString("hex"),
      sourceAccount: treasury.publicKey(),
      requiredWeight: 10,
      status: STATUS.pendingSignatures,
      stellarTxHash: null,
      failureReason: null,
      ...overrides,
    };
    return storedProposal;
  }

  /** Sign a copy of the stored envelope, as a wallet returning it would. */
  function signStored(...keys: Keypair[]): string {
    const tx = decode(storedProposal.xdr as string);
    tx.sign(...keys);
    return tx.toXDR();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    storedSignatures = [];
    storedProposal = null;

    (prisma.group.findUnique as any).mockResolvedValue({
      id: GROUP_ID,
      treasuryEnabled: true,
      treasuryAccountPublicKey: treasury.publicKey(),
    });
    (prisma.treasuryTxProposal.findUnique as any).mockImplementation(
      async ({ where }: any) =>
        storedProposal && where.id === storedProposal.id
          ? { ...storedProposal }
          : null
    );
    (prisma.treasuryTxProposal.create as any).mockImplementation(
      async ({ data }: any) => {
        storedProposal = { id: PROPOSAL_ID, ...data };
        return storedProposal;
      }
    );
    (prisma.treasuryTxProposal.update as any).mockImplementation(
      async ({ data }: any) => {
        storedProposal = { ...storedProposal, ...data };
        return storedProposal;
      }
    );
    (prisma.treasurySignature.findMany as any).mockImplementation(
      async ({ where }: any) =>
        storedSignatures.filter((s) => s.proposalId === where.proposalId)
    );
    (prisma.treasurySignature.create as any).mockImplementation(
      async ({ data }: any) => {
        const row = { id: `sig_${storedSignatures.length + 1}`, createdAt: new Date(), ...data };
        storedSignatures.push(row);
        return row;
      }
    );
    (prisma.groupMember.findMany as any).mockResolvedValue([
      { userId: "admin1", user: { stellarPublicKey: admin1.publicKey() } },
      { userId: "admin2", user: { stellarPublicKey: admin2.publicKey() } },
    ]);
    (prisma.auditLog.create as any).mockResolvedValue({});

    vi.spyOn(stellar, "loadAccount").mockResolvedValue({
      exists: true,
      sequence: "1",
      balances: [],
      signers: [
        { key: admin1.publicKey(), weight: 5 },
        { key: admin2.publicKey(), weight: 6 },
      ],
      thresholds: { low: 1, med: 5, high: 10 },
    } as any);
    vi.spyOn(stellar, "submitSigned").mockResolvedValue("stellar_hash_1");
  });

  it("accepts a compliant unsigned envelope and stores it", async () => {
    const { proposal } = await treasurySignaturesService.createProposal({
      groupId: GROUP_ID,
      creatorId: "creator_1",
      xdr: envelope(),
    });

    expect(proposal.sourceAccount).toBe(treasury.publicKey());
    expect(prisma.treasuryTxProposal.create).toHaveBeenCalledTimes(1);
  });

  it("refuses an out-of-policy envelope before loading the treasury account", async () => {
    // The policy runs first, so a rejected proposal costs no Horizon read, no
    // proposal row and no audit row.
    const error = await thrownAppErrorAsync(() =>
      treasurySignaturesService.createProposal({
        groupId: GROUP_ID,
        creatorId: "creator_1",
        xdr: envelope({ fee: "300" }),
      })
    );

    expect(error.code).toBe("XDR_MISMATCH");
    expect(error.details).toMatchObject({ rule: "fee" });
    expect(stellar.loadAccount).not.toHaveBeenCalled();
    expect(prisma.treasuryTxProposal.create).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("refuses an envelope sourced from another account without writing a row", async () => {
    const error = await thrownAppErrorAsync(() =>
      treasurySignaturesService.createProposal({
        groupId: GROUP_ID,
        creatorId: "creator_1",
        xdr: envelope({ source: outsider.publicKey() }),
      })
    );

    expect(error.details).toMatchObject({ rule: "source_account" });
    expect(prisma.treasuryTxProposal.create).not.toHaveBeenCalled();
  });

  it("refuses an unbounded envelope without writing a row", async () => {
    const error = await thrownAppErrorAsync(() =>
      treasurySignaturesService.createProposal({
        groupId: GROUP_ID,
        creatorId: "creator_1",
        xdr: envelope({ timeBounds: { minTime: 0, maxTime: 0 } }),
      })
    );

    expect(error.code).toBe("XDR_MISMATCH");
    expect(prisma.treasuryTxProposal.create).not.toHaveBeenCalled();
  });

  it("refuses a lapsed stored envelope before recording any signature weight", async () => {
    // A proposal accepted while its window was open, then signed after it
    // closed. The signature would verify and the weight would look like
    // progress, so the refusal must come before either.
    const lapsed = envelope({
      timeBounds: { minTime: 0, maxTime: nowSeconds() - 60 },
    });
    seedProposal({ xdr: lapsed, txHash: decode(lapsed).hash().toString("hex") });

    const error = await thrownAppErrorAsync(() =>
      treasurySignaturesService.submitSignature({
        proposalId: PROPOSAL_ID,
        groupId: GROUP_ID,
        userId: "admin1",
        signedXdr: signStored(admin1),
      })
    );

    expect(error.code).toBe("INTENT_EXPIRED");
    expect(prisma.treasurySignature.create).not.toHaveBeenCalled();
    expect(stellar.submitSigned).not.toHaveBeenCalled();
    expect(storedProposal.status).toBe(STATUS.pendingSignatures);
  });

  it("refuses a stored envelope that predates the policy, without recording weight", async () => {
    seedProposal({
      xdr: envelope({ fee: "300" }),
      txHash: decode(envelope({ fee: "300" })).hash().toString("hex"),
    });

    const error = await thrownAppErrorAsync(() =>
      treasurySignaturesService.submitSignature({
        proposalId: PROPOSAL_ID,
        groupId: GROUP_ID,
        userId: "admin1",
        signedXdr: signStored(admin1),
      })
    );

    expect(error.code).toBe("XDR_MISMATCH");
    expect(error.details).toMatchObject({ rule: "fee" });
    expect(prisma.treasurySignature.create).not.toHaveBeenCalled();
    expect(stellar.submitSigned).not.toHaveBeenCalled();
  });

  it("still records a signature on a compliant stored envelope", async () => {
    seedProposal();

    const result = await treasurySignaturesService.submitSignature({
      proposalId: PROPOSAL_ID,
      groupId: GROUP_ID,
      userId: "admin1",
      signedXdr: signStored(admin1),
    });

    expect(result.totalWeight).toBe(5);
    expect(result.status).toBe(STATUS.pendingSignatures);
    expect(prisma.treasurySignature.create).toHaveBeenCalledTimes(1);
  });
});

/** `thrownAppError` for a promise — same contract, awaited. */
async function thrownAppErrorAsync(fn: () => Promise<unknown>): Promise<AppError> {
  try {
    await fn();
  } catch (error) {
    expect(error, `expected an AppError, got ${String(error)}`).toBeInstanceOf(
      AppError
    );
    return error as AppError;
  }
  throw new Error("Expected the call to reject with an AppError, but it resolved");
}
