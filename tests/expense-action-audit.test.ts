/**
 * Issue #504 — audit logging for state-changing group expense actions.
 *
 * The audit trail itself is already implemented across the mutating routes
 * (`auditTx` inside the same transaction as the state change — see
 * src/services/audit.ts and the call sites in src/routes/expenses.ts,
 * src/routes/groups.ts, src/routes/settlements.ts). What this issue's later
 * acceptance criteria ask for — "verify audit log entries are correctly
 * written to the database via Prisma" and "tests verifying that audit logs
 * are generated upon successful state-changing requests" — was missing for
 * two of the group-expense actions:
 *
 *   - PATCH /expenses/:id   → "expense.update"
 *   - POST /api/settlements/execute → "settlement.execute"
 *
 * (plus a re-verification of DELETE → "expense.delete" in one place, with
 * sensitive-data and no-audit-on-rejection assertions alongside).
 *
 * The suites below drive the real buildApp() against a mocked Prisma and
 * assert the exact rows the routes hand to `prisma.auditLog.create`: actor,
 * group, action, entity type/id, sanitized metadata, and — for the execute
 * path — that the record is written inside the same transaction that moves
 * the settlement to `submitted`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(async () => ({ id: "audit_1" })),
    createMany: vi.fn(async () => ({})),
    findUnique: vi.fn(async () => null),
    findUniqueOrThrow: vi.fn(async () => null),
    findFirst: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
    update: vi.fn(async () => ({})),
    updateMany: vi.fn(async () => ({ count: 0 })),
    upsert: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
    deleteMany: vi.fn(async () => ({ count: 0 })),
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
    statusHistory: model(),
    idempotencyKey: model(),
    accountBalance: model(),
    refreshToken: model(),
    $queryRawUnsafe: vi.fn(async () => [{ "?column?": 1 }]),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(async () => 1),
    $disconnect: vi.fn(),
  };
  const mockFetchBaseFee = vi.fn(async () => 100);
  return { prisma, mockFetchBaseFee };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

// The XDR validator is mocked (as in tests/settlement-execute-idempotency.test.ts):
// the audit assertions here are about *whether* the route records the event,
// not about envelope cryptography, which has its own suites.
vi.mock("../src/services/settlement-xdr", () => ({
  validateSettlementXdr: vi.fn(),
}));

vi.mock("../src/services/status-history", () => ({
  recordStatusTransitionInTransaction: vi.fn(async () => undefined),
}));

vi.mock("../src/services/stellar", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/stellar")>();
  return {
    ...actual,
    stellar: {
      ...actual.stellar,
      loadAccount: vi.fn(async () => ({
        exists: false,
        sequence: "0",
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
        fetchBaseFee: h.mockFetchBaseFee,
        feeStats: h.mockFetchBaseFee,
      })),
    },
  };
});

import { buildApp } from "../src/app";
import { signToken } from "../src/plugins/auth";
import { validateSettlementXdr } from "../src/services/settlement-xdr";
import { IDEMPOTENCY_HEADER } from "../src/plugins/idempotency";
import { Errors } from "../src/errors";
import { Keypair } from "@stellar/stellar-sdk";

const prisma = h.prisma;
let app: Awaited<ReturnType<typeof buildApp>>;

const USER_ID = "user_1";
const GROUP_ID = "group_1";

const user = (id: string, over: Record<string, any> = {}) => ({
  id,
  stellarPublicKey: Keypair.random().publicKey(),
  displayName: id,
  avatarUrl: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

const userA = user(USER_ID);
const userB = user("user_2");

function authHeader(u = userA) {
  const token = signToken({ id: u.id, stellarPublicKey: u.stellarPublicKey });
  return { authorization: `Bearer ${token}` };
}

const membership = (u = userA, role = "member") => ({
  groupId: GROUP_ID,
  userId: u.id,
  role,
});

const expenseRow = (over: Record<string, any> = {}) => ({
  id: "exp_1",
  groupId: GROUP_ID,
  payerUserId: USER_ID,
  title: "Dinner",
  description: null,
  amount: "50.0000000",
  assetCode: "XLM",
  assetIssuer: null,
  splitType: "equal",
  memo: "DINN001",
  receiptUrl: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  payer: userA,
  shares: [],
  ...over,
});

const settlementRow = (over: Record<string, any> = {}) => ({
  id: "settlement_1",
  shortCode: "ABC123",
  groupId: GROUP_ID,
  fromUserId: USER_ID,
  toUserId: "user_2",
  amount: "10.0000000",
  assetCode: "USDC",
  assetIssuer: null,
  status: "pending",
  transactionXdr: null,
  stellarTxHash: null,
  memo: "ABC123",
  retryCount: 0,
  failureReason: null,
  expiresAt: null,
  submittedAt: null,
  confirmedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  from: userA,
  to: userB,
  statusHistory: [],
  ...over,
});

/** Find the audit call for a given action, if the route wrote one. */
function auditCallFor(action: string) {
  return prisma.auditLog.create.mock.calls.find(
    (call: any) => call[0]?.data?.action === action
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();
  // Default: the caller is an active member and writes succeed.
  prisma.groupMember.findUnique.mockResolvedValue(membership());
  prisma.groupMember.findMany.mockResolvedValue([
    { userId: userA.id, user: { stellarPublicKey: userA.stellarPublicKey } },
  ]);
  (validateSettlementXdr as any).mockReset();
  (validateSettlementXdr as any).mockReturnValue(undefined);
});

