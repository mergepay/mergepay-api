import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  Keypair,
  Transaction,
  TransactionBuilder,
  Account,
  Operation,
  Asset,
  Memo,
} from "@stellar/stellar-sdk";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(),
    createMany: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(async () => []),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(async () => 0),
  });
  const prisma: any = {
    user: model(),
    group: model(),
    groupMember: model(),
    expense: model(),
    expenseShare: model(),
    settlement: model(),
    treasuryTransaction: model(),
    treasuryProposal: model(),
    treasuryApproval: model(),
    invite: model(),
    invitation: model(),
    anchorSession: model(),
    auditLog: model(),
    idempotencyKey: model(),
    withdrawal: model(),
    webhook: model(),
    webhookDelivery: model(),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $disconnect: vi.fn(),
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

vi.mock("../src/services/stellar", () => ({
  stellar: {
    loadAccount: vi.fn(),
    buildPayment: vi.fn(),
    submitPayment: vi.fn(),
    submitSigned: vi.fn(),
  },
  memoText: vi.fn((code: string) => `MP:${code}`),
  toAsset: vi.fn(),
}));

import { buildApp } from "../src/app";
import { signToken } from "../src/plugins/auth";
import { eventBus } from "../src/services/event";
import { config } from "../src/config";

const prisma = h.prisma;
const NET = config.networkPassphrase;

const fakeUser = (over: Partial<any> = {}) => ({
  id: "user_" + Math.random().toString(36).slice(2, 8),
  stellarPublicKey: Keypair.random().publicKey(),
  ...over,
});

function authHeader(user = fakeUser()) {
  const token = signToken({ id: user.id, stellarPublicKey: user.stellarPublicKey });
  return { authorization: `Bearer ${token}` };
}

function makeUnsignedXdr(params: {
  source: Keypair;
  destination: string;
  amount: string;
  memo?: string;
}): string {
  return new TransactionBuilder(new Account(params.source.publicKey(), "1"), {
    fee: "100",
    networkPassphrase: NET,
  })
    .addOperation(
      Operation.payment({
        destination: params.destination,
        asset: Asset.native(),
        amount: params.amount,
      })
    )
    .addMemo(Memo.text(params.memo ?? `MP:${params.source.publicKey().slice(0, 6)}`))
    .setTimeout(300)
    .build()
    .toXDR();
}

function txHash(xdr: string): string {
  return new Transaction(xdr, NET).hash().toString("hex");
}

let app: Awaited<ReturnType<typeof buildApp>>;
let emitSpy: ReturnType<typeof vi.spyOn>;

function treasuryEvents(): any[] {
  return emitSpy.mock.calls
    .filter(([name]) => name === "event")
    .map(([, event]) => event)
    .filter((event: any) => event.eventType.startsWith("treasury.proposal."));
}

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();
  emitSpy = vi.spyOn(eventBus, "emit");

  const { stellar } = await import("../src/services/stellar");
  vi.mocked(stellar.loadAccount).mockResolvedValue({
    exists: true,
    sequence: "12345",
    balances: [{ assetCode: "XLM", assetIssuer: null, balance: "1000.0000000" }],
    signers: [{ key: "GA", weight: 1 }],
    thresholds: { low: 1, med: 1, high: 1 },
  });
  vi.mocked(stellar.buildPayment).mockImplementation((intent: any) =>
    new TransactionBuilder(
      new Account(intent.sourcePublicKey, intent.sourceSequence ?? "1"),
      { fee: "100", networkPassphrase: NET }
    )
      .addOperation(
        Operation.payment({
          destination: intent.destination,
          asset:
            intent.asset?.code && intent.asset.code !== "XLM"
              ? new Asset(intent.asset.code, intent.asset.issuer)
              : Asset.native(),
          amount: intent.amount,
        })
      )
      .addMemo(Memo.text(intent.memoCode ?? "MP:TEST"))
      .setTimeout(300)
      .build()
      .toXDR()
  );
});

afterEach(() => {
  emitSpy.mockRestore();
});

function mockAdminGroup(user: { id: string }, treasury: Keypair, requiredSigners = 2) {
  prisma.groupMember.findUnique.mockResolvedValueOnce({
    groupId: "group_1",
    userId: user.id,
    role: "admin",
  });
  prisma.group.findUnique.mockResolvedValue({
    id: "group_1",
    name: "Trip",
    description: null,
    createdByUserId: user.id,
    treasuryEnabled: true,
    treasuryAccountPublicKey: treasury.publicKey(),
    treasuryRequiredSigners: requiredSigners,
    archived: false,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
  });
}

