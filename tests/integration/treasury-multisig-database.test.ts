/**
 * Issue #653 — the treasury multisig lifecycle run against a real Postgres.
 *
 * `tests/integration/treasury.test.ts` already exercises this service, but it
 * replaces `src/db` with a `vi.mock` object, so every "persisted" row is a value
 * the test handed back to itself. That shape cannot answer the questions this
 * file asks:
 *
 *   - is a refused proposal really absent — no `treasury_tx_proposals` row and
 *     no `treasury.tx_proposal.created` audit row either?
 *   - is a repeat signature idempotent because the `(proposal_id,
 *     signer_user_id)` unique index makes it so, or only because the service
 *     happens to skip it in memory?
 *   - when an unauthorized signature is refused partway through, does weight
 *     recorded earlier in that same request roll back with it?
 *   - do the `signature_added` / `ready` / `submitted` audit rows commit *with*
 *     the status they describe?
 *   - are the foreign keys the service relies on actually present in the schema
 *     the harness just deployed?
 *
 * So this file uses the real Prisma client, the real Fastify instance and the
 * real HTTP path. The only substitution is `src/services/stellar`
 * (`loadAccount`, `submitSigned`), which would otherwise reach Horizon —
 * CONTRIBUTING requires this suite to run with no network. Nothing on the
 * database path is stubbed, and envelopes are built by the product's own
 * `stellar.buildPayment`, so the policy checks run against bytes a real client
 * would send.
 *
 * Every test creates its own proposal: signature weight is per-proposal, so a
 * shared one would let an earlier test decide a later one's threshold.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Account, Asset, Keypair, Operation, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import type { FastifyInstance } from "fastify";

const h = vi.hoisted(() => ({
  /** The treasury account's live on-chain signer set, as Horizon would report it. */
  signers: [] as { key: string; weight: number }[],
  thresholds: { low: 1, med: 5, high: 10 },
  submitCalls: [] as string[],
  submitError: null as string | null,
  submitResult: "stellar-integration-hash",
}));

vi.mock("../../src/services/stellar", async (importActual) => {
  const actual = await importActual<typeof import("../../src/services/stellar")>();
  return {
    ...actual,
    stellar: {
      ...actual.stellar,
      loadAccount: vi.fn(async () => ({
        exists: true,
        sequence: "1",
        balances: [{ assetCode: "XLM", assetIssuer: null, balance: "10000.0000000" }],
        signers: h.signers,
        thresholds: h.thresholds,
      })),
      submitSigned: vi.fn(async (xdr: string) => {
        h.submitCalls.push(xdr);
        if (h.submitError) throw new Error(h.submitError);
        return h.submitResult;
      }),
    },
  };
});

import { buildApp } from "../../src/app";
import { config } from "../../src/config";
import { prisma } from "../../src/db";
import { signToken } from "../../src/plugins/auth";
import { MIN_FEE_STROOPS_PER_OP, stellar } from "../../src/services/stellar";

interface Actor {
  id: string;
  publicKey: string;
  token: string;
  keypair: Keypair;
}

const HIGH_THRESHOLD = 10;
/** Each signer carries half the threshold, so exactly two admins are needed. */
const SIGNER_WEIGHT = HIGH_THRESHOLD / 2;

let app: FastifyInstance;
let owner: Actor;
let adminA: Actor;
let adminB: Actor;
/** Has on-chain signing weight, but is only a plain `member` of the group. */
let weightedMember: Actor;
let outsider: Actor;

let groupId: string;
let treasury: string;
const destination = Keypair.random().publicKey();

let requestNumber = 0;

/**
 * A distinct source address per request. Rate-limit buckets key on it, so one
 * address for the whole suite would let its own volume decide whether a later
 * request is served or throttled.
 */
function remoteAddress(): string {
  requestNumber += 1;
  return `10.65.${Math.floor(requestNumber / 250) % 250}.${(requestNumber % 250) + 1}`;
}

