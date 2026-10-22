/**
 * Issue #657 — treasury multisig proposal and co-signature routes.
 *
 * Covers `POST /treasury/propose` and `POST /treasury/:id/sign`
 * (src/routes/treasury-multisig.ts) end to end through `app.inject`, against a
 * fake Prisma client and a fake Horizon account snapshot, so no database or
 * network is needed:
 *
 *   1. proposal creation from an unsigned, treasury-sourced envelope, with the
 *      audit record that must accompany it;
 *   2. permission enforcement — only a group admin may propose or sign, and the
 *      group is taken from the stored proposal, never from the request;
 *   3. the "no private key material" rule: a secret sent alongside a proposal is
 *      never persisted, and a secret sent with a signature submission is refused;
 *   4. the threshold decision made against the account's *live* signer weights,
 *      both below and at threshold, plus rejection of a signature from a key that
 *      is not an authorized admin signer;
 *   5. the two routes being documented in the OpenAPI graph at /docs/json.
 *
 * The signature-verification and submission mechanics themselves belong to
 * `treasurySignaturesService` and are asserted here only as far as the routes
 * must depend on them.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  Asset,
  Keypair,
  Memo,
  Operation,
  Transaction,
  TransactionBuilder,
  Account,
} from "@stellar/stellar-sdk";
import { config } from "../src/config";

/**
 * Mutable fixtures the fakes read on every call, so one test can describe an
 * account whose signers carry weight 2 while the next describes weight 3.
 */
const h = vi.hoisted(() => {
  const state = {
    group: null as null | Record<string, unknown>,
    membership: null as null | { groupId: string; userId: string; role: string },
    /** Group admins as stored on the membership rows the service loads. */
    admins: [] as { userId: string; user: { stellarPublicKey: string } }[],
    proposal: null as null | Record<string, unknown>,
    signatures: [] as Record<string, unknown>[],
    auditRows: [] as Record<string, unknown>[],
    account: {
      exists: true,
      signers: [] as { key: string; weight: number }[],
      thresholds: { low: 1, med: 1, high: 2 },
    },
    submittedXdrs: [] as string[],
  };

  const prisma: any = {
    group: { findUnique: vi.fn(async () => state.group) },
    groupMember: {
      findUnique: vi.fn(async () => state.membership),
      findMany: vi.fn(async () => state.admins),
    },
    treasuryTxProposal: {
      create: vi.fn(async ({ data }: any) => {
        state.proposal = {
          id: "ttp_1",
          failureReason: null,
          stellarTxHash: null,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          ...data,
        };
        return state.proposal;
      }),
      findUnique: vi.fn(async () =>
        state.proposal
          ? { ...state.proposal, signatures: state.signatures }
          : null
      ),
      update: vi.fn(async ({ data }: any) => {
        state.proposal = { ...state.proposal, ...data };
        return state.proposal;
      }),
    },
    treasurySignature: {
      create: vi.fn(async ({ data }: any) => {
        state.signatures.push({
          id: `sig_${state.signatures.length + 1}`,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          ...data,
        });
        return data;
      }),
      findMany: vi.fn(async () => state.signatures),
    },
    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        state.auditRows.push(data);
        return data;
      }),
    },
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
  };

  return { prisma, state };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

vi.mock("../src/services/stellar", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/stellar")>();
  return {
    ...actual,
    stellar: {
      ...actual.stellar,
      loadAccount: vi.fn(async () => ({
        exists: h.state.account.exists,
        sequence: "12345",
        balances: [],
        signers: h.state.account.signers,
        thresholds: h.state.account.thresholds,
      })),
      buildPayment: vi.fn(),
      submitPayment: vi.fn(),
      submitMultisigPayment: vi.fn(),
      submitSigned: vi.fn(async (xdr: string) => {
        h.state.submittedXdrs.push(xdr);
        return "submitted-tx-hash-abc";
      }),
    },
  };
});

vi.mock("@stellar/stellar-sdk", async (importActual) => {
  const actual = await importActual<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    Horizon: {
      Server: vi.fn().mockImplementation(() => ({ fetchBaseFee: vi.fn() })),
    },
  };
});

import { buildApp } from "../src/app";
import { signToken } from "../src/plugins/auth";
import { treasurySignatureSubmitSchema } from "../src/validations/treasury";