describe("treasury.proposal.created dispatch", () => {
  it("emits a created event after a successful proposal creation", async () => {
    const user = fakeUser();
    const treasury = Keypair.random();
    const destination = Keypair.random().publicKey();
    mockAdminGroup(user, treasury);
    prisma.treasuryProposal.create.mockResolvedValueOnce({
      id: "prop_1",
      groupId: "group_1",
      creatorId: user.id,
      xdr: "AAAA",
      txHash: "hash_1",
      threshold: 2,
      signatures: [],
      status: "awaiting_signatures",
      stellarTxHash: null,
      failureReason: null,
      expiresAt: new Date("2026-04-08T00:00:00.000Z"),
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    prisma.auditLog.create.mockResolvedValue({});

    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/treasury/proposals",
      headers: authHeader(user),
      payload: { destination, amount: "5", assetCode: "XLM" },
    });
    expect(res.statusCode).toBe(200);

    const events = treasuryEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "treasury.proposal.created",
      groupId: "group_1",
      userId: user.id,
      payload: expect.objectContaining({
        proposalId: "prop_1",
        groupId: "group_1",
        creatorId: user.id,
        status: "awaiting_signatures",
        threshold: 2,
        signatureCount: 0,
        destination,
        amount: "5",
        assetCode: "XLM",
      }),
    });
  });

  it("queues a webhook delivery for a subscribed group endpoint", async () => {
    const user = fakeUser();
    const treasury = Keypair.random();
    mockAdminGroup(user, treasury);
    prisma.treasuryProposal.create.mockResolvedValueOnce({
      id: "prop_1",
      groupId: "group_1",
      creatorId: user.id,
      xdr: "AAAA",
      txHash: "hash_1",
      threshold: 2,
      signatures: [],
      status: "awaiting_signatures",
      stellarTxHash: null,
      failureReason: null,
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.auditLog.create.mockResolvedValue({});
    prisma.webhook.findMany.mockResolvedValue([
      { id: "wh_1", url: "https://example.com/hook", secret: "s3cret", enabled: true },
    ]);
    prisma.webhookDelivery.createMany.mockResolvedValue({ count: 1 });

    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/treasury/proposals",
      headers: authHeader(user),
      payload: {
        destination: Keypair.random().publicKey(),
        amount: "5",
        assetCode: "XLM",
      },
    });
    expect(res.statusCode).toBe(200);

    await new Promise((resolve) => setImmediate(resolve));

    expect(prisma.webhook.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          enabled: true,
          events: { has: "treasury.proposal.created" },
        }),
      })
    );
    expect(prisma.webhookDelivery.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            webhookId: "wh_1",
            eventType: "treasury.proposal.created",
            status: "pending",
          }),
        ],
      })
    );
  });

  it("emits nothing when creation fails", async () => {
    const user = fakeUser();
    prisma.groupMember.findUnique.mockResolvedValueOnce({
      groupId: "group_1",
      userId: user.id,
      role: "admin",
    });
    prisma.group.findUnique.mockResolvedValue({
      id: "group_1",
      treasuryEnabled: false,
      treasuryAccountPublicKey: null,
      treasuryRequiredSigners: null,
    });

    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/treasury/proposals",
      headers: authHeader(user),
      payload: {
        destination: Keypair.random().publicKey(),
        amount: "5",
        assetCode: "XLM",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(treasuryEvents()).toHaveLength(0);
  });

  it("does not fail the mutation when a listener throws", async () => {
    const user = fakeUser();
    const treasury = Keypair.random();
    mockAdminGroup(user, treasury);
    prisma.treasuryProposal.create.mockResolvedValueOnce({
      id: "prop_1",
      groupId: "group_1",
      creatorId: user.id,
      xdr: "AAAA",
      txHash: "hash_1",
      threshold: 2,
      signatures: [],
      status: "awaiting_signatures",
      stellarTxHash: null,
      failureReason: null,
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.auditLog.create.mockResolvedValue({});

    const throwingListener = () => {
      throw new Error("subscriber exploded");
    };
    eventBus.on("event", throwingListener);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/groups/group_1/treasury/proposals",
        headers: authHeader(user),
        payload: {
          destination: Keypair.random().publicKey(),
          amount: "5",
          assetCode: "XLM",
        },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      eventBus.off("event", throwingListener);
    }
  });
});