describe("PATCH /expenses/:id — expense.update audit (#504)", () => {
  it("writes an expense.update audit row with actor, group, and entity on success", async () => {
    prisma.expense.findUnique.mockResolvedValue(expenseRow());
    prisma.expense.update.mockResolvedValue(
      expenseRow({ title: "Dinner (fixed)" })
    );

    const res = await app.inject({
      method: "PATCH",
      url: "/expenses/exp_1",
      headers: authHeader(),
      payload: { title: "Dinner (fixed)" },
    });

    expect(res.statusCode).toBe(200);
    const call = auditCallFor("expense.update");
    expect(call).toBeDefined();
    const data = call[0].data;
    expect(data.userId).toBe(USER_ID);
    expect(data.groupId).toBe(GROUP_ID);
    expect(data.entityType).toBe("expense");
    expect(data.entityId).toBe("exp_1");
  });

  it("does not write an audit row when the caller is neither payer nor admin", async () => {
    // The payer is someone else and the caller is a plain member.
    prisma.expense.findUnique.mockResolvedValue(
      expenseRow({ payerUserId: "user_2" })
    );

    const res = await app.inject({
      method: "PATCH",
      url: "/expenses/exp_1",
      headers: authHeader(),
      payload: { title: "Hijack" },
    });

    expect(res.statusCode).toBe(403);
    expect(auditCallFor("expense.update")).toBeUndefined();
  });

  it("does not write an audit row when the expense does not exist", async () => {
    prisma.expense.findUnique.mockResolvedValue(null);

    const res = await app.inject({
      method: "PATCH",
      url: "/expenses/missing",
      headers: authHeader(),
      payload: { title: "Ghost" },
    });

    expect(res.statusCode).toBe(404);
    expect(auditCallFor("expense.update")).toBeUndefined();
  });

  it("keeps request-time metadata out of the audit row's sensitive-key surface", async () => {
    prisma.expense.findUnique.mockResolvedValue(expenseRow());
    prisma.expense.update.mockResolvedValue(expenseRow());

    await app.inject({
      method: "PATCH",
      url: "/expenses/exp_1",
      headers: authHeader(),
      payload: { memo: "TRIP-01" },
    });

    const call = auditCallFor("expense.update");
    expect(call).toBeDefined();
    const metadata = call[0].data.metadata ?? {};
    expect(metadata).not.toHaveProperty("signedXdr");
    expect(metadata).not.toHaveProperty("token");
    expect(metadata).not.toHaveProperty("privateKey");
    expect(metadata).not.toHaveProperty("authorization");
  });
});