const state = h.state;
let app: Awaited<ReturnType<typeof buildApp>>;

const treasury = Keypair.random();
const adminKp = Keypair.random();
const secondAdminKp = Keypair.random();
const outsiderKp = Keypair.random();

const admin = {
  id: "admin_1",
  stellarPublicKey: adminKp.publicKey(),
};
const secondAdmin = {
  id: "admin_2",
  stellarPublicKey: secondAdminKp.publicKey(),
};
const outsider = {
  id: "member_1",
  stellarPublicKey: outsiderKp.publicKey(),
};

function authHeader(user: { id: string; stellarPublicKey: string }) {
  return {
    authorization: `Bearer ${signToken({
      id: user.id,
      stellarPublicKey: user.stellarPublicKey,
    })}`,
  };
}

/** An unsigned payment sourced from `source`, built the way a signer would. */
function buildTx(source: string, amount = "5"): Transaction {
  return new TransactionBuilder(new Account(source, "1"), {
    fee: "100",
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount,
      })
    )
    .addMemo(Memo.text("MP:657"))
    .setTimeout(300)
    .build();
}

function unsignedXdr(source = treasury.publicKey(), amount?: string): string {
  return buildTx(source, amount).toXDR();
}

/** The same envelope as stored on the proposal, plus the supplied signatures. */
function signedXdrFor(proposalTx: Transaction, signers: Keypair[]): string {
  const copy = new Transaction(proposalTx.toXDR(), config.networkPassphrase);
  for (const kp of signers) copy.sign(kp);
  return copy.toXDR();
}

function seedTreasuryGroup() {
  state.group = {
    id: "group_1",
    archived: false,
    treasuryEnabled: true,
    treasuryAccountPublicKey: treasury.publicKey(),
    treasuryRequiredSigners: 2,
  };
}

function seedAdminMembership(user = admin) {
  state.membership = { groupId: "group_1", userId: user.id, role: "admin" };
  state.admins = [{ userId: user.id, user: { stellarPublicKey: user.stellarPublicKey } }];
}