async function createActor(displayName: string): Promise<Actor> {
  const keypair = Keypair.random();
  const user = await prisma.user.create({
    data: { stellarPublicKey: keypair.publicKey(), displayName },
    select: { id: true, stellarPublicKey: true },
  });
  return {
    id: user.id,
    publicKey: user.stellarPublicKey,
    keypair,
    token: signToken({ id: user.id, stellarPublicKey: keypair.publicKey() }),
  };
}

async function call(
  method: "GET" | "POST",
  url: string,
  actor: Actor | null,
  payload?: Record<string, unknown>
) {
  return app.inject({
    method,
    url,
    remoteAddress: remoteAddress(),
    headers: actor ? { authorization: `Bearer ${actor.token}` } : {},
    payload,
  });
}

/** An unsigned treasury payment, built exactly the way the product builds one. */
function unsignedXdr(memoCode = "MULTISIG-653"): string {
  return buildPayment(treasury, memoCode);
}

/**
 * The product's own builder, reached through the module the suite imports. The
 * `stellar` mock spreads the real implementation, so only `loadAccount` and
 * `submitSigned` are substituted — envelope bytes here are the bytes a client
 * would really send.
 */
function buildPayment(source: string, memoCode: string, amount = "10", sequence = "1"): string {
  return stellar.buildPayment({
    sourcePublicKey: source,
    sourceSequence: sequence,
    destination,
    asset: { code: "XLM", issuer: null },
    amount,
    memoCode,
  });
}

/**
 * The same payment with a caller-chosen fee, so the fee band can be probed
 * without the product's builder normalising it away. `setTimeout` supplies the
 * expiry the policy requires, so this envelope differs in exactly one way.
 */
function rawEnvelope(opts: { source: string; feeStroops: number }): string {
  return new TransactionBuilder(new Account(opts.source, "1"), {
    fee: String(opts.feeStroops),
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination,
        asset: Asset.native(),
        amount: "10",
      })
    )
    .setTimeout(600)
    .build()
    .toXDR();
}

/**
 * Build an envelope as if the clock were `msBehind` milliseconds earlier, so
 * its own `maxTime` has already lapsed by the time it is submitted. The shift
 * is only ever applied to the builder, never to the request, so nothing else in
 * the run sees a moved clock.
 */
function builtInPast(msBehind: number, build: () => string): string {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date(Date.now() - msBehind));
    return build();
  } finally {
    vi.useRealTimers();
  }
}

/** A wallet's copy of an envelope, signed by the given keypairs. */
function signedBy(xdr: string, ...signers: Keypair[]): string {
  const tx = new Transaction(xdr, config.networkPassphrase);
  tx.sign(...signers);
  return tx.toXDR();
}

async function propose(actor: Actor, xdr: string, description?: string) {
  return call("POST", "/api/treasury/proposals", actor, {
    treasuryId: groupId,
    xdr,
    ...(description ? { description } : {}),
  });
}

/** Create a proposal through the API and return its stored id. */
async function newProposal(actor: Actor = adminA, xdr = unsignedXdr()): Promise<string> {
  const res = await propose(actor, xdr);
  expect(res.statusCode).toBe(200);
  return res.json().proposal.id as string;
}

function sign(proposalId: string, actor: Actor, signedXdr: string) {
  return call("POST", `/api/treasury/proposals/${proposalId}/signatures`, actor, {
    signedXdr,
  });
}

function proposalRow(id: string) {
  return prisma.treasuryTxProposal.findUniqueOrThrow({ where: { id } });
}

function signatureRows(proposalId: string) {
  return prisma.treasurySignature.findMany({
    where: { proposalId },
    orderBy: { signerPublicKey: "asc" },
  });
}

async function auditActions(proposalId: string): Promise<string[]> {
  const rows = await prisma.auditLog.findMany({
    where: { entityId: proposalId, entityType: "treasury_tx_proposal" },
    orderBy: { createdAt: "asc" },
    select: { action: true },
  });
  return rows.map((row) => row.action);
}