describe("treasury.proposal.signed / submitted dispatch", () => {
  function setupSignableProposal(treasury: Keypair, threshold: number) {
    const proposalXdr = makeUnsignedXdr({
      source: treasury,
      destination: Keypair.random().publicKey(),
      amount: "5",
    });
    const pendingProposal = {
      id: "prop_1",
      groupId: "group_1",
      creatorId: "u_creator",
      xdr: proposalXdr,
      txHash: txHash(proposalXdr),
      threshold,
      signatures: [] as any[],
      status: threshold > 1 ? "awaiting_signatures" : "pending",
      stellarTxHash: null,
      failureReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    prisma.treasuryProposal.findUnique.mockResolvedValue(pendingProposal);
    prisma.treasuryProposal.update.mockResolvedValue(pendingProposal);
    prisma.treasuryApproval.findMany.mockResolvedValue([]);
    prisma.treasuryApproval.create.mockResolvedValue({ id: "approval_1" });
    prisma.auditLog.create.mockResolvedValue({});
    const signed = new Transaction(proposalXdr, NET);
    signed.sign(treasury);
    return { proposalXdr, pendingProposal, signedXdr: signed.toXDR() };
  }

  function mockMember(user: { id: string }, treasury: Keypair) {
    prisma.groupMember.findUnique.mockResolvedValueOnce({
      groupId: "group_1",
      userId: user.id,
      role: "member",
    });
    prisma.groupMember.findMany.mockResolvedValue([
      { userId: "u_treasury", user: { stellarPublicKey: treasury.publicKey() } },
    ]);
  }

  it("emits a signed event when below threshold", async () => {
    const user = fakeUser();
    const treasury = Keypair.random();
    const { signedXdr } = setupSignableProposal(treasury, 2);
    mockMember(user, treasury);

    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/treasury/proposals/prop_1/sign",
      headers: authHeader(user),
      payload: { signedXdr },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("awaiting_signatures");

    const events = treasuryEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "treasury.proposal.signed",
      groupId: "group_1",
      userId: "u_treasury",
      payload: expect.objectContaining({
        proposalId: "prop_1",
        signerPublicKey: treasury.publicKey(),
        signatureCount: 1,
        threshold: 2,
        status: "awaiting_signatures",
      }),
    });
  });

  it("emits signed and submitted events when the threshold is met", async () => {
    const user = fakeUser();
    const treasury = Keypair.random();
    const { signedXdr } = setupSignableProposal(treasury, 1);
    mockMember(user, treasury);
    const { stellar } = await import("../src/services/stellar");
    vi.mocked(stellar.submitSigned).mockResolvedValueOnce("hash_xyz");

    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/treasury/proposals/prop_1/sign",
      headers: authHeader(user),
      payload: { signedXdr },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("confirmed");

    const events = treasuryEvents();
    expect(events.map((e) => e.eventType)).toEqual([
      "treasury.proposal.signed",
      "treasury.proposal.submitted",
    ]);
    expect(events[1]).toMatchObject({
      eventType: "treasury.proposal.submitted",
      groupId: "group_1",
      userId: user.id,
      payload: expect.objectContaining({
        proposalId: "prop_1",
        status: "confirmed",
        stellarTxHash: "hash_xyz",
        signatureCount: 1,
        threshold: 1,
      }),
    });
  });

  it("emits nothing when the Stellar submission fails and the transaction rolls back", async () => {
    const user = fakeUser();
    const treasury = Keypair.random();
    const { signedXdr } = setupSignableProposal(treasury, 1);
    mockMember(user, treasury);
    const { stellar } = await import("../src/services/stellar");
    vi.mocked(stellar.submitSigned).mockRejectedValueOnce(new Error("txFailed"));

    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/treasury/proposals/prop_1/sign",
      headers: authHeader(user),
      payload: { signedXdr },
    });
    expect(res.statusCode).toBe(502);
    expect(treasuryEvents()).toHaveLength(0);
  });

  it("emits nothing for a mismatched XDR", async () => {
    const user = fakeUser();
    const treasury = Keypair.random();
    setupSignableProposal(treasury, 2);
    mockMember(user, treasury);

    const rogue = new Transaction(
      makeUnsignedXdr({
        source: Keypair.random(),
        destination: Keypair.random().publicKey(),
        amount: "999",
      }),
      NET
    );
    rogue.sign(Keypair.random());

    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/treasury/proposals/prop_1/sign",
      headers: authHeader(user),
      payload: { signedXdr: rogue.toXDR() },
    });
    expect(res.statusCode).toBe(400);
    expect(treasuryEvents()).toHaveLength(0);
  });

  it("emits nothing for a duplicate signature", async () => {
    const user = fakeUser();
    const treasury = Keypair.random();
    const { proposalXdr, pendingProposal } = setupSignableProposal(treasury, 2);
    const alreadySigned = {
      ...pendingProposal,
      signatures: [
        { publicKey: treasury.publicKey(), signedAt: new Date().toISOString() },
      ],
    };
    prisma.treasuryProposal.findUnique.mockResolvedValue(alreadySigned);
    prisma.treasuryApproval.findMany.mockResolvedValue([
      { userId: "u_treasury", txHash: txHash(proposalXdr) },
    ]);
    mockMember(user, treasury);

    const signed = new Transaction(proposalXdr, NET);
    signed.sign(treasury);

    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/treasury/proposals/prop_1/sign",
      headers: authHeader(user),
      payload: { signedXdr: signed.toXDR() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().signatureCount).toBe(1);
    expect(treasuryEvents()).toHaveLength(0);
  });
});