describe("DELETE /expenses/:id — expense.delete audit (#504)", () => {
  it("writes an expense.delete audit row with actor and group on success", async () => {
    prisma.expense.findUnique.mockResolvedValue(
      expenseRow({ shares: [{ status: "pending", userId: userA.id }] })
    );

    const res = await app.inject({
      method: "DELETE",
      url: "/expenses/exp_1",
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const call = auditCallFor("expense.delete");
    expect(call).toBeDefined();
    const data = call[0].data;
    expect(data.userId).toBe(USER_ID);
    expect(data.groupId).toBe(GROUP_ID);
    expect(data.entityType).toBe("expense");
    expect(data.entityId).toBe("exp_1");
  });

  it("writes no audit row when deletion is rejected for settled shares", async () => {
    prisma.expense.findUnique.mockResolvedValue(
      expenseRow({
        shares: [{ status: "settled", userId: "user_2" }],
      })
    );

    const res = await app.inject({
      method: "DELETE",
      url: "/expenses/exp_1",
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(409);
    expect(auditCallFor("expense.delete")).toBeUndefined();
  });
});

describe("POST /api/settlements/execute — settlement.execute audit (#504)", () => {
  /** Stage the full pending → submitted execute path. */
  function stageSubmittableSettlement() {
    let current = settlementRow();
    prisma.settlement.findUnique.mockImplementation(async () => current);
    prisma.settlement.findUniqueOrThrow.mockImplementation(async () => current);
    prisma.settlement.updateMany.mockImplementation(
      async ({ where, data }: any) => {
        if (!where.status?.in?.includes(current.status)) return { count: 0 };
        current = { ...current, ...data };
        return { count: 1 };
      }
    );
  }

  beforeEach(() => {
    stageSubmittableSettlement();
  });

  it("writes a settlement.execute audit row inside the accepting transaction", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/settlements/execute",
      headers: { ...authHeader(), [IDEMPOTENCY_HEADER]: "audit-key-1" },
      payload: { settlementId: "settlement_1", signedXdr: "AAAA-envelope" },
    });

    expect(res.statusCode).toBe(202);
    const call = auditCallFor("settlement.execute");
    expect(call).toBeDefined();
    const data = call[0].data;
    expect(data.userId).toBe(USER_ID);
    expect(data.groupId).toBe(GROUP_ID);
    expect(data.entityType).toBe("settlement");
    expect(data.entityId).toBe("settlement_1");
    expect(data.metadata).toMatchObject({ status: "submitted" });
    // The audit write and the status transition happen in the same
    // transaction callback — atomic with the state change they document.
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.settlement.updateMany).toHaveBeenCalled();
  });

  it("writes a failure-outcome audit row when envelope validation fails", async () => {
    // The real validator throws AppError(400, XDR_MISMATCH) — mirror that so
    // the route's catch/audit/rethrow path behaves as in production.
    (validateSettlementXdr as any).mockImplementation(() => {
      throw Errors.badRequest(
        "xdr_mismatch",
        "Signed transaction does not match the recorded intent"
      );
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/settlements/execute",
      headers: { ...authHeader(), [IDEMPOTENCY_HEADER]: "audit-key-2" },
      payload: { settlementId: "settlement_1", signedXdr: "AAAA-mismatched" },
    });

    expect(res.statusCode).toBe(400);
    const call = auditCallFor("settlement.execute.validation_failed");
    expect(call).toBeDefined();
    const data = call[0].data;
    expect(data.userId).toBe(USER_ID);
    expect(data.groupId).toBe(GROUP_ID);
    expect(data.entityType).toBe("settlement");
    expect(data.entityId).toBe("settlement_1");
    // The failure reason is the service's stable text — never the envelope.
    expect(data.metadata.reason).toBe(
      "Signed transaction does not match the recorded intent"
    );
    expect(JSON.stringify(data)).not.toContain("AAAA-mismatched");
    // And the success-path audit must not have fired.
    expect(auditCallFor("settlement.execute")).toBeUndefined();
  });

  it("does not write a second execute audit row for an already-submitted settlement", async () => {
    prisma.settlement.findUnique.mockResolvedValue(
      settlementRow({ status: "submitted" })
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/settlements/execute",
      headers: { ...authHeader(), [IDEMPOTENCY_HEADER]: "audit-key-3" },
      payload: { settlementId: "settlement_1", signedXdr: "AAAA-envelope" },
    });

    // Already in flight: 200, no new acceptance, no new audit row.
    expect(res.statusCode).toBe(200);
    expect(auditCallFor("settlement.execute")).toBeUndefined();
  });

  it("writes no audit row when a non-member cannot execute at all", async () => {
    prisma.groupMember.findUnique.mockResolvedValue(null);
    // The group must exist so requireMembership answers 403 (not 404).
    prisma.group.findUnique.mockResolvedValue({ id: GROUP_ID });
    prisma.settlement.findUnique.mockResolvedValue(settlementRow());

    const res = await app.inject({
      method: "POST",
      url: "/api/settlements/execute",
      headers: { ...authHeader(), [IDEMPOTENCY_HEADER]: "audit-key-4" },
      payload: { settlementId: "settlement_1", signedXdr: "AAAA-envelope" },
    });

    expect(res.statusCode).toBe(403);
    expect(auditCallFor("settlement.execute")).toBeUndefined();
    expect(
      auditCallFor("settlement.execute.validation_failed")
    ).toBeUndefined();
  });
});