/** Row counts for the two tables a proposal write touches. */
async function footprint() {
  const [proposals, signatures, createdAudit] = await Promise.all([
    prisma.treasuryTxProposal.count(),
    prisma.treasurySignature.count(),
    prisma.auditLog.count({ where: { action: "treasury.tx_proposal.created" } }),
  ]);
  return { proposals, signatures, createdAudit };
}

beforeAll(async () => {
  app = await buildApp();
  [owner, adminA, adminB, weightedMember, outsider] = await Promise.all([
    createActor("653 Owner"),
    createActor("653 Admin A"),
    createActor("653 Admin B"),
    createActor("653 Weighted Member"),
    createActor("653 Outsider"),
  ]);

  const created = await call("POST", "/groups", owner, {
    name: "653 Multisig Treasury",
    description: "Treasury multisig integration suite",
  });
  expect(created.statusCode).toBe(200);
  groupId = created.json().group.id;

  const inviteRes = await call("POST", `/groups/${groupId}/invite`, owner, { maxUses: 10 });
  expect(inviteRes.statusCode).toBe(200);
  const code = inviteRes.json().invite.code;

  for (const actor of [adminA, adminB, weightedMember]) {
    expect((await call("POST", "/groups/join", actor, { code })).statusCode).toBe(200);
  }

  // Only A and B become group admins. `weightedMember` stays a member while
  // still holding on-chain signing weight, so the role check can be tested
  // against a signature the *chain* would accept.
  for (const actor of [adminA, adminB]) {
    expect(
      (await call("POST", `/groups/${groupId}/members/role`, owner, { userId: actor.id, role: "admin" }))
        .statusCode
    ).toBe(200);
  }

  treasury = Keypair.random().publicKey();
  expect(
    (await call("POST", `/groups/${groupId}/treasury/enable`, owner, {
      publicKey: treasury,
      requiredSigners: 2,
    })).statusCode
  ).toBe(200);

  h.signers = [
    { key: adminA.publicKey, weight: SIGNER_WEIGHT },
    { key: adminB.publicKey, weight: SIGNER_WEIGHT },
    { key: weightedMember.publicKey, weight: SIGNER_WEIGHT },
  ];
  h.thresholds = { low: 1, med: 5, high: HIGH_THRESHOLD };
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

beforeEach(() => {
  h.submitCalls = [];
  h.submitError = null;
});

describe("treasury multisig proposal creation (#653)", () => {
  it("persists an externally built envelope with the live threshold and its audit row", async () => {
    const xdr = unsignedXdr();
    const res = await propose(adminA, xdr, "Pay the March invoice");
    expect(res.statusCode).toBe(200);
    const proposalId = res.json().proposal.id as string;

    const row = await proposalRow(proposalId);
    expect(row).toMatchObject({
      groupId,
      creatorId: adminA.id,
      sourceAccount: treasury,
      status: "PENDING_SIGNATURES",
      description: "Pay the March invoice",
      stellarTxHash: null,
      failureReason: null,
    });
    // Stored byte-for-byte as submitted: signers approve what is stored, so any
    // re-encoding here would silently change what gets signed.
    expect(row.xdr).toBe(xdr);
    expect(row.txHash).toBe(new Transaction(xdr, config.networkPassphrase).hash().toString("hex"));
    // Snapshot of the on-chain high threshold.
    expect(row.requiredWeight).toBe(HIGH_THRESHOLD);

    // The write and its audit row share one transaction (auditTx), so reading
    // both back is the evidence that the pairing reached Postgres together.
    expect(await auditActions(proposalId)).toContain("treasury.tx_proposal.created");
    const created = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: proposalId, action: "treasury.tx_proposal.created" },
    });
    expect(created.metadata).toMatchObject({ txHash: row.txHash, sourceAccount: treasury });
  });

  it("refuses an already-signed envelope and leaves no proposal or audit row", async () => {
    const before = await footprint();
    const res = await propose(adminA, signedBy(unsignedXdr("SIGNED-ATTEMPT"), adminA.keypair));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("XDR_NOT_UNSIGNED");

    expect(await footprint()).toEqual(before);
  });

  it("refuses an envelope sourced from an account that is not this group's treasury", async () => {
    const before = await footprint();
    const foreign = Keypair.random().publicKey();
    const res = await propose(adminA, buildPayment(foreign, "FOREIGN"));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("XDR_MISMATCH");
    expect(res.json().error.details.rule).toBe("source_account");

    expect(await footprint()).toEqual(before);
    expect(await prisma.treasuryTxProposal.count({ where: { sourceAccount: foreign } })).toBe(0);
  });

  it("refuses an envelope whose window has already closed", async () => {
    const before = await footprint();
    // A one-hour shift with a ten-minute window: the envelope's own `maxTime`
    // is half an hour in the past, which is what Horizon would reject as
    // tx_too_late after the group already believed it was settled.
    const expired = builtInPast(3_600_000, () => unsignedXdr("EXPIRED"));
    const res = await propose(adminA, expired);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INTENT_EXPIRED");
    expect(await footprint()).toEqual(before);
  });

  it("refuses an envelope whose fee is above what this treasury may pay", async () => {
    const before = await footprint();
    const res = await propose(
      adminA,
      rawEnvelope({ source: treasury, feeStroops: MIN_FEE_STROOPS_PER_OP * 3 })
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("XDR_MISMATCH");
    expect(res.json().error.details.rule).toBe("fee");
    expect(await footprint()).toEqual(before);
  });

  it("refuses a member who is not an admin, and a non-member, with nothing written", async () => {
    const before = await footprint();

    const memberRes = await propose(weightedMember, unsignedXdr("MEMBER-ATTEMPT"));
    expect(memberRes.statusCode).toBe(403);

    const outsiderRes = await propose(outsider, unsignedXdr("OUTSIDER-ATTEMPT"));
    expect(outsiderRes.statusCode).toBe(403);

    expect(await footprint()).toEqual(before);
  });

  it("requires authentication to create a proposal", async () => {
    const res = await call("POST", "/api/treasury/proposals", null, {
      treasuryId: groupId,
      xdr: unsignedXdr("NO-AUTH"),
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("treasury multisig signature collection (#653)", () => {
  it("records one admin signature with its on-chain weight and submits nothing", async () => {
    const xdr = unsignedXdr();
    const proposalId = await newProposal(adminA, xdr);

    const res = await sign(proposalId, adminA, signedBy(xdr, adminA.keypair));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "PENDING_SIGNATURES",
      totalWeight: SIGNER_WEIGHT,
      requiredWeight: HIGH_THRESHOLD,
      stellarTxHash: null,
    });

    const [signature] = await signatureRows(proposalId);
    expect(signature).toMatchObject({
      proposalId,
      signerUserId: adminA.id,
      signerPublicKey: adminA.publicKey,
      weight: SIGNER_WEIGHT,
    });
    // What is stored is a raw 64-byte ed25519 signature, base64-encoded. A
    // secret seed would decode to 32 bytes — this is the assertion that the
    // collector never receives key material.
    expect(Buffer.from(signature.signature, "base64")).toHaveLength(64);

    expect((await proposalRow(proposalId)).status).toBe("PENDING_SIGNATURES");
    expect(h.submitCalls).toHaveLength(0);

    const actions = await auditActions(proposalId);
    expect(actions).toContain("treasury.tx_proposal.signature_added");
    expect(actions).not.toContain("treasury.tx_proposal.ready");
  });

  it("submits the merged envelope once the second admin pushes weight over threshold", async () => {
    const xdr = unsignedXdr();
    const proposalId = await newProposal(adminA, xdr);

    expect((await sign(proposalId, adminA, signedBy(xdr, adminA.keypair))).statusCode).toBe(200);
    const res = await sign(proposalId, adminB, signedBy(xdr, adminB.keypair));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "SUBMITTED",
      totalWeight: HIGH_THRESHOLD,
      requiredWeight: HIGH_THRESHOLD,
      stellarTxHash: "stellar-integration-hash",
    });

    const rows = await signatureRows(proposalId);
    expect(rows).toHaveLength(2);
    const row = await proposalRow(proposalId);
    expect(row.status).toBe("SUBMITTED");
    expect(row.stellarTxHash).toBe("stellar-integration-hash");

    // The bytes handed to Horizon must be the proposal's own transaction, now
    // carrying both stored signatures — not the last submitted fragment, which
    // would silently drop the earlier signer.
    expect(h.submitCalls).toHaveLength(1);
    const merged = new Transaction(h.submitCalls[0], config.networkPassphrase);
    expect(merged.hash().toString("hex")).toBe(row.txHash);
    expect(merged.signatures).toHaveLength(2);
    expect(new Set(merged.signatures.map((s: any) => s.hint().toString("hex")))).toEqual(
      new Set([
        adminA.keypair.signatureHint().toString("hex"),
        adminB.keypair.signatureHint().toString("hex"),
      ])
    );
    // Each stored signature verifies against the merged envelope's hash.
    for (const stored of rows) {
      expect(
        Keypair.fromPublicKey(stored.signerPublicKey).verify(
          merged.hash(),
          Buffer.from(stored.signature, "base64")
        )
      ).toBe(true);
    }

    expect(await auditActions(proposalId)).toEqual(
      expect.arrayContaining([
        "treasury.tx_proposal.signature_added",
        "treasury.tx_proposal.ready",
        "treasury.tx_proposal.submitted",
      ])
    );
  });

  it("keeps a repeat signature idempotent at the database, not only in memory", async () => {
    const xdr = unsignedXdr();
    const proposalId = await newProposal(adminA, xdr);

    expect((await sign(proposalId, adminA, signedBy(xdr, adminA.keypair))).json().totalWeight).toBe(
      SIGNER_WEIGHT
    );
    const again = await sign(proposalId, adminA, signedBy(xdr, adminA.keypair));
    expect(again.statusCode).toBe(200);
    expect(again.json().totalWeight).toBe(SIGNER_WEIGHT);

    const rows = await signatureRows(proposalId);
    expect(rows).toHaveLength(1);
    expect(rows[0].signerUserId).toBe(adminA.id);

    // The unique index on (proposal_id, signer_user_id) is what makes a re-submit
    // cost nothing; a mocked client cannot show that it exists. Ask the schema
    // directly, bypassing the service's own in-memory skip, so the protection is
    // proven to be the index rather than a code path that could regress.
    await expect(
      prisma.treasurySignature.create({
        data: {
          proposalId,
          signerUserId: adminA.id,
          signerPublicKey: adminA.publicKey,
          signature: rows[0].signature,
          weight: SIGNER_WEIGHT,
        },
      })
    ).rejects.toThrow(
      /Unique constraint failed on the fields: \(`proposal_id`,`signer_user_id`\)/
    );
    expect(await signatureRows(proposalId)).toHaveLength(1);
    expect((await proposalRow(proposalId)).status).toBe("PENDING_SIGNATURES");
  });

  it("refuses an on-chain signer who is not a group admin and rolls back the whole request", async () => {
    const xdr = unsignedXdr();
    const proposalId = await newProposal(adminA, xdr);

    // Admin A's signature lands first, so the refused request arrives with part
    // of its work already done — the case a rollback assertion is about.
    expect((await sign(proposalId, adminA, signedBy(xdr, adminA.keypair))).statusCode).toBe(200);

    // An admin posts an envelope carrying their own valid signature *plus* the
    // non-admin's. The route authorizes the caller, so the service is what has
    // to reject the foreign signature.
    const mixed = signedBy(xdr, adminA.keypair, weightedMember.keypair);
    const res = await sign(proposalId, adminA, mixed);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("UNAUTHORIZED_SIGNER");

    // Only admin A's earlier signature survives; nothing from the refused
    // request was recorded and the proposal did not advance.
    const rows = await signatureRows(proposalId);
    expect(rows.map((r) => r.signerUserId)).toEqual([adminA.id]);
    expect((await proposalRow(proposalId)).status).toBe("PENDING_SIGNATURES");
    expect(h.submitCalls).toHaveLength(0);
  });

  it("refuses an envelope that hashes differently from the proposal", async () => {
    const xdr = unsignedXdr();
    const proposalId = await newProposal(adminA, xdr);

    // The only change is the amount: a different transaction, validly signed by
    // a valid admin.
    const tampered = buildPayment(treasury, "TAMPERED", "11", "1");
    const res = await sign(proposalId, adminA, signedBy(tampered, adminA.keypair));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("XDR_MISMATCH");

    expect(await signatureRows(proposalId)).toHaveLength(0);
    expect((await proposalRow(proposalId)).status).toBe("PENDING_SIGNATURES");
  });

  it("refuses a signature that does not verify even though its hint is an admin's", async () => {
    const xdr = unsignedXdr();
    const proposalId = await newProposal(adminA, xdr);

    // Signature bytes taken from a *different* transaction, presented under
    // admin A's key id: the hint matches, so only the cryptographic check can
    // catch it. Assembling the envelope by hand is what a real attacker does,
    // so the SDK's `addSignature` — which refuses bytes that do not verify —
    // cannot be used here.
    const other = buildPayment(treasury, "OTHER", "10", "2");
    const foreign = new Transaction(other, config.networkPassphrase);
    foreign.sign(adminA.keypair);
    const forged = new Transaction(xdr, config.networkPassphrase);
    forged.signatures.push(foreign.signatures[0]);

    const res = await sign(proposalId, adminA, forged.toXDR());
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_SIGNATURE");
    expect(await signatureRows(proposalId)).toHaveLength(0);
  });

  it("refuses a signer whose on-chain weight was removed after the proposal", async () => {
    const xdr = unsignedXdr();
    const proposalId = await newProposal(adminA, xdr);

    h.signers = [
      { key: adminA.publicKey, weight: SIGNER_WEIGHT },
      { key: weightedMember.publicKey, weight: SIGNER_WEIGHT },
    ];
    try {
      const res = await sign(proposalId, adminB, signedBy(xdr, adminB.keypair));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("UNAUTHORIZED_SIGNER");
      expect(await signatureRows(proposalId)).toHaveLength(0);
    } finally {
      h.signers = [
        { key: adminA.publicKey, weight: SIGNER_WEIGHT },
        { key: adminB.publicKey, weight: SIGNER_WEIGHT },
        { key: weightedMember.publicKey, weight: SIGNER_WEIGHT },
      ];
    }
  });

  it("refuses signatures once the proposal has been submitted", async () => {
    const xdr = unsignedXdr();
    const proposalId = await newProposal(adminA, xdr);
    await sign(proposalId, adminA, signedBy(xdr, adminA.keypair));
    await sign(proposalId, adminB, signedBy(xdr, adminB.keypair));

    const late = await sign(proposalId, adminA, signedBy(xdr, adminA.keypair));
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe("ALREADY_SUBMITTED");
    expect(h.submitCalls).toHaveLength(1);
    expect(await signatureRows(proposalId)).toHaveLength(2);
  });

  it("refuses an unknown proposal with 404 and writes nothing", async () => {
    const xdr = unsignedXdr();
    const proposalId = await newProposal(adminA, xdr);

    const res = await sign("653-does-not-exist", adminA, signedBy(xdr, adminA.keypair));
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
    expect(await signatureRows(proposalId)).toHaveLength(0);
  });

  it("refuses an unsigned envelope fragment carrying no signatures at all", async () => {
    const xdr = unsignedXdr();
    const proposalId = await newProposal(adminA, xdr);

    const res = await sign(proposalId, adminA, xdr);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("XDR_UNSIGNED");
    expect(await signatureRows(proposalId)).toHaveLength(0);
  });
});

describe("treasury multisig read-back and failure handling (#653)", () => {
  it("reports collected weight through GET /api/treasury/proposals/:id", async () => {
    const xdr = unsignedXdr();
    const proposalId = await newProposal(adminA, xdr);
    await sign(proposalId, adminA, signedBy(xdr, adminA.keypair));

    const res = await call("GET", `/api/treasury/proposals/${proposalId}`, adminB);
    expect(res.statusCode).toBe(200);
    const proposal = res.json().proposal;
    expect(proposal.status).toBe("PENDING_SIGNATURES");
    expect(proposal.signatures).toHaveLength(1);
    expect(proposal.signatures[0]).toMatchObject({
      signerPublicKey: adminA.publicKey,
      weight: SIGNER_WEIGHT,
    });
    expect(proposal.totalWeight).toBe(SIGNER_WEIGHT);
    // The envelope and its signatures are public to members; no key material is.
    expect(JSON.stringify(proposal)).not.toContain("secret");
  });

  it("refuses the read for a non-member", async () => {
    const proposalId = await newProposal();
    const res = await call("GET", `/api/treasury/proposals/${proposalId}`, outsider);
    expect(res.statusCode).toBe(403);
  });

  it("leaves the proposal pending when Horizon rejects the merged transaction", async () => {
    const xdr = unsignedXdr();
    const proposalId = await newProposal(adminA, xdr);
    await sign(proposalId, adminA, signedBy(xdr, adminA.keypair));

    h.submitError = "tx_failed (bad auth)";
    const res = await sign(proposalId, adminB, signedBy(xdr, adminB.keypair));
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("UPSTREAM_ERROR");

    // The behaviour is asserted as it is, not as it should be. `submitSignature`
    // writes the `READY` and `FAILED` statuses, the failure reason and their
    // audit rows inside the same `prisma.$transaction` whose callback then
    // throws, so Postgres rolls that request back: admin B's signature
    // disappears, the proposal stays `PENDING_SIGNATURES`, and nothing records
    // that Horizon was already asked. Admin A's earlier signature survives
    // because it committed in its own request. A mocked client hands back
    // whatever the test told it to and cannot observe this at all. Reported on
    // #653 rather than fixed here, because the fix belongs in the service and
    // this issue is the test suite.
    const row = await proposalRow(proposalId);
    expect(row.status).toBe("PENDING_SIGNATURES");
    expect(row.failureReason).toBeNull();
    expect((await signatureRows(proposalId)).map((s) => s.signerUserId)).toEqual([adminA.id]);

    const actions = await auditActions(proposalId);
    expect(actions).not.toContain("treasury.tx_proposal.failed");
    expect(actions).not.toContain("treasury.tx_proposal.ready");
    expect(actions.filter((a) => a === "treasury.tx_proposal.signature_added")).toHaveLength(1);
  });

  it("cascades stored signatures when a proposal row is removed", async () => {
    const xdr = unsignedXdr();
    const proposalId = await newProposal(adminA, xdr);
    await sign(proposalId, adminA, signedBy(xdr, adminA.keypair));
    expect(await signatureRows(proposalId)).toHaveLength(1);

    await prisma.treasuryTxProposal.delete({ where: { id: proposalId } });
    // The FK and its `onDelete: Cascade` are real in the deployed schema. This
    // is what stops an orphaned signature being replayed against a later
    // proposal that happens to reuse an id.
    expect(await signatureRows(proposalId)).toHaveLength(0);
  });
});