/** Make the stored unsigned envelope retrievable as a pending proposal. */
function seedPendingProposal(tx: Transaction, creatorId = admin.id) {
  state.proposal = {
    id: "ttp_1",
    groupId: "group_1",
    creatorId,
    xdr: tx.toXDR(),
    description: null,
    txHash: tx.hash().toString("hex"),
    sourceAccount: treasury.publicKey(),
    requiredWeight: state.account.thresholds.high,
    status: "PENDING_SIGNATURES",
    stellarTxHash: null,
    failureReason: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function auditActions(): string[] {
  return state.auditRows.map((row) => String(row.action));
}

beforeEach(async () => {
  state.group = null;
  state.membership = null;
  state.admins = [];
  state.proposal = null;
  state.signatures = [];
  state.auditRows = [];
  state.account = {
    exists: true,
    signers: [
      { key: adminKp.publicKey(), weight: 2 },
      { key: secondAdminKp.publicKey(), weight: 2 },
    ],
    thresholds: { low: 1, med: 1, high: 2 },
  };
  state.submittedXdrs = [];
  vi.clearAllMocks();
  if (!app) app = await buildApp();
});

describe("POST /treasury/propose", () => {
  it("stores an unsigned treasury-sourced envelope as a pending proposal and audits it", async () => {
    seedTreasuryGroup();
    seedAdminMembership();

    const res = await app.inject({
      method: "POST",
      url: "/treasury/propose",
      headers: authHeader(admin),
      payload: {
        treasuryId: "group_1",
        xdr: unsignedXdr(),
        description: "Pay the March vendor invoice",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.proposal.status).toBe("PENDING_SIGNATURES");
    expect(body.proposal.id).toBe("ttp_1");
    expect(body.proposal.sourceAccount).toBe(treasury.publicKey());
    expect(body.proposal.groupId).toBe("group_1");
    // The threshold is the treasury account's live high threshold, not a
    // number the caller supplied.
    expect(body.proposal.requiredWeight).toBe(2);
    expect(body.networkPassphrase).toBe(config.networkPassphrase);

    expect(state.auditRows).toHaveLength(1);
    expect(state.auditRows[0]).toMatchObject({
      action: "treasury.tx_proposal.created",
      groupId: "group_1",
      userId: admin.id,
      entityType: "treasury_tx_proposal",
      entityId: "ttp_1",
      // auditData() records the actor's public key inside metadata, never as a
      // column, and the writer keeps it out of the payload a client controls.
      metadata: { actorPublicKey: admin.stellarPublicKey },
    });
  });

  it("accepts the legacy groupId alias and never persists key material sent with it", async () => {
    seedTreasuryGroup();
    seedAdminMembership();
    const leakedSecret = treasury.secret();

    const res = await app.inject({
      method: "POST",
      url: "/treasury/propose",
      headers: authHeader(admin),
      payload: {
        groupId: "group_1",
        xdr: unsignedXdr(),
        secret: leakedSecret,
      },
    });

    expect(res.statusCode).toBe(200);
    const stored = h.prisma.treasuryTxProposal.create.mock.calls[0][0].data;
    expect(stored.groupId).toBe("group_1");
    // Unknown fields are stripped by the schema, so a stray secret cannot reach
    // the row — and the stored envelope is the caller's unsigned XDR only.
    expect(JSON.stringify(stored)).not.toContain(leakedSecret);
    expect(Object.keys(stored).sort()).toEqual(
      ["creatorId", "description", "groupId", "requiredWeight", "sourceAccount", "status", "txHash", "xdr"].sort()
    );
  });

  it("rejects a proposal from a group member who is not an admin", async () => {
    seedTreasuryGroup();
    state.membership = { groupId: "group_1", userId: outsider.id, role: "member" };

    const res = await app.inject({
      method: "POST",
      url: "/treasury/propose",
      headers: authHeader(outsider),
      payload: { treasuryId: "group_1", xdr: unsignedXdr() },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
    expect(h.prisma.treasuryTxProposal.create).not.toHaveBeenCalled();
  });

  it("rejects a caller who is not a member of the treasury group at all", async () => {
    seedTreasuryGroup();
    state.membership = null;

    const res = await app.inject({
      method: "POST",
      url: "/treasury/propose",
      headers: authHeader(outsider),
      payload: { treasuryId: "group_1", xdr: unsignedXdr() },
    });

    expect(res.statusCode).toBe(403);
    expect(h.prisma.treasuryTxProposal.create).not.toHaveBeenCalled();
  });

  it("rejects a body with no XDR at all", async () => {
    seedTreasuryGroup();
    seedAdminMembership();

    const res = await app.inject({
      method: "POST",
      url: "/treasury/propose",
      headers: authHeader(admin),
      payload: { treasuryId: "group_1" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(res.json().error.message).toContain("xdr");
  });

  it("rejects an XDR that does not decode", async () => {
    seedTreasuryGroup();
    seedAdminMembership();

    const res = await app.inject({
      method: "POST",
      url: "/treasury/propose",
      headers: authHeader(admin),
      payload: { treasuryId: "group_1", xdr: "not-a-stellar-envelope" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(h.prisma.treasuryTxProposal.create).not.toHaveBeenCalled();
  });

  it("rejects a body that names no treasury", async () => {
    seedTreasuryGroup();
    seedAdminMembership();

    const res = await app.inject({
      method: "POST",
      url: "/treasury/propose",
      headers: authHeader(admin),
      payload: { xdr: unsignedXdr() },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("treasuryId");
  });

  it("rejects an envelope sourced from an account other than the group treasury", async () => {
    seedTreasuryGroup();
    seedAdminMembership();

    const res = await app.inject({
      method: "POST",
      url: "/treasury/propose",
      headers: authHeader(admin),
      payload: { treasuryId: "group_1", xdr: unsignedXdr(outsiderKp.publicKey()) },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("XDR_MISMATCH");
  });

  it("rejects an envelope that already carries a signature", async () => {
    seedTreasuryGroup();
    seedAdminMembership();

    const res = await app.inject({
      method: "POST",
      url: "/treasury/propose",
      headers: authHeader(admin),
      payload: {
        treasuryId: "group_1",
        xdr: signedXdrFor(buildTx(treasury.publicKey()), [adminKp]),
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("XDR_NOT_UNSIGNED");
  });

  it("rejects a proposal for a group whose treasury is disabled", async () => {
    seedTreasuryGroup();
    state.group = { ...state.group!, treasuryEnabled: false };
    seedAdminMembership();

    const res = await app.inject({
      method: "POST",
      url: "/treasury/propose",
      headers: authHeader(admin),
      payload: { treasuryId: "group_1", xdr: unsignedXdr() },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("TREASURY_DISABLED");
  });

  it("requires a bearer token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/treasury/propose",
      payload: { treasuryId: "group_1", xdr: unsignedXdr() },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
  });
});

describe("POST /treasury/:id/sign", () => {
  it("submits the merged transaction once the live signer weight reaches the threshold", async () => {
    seedTreasuryGroup();
    seedAdminMembership();
    const tx = buildTx(treasury.publicKey());
    seedPendingProposal(tx);

    const res = await app.inject({
      method: "POST",
      url: "/treasury/ttp_1/sign",
      headers: authHeader(admin),
      payload: { signedXdr: signedXdrFor(tx, [adminKp]) },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("SUBMITTED");
    expect(body.totalWeight).toBe(2);
    expect(body.requiredWeight).toBe(2);
    expect(body.stellarTxHash).toBe("submitted-tx-hash-abc");
    expect(body.proposal.status).toBe("SUBMITTED");
    expect(body.proposal.signatures).toHaveLength(1);

    expect(state.submittedXdrs).toHaveLength(1);
    expect(auditActions()).toEqual(
      expect.arrayContaining([
        "treasury.tx_proposal.signature_added",
        "treasury.tx_proposal.ready",
        "treasury.tx_proposal.submitted",
      ])
    );
  });

  it("leaves the proposal pending while collected weight is below the threshold", async () => {
    seedTreasuryGroup();
    seedAdminMembership();
    state.account.thresholds = { low: 1, med: 1, high: 3 };
    const tx = buildTx(treasury.publicKey());
    seedPendingProposal(tx);

    const res = await app.inject({
      method: "POST",
      url: "/treasury/ttp_1/sign",
      headers: authHeader(admin),
      payload: { signedXdr: signedXdrFor(tx, [adminKp]) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("PENDING_SIGNATURES");
    expect(res.json().totalWeight).toBe(2);
    expect(res.json().requiredWeight).toBe(3);
    expect(res.json().stellarTxHash).toBeNull();
    expect(state.submittedXdrs).toHaveLength(0);
    expect(auditActions()).toEqual(["treasury.tx_proposal.signature_added"]);
  });

  it("refuses a submission that carries key material instead of only a signed envelope", async () => {
    seedTreasuryGroup();
    seedAdminMembership();
    const tx = buildTx(treasury.publicKey());
    seedPendingProposal(tx);

    const res = await app.inject({
      method: "POST",
      url: "/treasury/ttp_1/sign",
      headers: authHeader(admin),
      payload: { signedXdr: signedXdrFor(tx, [adminKp]), secret: treasury.secret() },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(res.json().error.details[0]).toMatchObject({ field: "secret" });
    // Rejected before any lookup: the backend never even opens the proposal.
    expect(h.prisma.treasuryTxProposal.findUnique).not.toHaveBeenCalled();
    expect(h.prisma.treasurySignature.create).not.toHaveBeenCalled();
  });

  it("rejects an envelope that does not hash to the stored proposal", async () => {
    seedTreasuryGroup();
    seedAdminMembership();
    const tx = buildTx(treasury.publicKey());
    seedPendingProposal(tx);
    const different = buildTx(treasury.publicKey(), "9");

    const res = await app.inject({
      method: "POST",
      url: "/treasury/ttp_1/sign",
      headers: authHeader(admin),
      payload: { signedXdr: signedXdrFor(different, [adminKp]) },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("XDR_MISMATCH");
    expect(h.prisma.treasurySignature.create).not.toHaveBeenCalled();
  });

  it("rejects an envelope signed by a key that is not an authorized admin signer", async () => {
    seedTreasuryGroup();
    seedAdminMembership();
    const tx = buildTx(treasury.publicKey());
    seedPendingProposal(tx);

    const res = await app.inject({
      method: "POST",
      url: "/treasury/ttp_1/sign",
      headers: authHeader(admin),
      payload: { signedXdr: signedXdrFor(tx, [outsiderKp]) },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("UNAUTHORIZED_SIGNER");
    expect(h.prisma.treasurySignature.create).not.toHaveBeenCalled();
    expect(state.submittedXdrs).toHaveLength(0);
  });

  it("ignores a signer whose on-chain weight was removed after the proposal was made", async () => {
    seedTreasuryGroup();
    seedAdminMembership();
    // The membership row still says admin, but the live account no longer
    // grants this key any signing weight.
    state.account.signers = [{ key: secondAdminKp.publicKey(), weight: 2 }];
    const tx = buildTx(treasury.publicKey());
    seedPendingProposal(tx);

    const res = await app.inject({
      method: "POST",
      url: "/treasury/ttp_1/sign",
      headers: authHeader(admin),
      payload: { signedXdr: signedXdrFor(tx, [adminKp]) },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("UNAUTHORIZED_SIGNER");
    expect(h.prisma.treasurySignature.create).not.toHaveBeenCalled();
  });

  it("forbids a group member who is not an admin from signing", async () => {
    seedTreasuryGroup();
    const tx = buildTx(treasury.publicKey());
    seedPendingProposal(tx);
    state.membership = { groupId: "group_1", userId: outsider.id, role: "member" };

    const res = await app.inject({
      method: "POST",
      url: "/treasury/ttp_1/sign",
      headers: authHeader(outsider),
      payload: { signedXdr: signedXdrFor(tx, [outsiderKp]) },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
    expect(h.prisma.treasurySignature.create).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown proposal id", async () => {
    seedTreasuryGroup();
    seedAdminMembership();
    state.proposal = null;

    const res = await app.inject({
      method: "POST",
      url: "/treasury/does_not_exist/sign",
      headers: authHeader(admin),
      payload: { signedXdr: signedXdrFor(buildTx(treasury.publicKey()), [adminKp]) },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("conflicts when the proposal has already been submitted", async () => {
    seedTreasuryGroup();
    seedAdminMembership();
    const tx = buildTx(treasury.publicKey());
    seedPendingProposal(tx);
    state.proposal = { ...state.proposal!, status: "SUBMITTED" };

    const res = await app.inject({
      method: "POST",
      url: "/treasury/ttp_1/sign",
      headers: authHeader(admin),
      payload: { signedXdr: signedXdrFor(tx, [adminKp]) },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("ALREADY_SUBMITTED");
  });

  it("requires a bearer token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/treasury/ttp_1/sign",
      payload: { signedXdr: signedXdrFor(buildTx(treasury.publicKey()), [adminKp]) },
    });

    expect(res.statusCode).toBe(401);
  });
});

describe("treasurySignatureSubmitSchema", () => {
  it("accepts only a signed envelope", () => {
    const ok = treasurySignatureSubmitSchema.safeParse({
      signedXdr: signedXdrFor(buildTx(treasury.publicKey()), [adminKp]),
    });
    expect(ok.success).toBe(true);
  });

  it.each([
    ["a secret key", { signedXdr: "abc", secret: treasury.secret() }],
    ["a seed", { signedXdr: "abc", seed: treasury.secret() }],
    ["a raw signature", { signedXdr: "abc", signature: "AAAA" }],
    ["no envelope", {}],
    ["an empty envelope", { signedXdr: "" }],
  ])("rejects %s", (_label, payload) => {
    expect(treasurySignatureSubmitSchema.safeParse(payload).success).toBe(false);
  });
});

describe("OpenAPI graph", () => {
  it("documents both treasury multisig routes", async () => {
    const res = await app.inject({ method: "GET", url: "/docs/json" });

    expect(res.statusCode).toBe(200);
    const paths = res.json().paths;
    expect(paths["/api/v1/treasury/propose"].post).toBeTruthy();
    expect(paths["/api/v1/treasury/{id}/sign"].post).toBeTruthy();
    expect(paths["/api/v1/treasury/propose"].post.tags).toContain("Treasury");
    expect(paths["/api/v1/treasury/{id}/sign"].post.responses).toEqual(
      expect.objectContaining({ "401": expect.anything(), "409": expect.anything() })
    );
  });
});
