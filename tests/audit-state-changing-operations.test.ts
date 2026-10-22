/**
 * Issue #681 — audit logging for state-changing group operations.
 *
 * The audit trail for group creation and member addition is written by the
 * canonical `logActionTx` helper (see src/services/audit.ts) inside the same
 * database transaction as the state change, so a rolled-back mutation can
 * never leave a phantom audit row and a committed mutation can never lose
 * its record. These tests assert the exact rows the routes hand to
 * `prisma.auditLog.create`: actor, action, target resource, and metadata.
 *
 * Group creation is also the anchor flow of issue #660's repository-helper
 * acceptance criteria; member addition (`POST /groups/join`) is asserted
 * here because it is the group-membership change that no prior suite
 * covered on its success path.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

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
    invite: model(),
    invitation: model(),
    anchorSession: model(),
    auditLog: model(),
    idempotencyKey: model(),
    statusHistory: model(),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $disconnect: vi.fn(),
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

vi.mock("../src/services/stellar", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/stellar")>();
  return {
    ...actual,
    stellar: {
      ...actual.stellar,
      loadAccount: vi.fn(async () => ({
        exists: true,
        sequence: "12345",
        balances: [],
        signers: [],
        thresholds: { low: 0, med: 0, high: 0 },
      })),
    },
  };
});

vi.mock("@stellar/stellar-sdk", async (importActual) => {
  const actual = await importActual<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    Horizon: {
      Server: vi.fn().mockImplementation(() => ({
        fetchBaseFee: vi.fn(),
      })),
    },
  };
});

import { buildApp } from "../src/app";
import { signToken } from "../src/plugins/auth";
import { AuditAction } from "../src/services/audit-actions";

const prisma = h.prisma;
let app: Awaited<ReturnType<typeof buildApp>>;

const user = {
  id: "user_1",
  stellarPublicKey: Keypair.random().publicKey(),
  displayName: "User",
  avatarUrl: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

function authHeader() {
  const token = signToken({
    id: user.id,
    stellarPublicKey: user.stellarPublicKey,
  });
  return { authorization: `Bearer ${token}` };
}

/** The audit row written for a given action, if the route wrote one. */
function auditRowFor(action: string) {
  return prisma.auditLog.create.mock.calls.find(
    (call: any) => call[0]?.data?.action === action
  )?.[0]?.data;
}

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();
});

describe("group creation — durable audit record (#681, #660)", () => {
  it("writes a group.create audit row with actor, target, and metadata inside the creation transaction", async () => {
    prisma.group.create.mockResolvedValueOnce({
      id: "group_new",
      name: "Lisbon Trip",
      description: null,
      createdByUserId: user.id,
      treasuryEnabled: false,
      treasuryAccountPublicKey: null,
      treasuryRequiredSigners: null,
      archived: false,
      createdAt: new Date(),
    });

    const res = await app.inject({
      method: "POST",
      url: "/groups",
      headers: authHeader(),
      payload: { name: "Lisbon Trip" },
    });

    expect(res.statusCode).toBe(200);
    expect(auditRowFor(AuditAction.GROUP_CREATE)).toMatchObject({
      userId: user.id,
      groupId: "group_new",
      entityType: "group",
      entityId: "group_new",
      metadata: expect.objectContaining({
        name: "Lisbon Trip",
        outcome: "success",
        actorType: "user",
      }),
    });
  });
});

describe("member addition — durable audit record (#681)", () => {
  it("writes a group.join audit row when the caller joins with an invite code", async () => {
    prisma.invite.findUnique.mockResolvedValueOnce({
      id: "invite_1",
      groupId: "group_1",
      code: "JOIN01",
      expiresAt: null,
      maxUses: null,
      uses: 0,
      createdByUserId: "admin_1",
      createdAt: new Date(),
    });
    // The caller is not a member yet, so the join branch runs.
    prisma.groupMember.findUnique.mockResolvedValueOnce(null);
    prisma.group.findUnique.mockResolvedValueOnce({
      id: "group_1",
      name: "Lisbon Trip",
      createdByUserId: "admin_1",
      treasuryEnabled: false,
      treasuryAccountPublicKey: null,
      treasuryRequiredSigners: null,
      archived: false,
      createdAt: new Date(),
    });

    const res = await app.inject({
      method: "POST",
      url: "/groups/join",
      headers: authHeader(),
      payload: { code: "join01" },
    });

    expect(res.statusCode).toBe(200);

    // The membership insert and its audit record commit together.
    expect(prisma.groupMember.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { groupId: "group_1", userId: user.id, role: "member" },
      })
    );
    expect(auditRowFor(AuditAction.GROUP_JOIN)).toMatchObject({
      userId: user.id,
      groupId: "group_1",
      entityType: "group",
      entityId: "group_1",
      metadata: expect.objectContaining({ inviteId: "invite_1" }),
    });
  });

  it("does not write an audit row when the caller is already a member", async () => {
    prisma.invite.findUnique.mockResolvedValueOnce({
      id: "invite_1",
      groupId: "group_1",
      code: "JOIN01",
      expiresAt: null,
      maxUses: null,
      uses: 0,
      createdByUserId: "admin_1",
      createdAt: new Date(),
    });
    prisma.groupMember.findUnique.mockResolvedValueOnce({
      id: "membership_1",
      groupId: "group_1",
      userId: user.id,
      role: "member",
    });
    prisma.group.findUnique.mockResolvedValueOnce({
      id: "group_1",
      name: "Lisbon Trip",
      description: null,
      createdByUserId: "admin_1",
      treasuryEnabled: false,
      treasuryAccountPublicKey: null,
      treasuryRequiredSigners: null,
      archived: false,
      createdAt: new Date(),
    });

    const res = await app.inject({
      method: "POST",
      url: "/groups/join",
      headers: authHeader(),
      payload: { code: "JOIN01" },
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.groupMember.create).not.toHaveBeenCalled();
    expect(auditRowFor(AuditAction.GROUP_JOIN)).toBeUndefined();
  });
});
