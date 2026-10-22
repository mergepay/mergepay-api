/**
 * Integration Test Suite: API Contract Types & Web Frontend Alignment
 *
 * Verifies backend response structures and request payloads against the shared
 * contract defined in `src/types/contract.ts` (mirrored from mergepay-web/src/lib/types.ts).
 * Tests key endpoints: Auth, Groups, Expenses, and Settlements.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

const { mockUser, mockUser2, mockGroup, mockMember, mockExpense, mockSettlement, mockPrisma } =
  vi.hoisted(() => {
    const mockUser = {
      id: "user_test_123",
      stellarPublicKey: "GBZXN7PIRZGNMHGA728RGRTD4BGPI7QW24BHCRNX2WDCGS7K4S2MTO2Z",
      displayName: "Test Alice",
      avatarUrl: "https://example.com/avatar.png",
      createdAt: new Date("2026-01-15T10:00:00.000Z"),
    };

    const mockUser2 = {
      id: "user_test_456",
      stellarPublicKey: "GDAZQGOBVFIGR3P24Y5XX72FO4VB424675PGMM7TTFT7NM6XQ3TFMG3D",
      displayName: "Test Bob",
      avatarUrl: null,
      createdAt: new Date("2026-01-16T12:00:00.000Z"),
    };

    const mockGroup = {
      id: "group_test_123",
      name: "Weekend Trip",
      description: "Shared trip expenses",
      createdByUserId: mockUser.id,
      treasuryEnabled: false,
      treasuryAccountPublicKey: null,
      treasuryRequiredSigners: null,
      archived: false,
      createdAt: new Date("2026-01-17T08:00:00.000Z"),
      _count: { members: 2 },
    };

    const mockMember = {
      id: "member_test_1",
      groupId: mockGroup.id,
      userId: mockUser.id,
      role: "admin",
      joinedAt: new Date("2026-01-17T08:00:00.000Z"),
      user: mockUser,
      group: mockGroup,
    };

    const mockExpense = {
      id: "expense_test_123",
      groupId: mockGroup.id,
      payerUserId: mockUser.id,
      payer: mockUser,
      title: "Dinner",
      description: "Italian restaurant",
      amount: "150.0000000",
      assetCode: "USDC",
      assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      splitType: "equal",
      memo: "dinner-receipt",
      receiptUrl: "https://receipts.example.com/123.jpg",
      createdAt: new Date("2026-01-18T19:30:00.000Z"),
      shares: [
        {
          id: "share_test_1",
          expenseId: "expense_test_123",
          userId: mockUser.id,
          user: mockUser,
          shareAmount: "75.0000000",
          status: "settled",
        },
        {
          id: "share_test_2",
          expenseId: "expense_test_123",
          userId: mockUser2.id,
          user: mockUser2,
          shareAmount: "75.0000000",
          status: "pending",
        },
      ],
    };

    const mockSettlement = {
      id: "settle_test_123",
      groupId: mockGroup.id,
      fromUserId: mockUser2.id,
      from: mockUser2,
      toUserId: mockUser.id,
      to: mockUser,
      amount: "75.0000000",
      assetCode: "USDC",
      assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      stellarTxHash: "a1b2c3d4e5f67890abcdef1234567890abcdef1234567890abcdef1234567890",
      status: "confirmed",
      failureReason: null,
      retryCount: 0,
      submittedAt: new Date("2026-01-19T10:00:00.000Z"),
      confirmedAt: new Date("2026-01-19T10:01:00.000Z"),
      memo: "MP:settle_test_123",
      expenseId: mockExpense.id,
      expenseShareId: "share_test_2",
      createdAt: new Date("2026-01-19T09:55:00.000Z"),
      updatedAt: new Date("2026-01-19T10:01:00.000Z"),
      expiresAt: null,
      statusHistory: [
        {
          id: "sh_1",
          entityType: "settlement",
          entityId: "settle_test_123",
          status: "pending",
          reason: null,
          source: "api",
          createdAt: new Date("2026-01-19T09:55:00.000Z"),
        },
        {
          id: "sh_2",
          entityType: "settlement",
          entityId: "settle_test_123",
          status: "confirmed",
          reason: null,
          source: "horizon",
          createdAt: new Date("2026-01-19T10:01:00.000Z"),
        },
      ],
    };

    const mockPrisma: any = {
      user: {
        findUnique: vi.fn(async ({ where }: any) => {
          if (where.id === mockUser.id || where.stellarPublicKey === mockUser.stellarPublicKey) return mockUser;
          if (where.id === mockUser2.id || where.stellarPublicKey === mockUser2.stellarPublicKey) return mockUser2;
          return null;
        }),
        upsert: vi.fn(async () => mockUser),
        create: vi.fn(async () => mockUser),
      },
      group: {
        findUnique: vi.fn(async ({ where }: any) => {
          if (where.id === mockGroup.id) return mockGroup;
          return null;
        }),
        findMany: vi.fn(async () => [mockGroup]),
        create: vi.fn(async () => mockGroup),
      },
      groupMember: {
        findUnique: vi.fn(async () => ({ ...mockMember, group: { ...mockGroup, _count: { members: 2 } } })),
        findFirst: vi.fn(async () => ({ ...mockMember, group: { ...mockGroup, _count: { members: 2 } } })),
        findMany: vi.fn(async () => [{ ...mockMember, group: { ...mockGroup, _count: { members: 2 } } }]),
        count: vi.fn(async () => 1),
        create: vi.fn(async () => mockMember),
      },
      expense: {
        findUnique: vi.fn(async ({ where }: any) => {
          if (where.id === mockExpense.id) return mockExpense;
          return null;
        }),
        findFirst: vi.fn(async () => mockExpense),
        findMany: vi.fn(async () => [mockExpense]),
        create: vi.fn(async () => mockExpense),
      },
      expenseShare: {
        findUnique: vi.fn(async () => mockExpense.shares[0]),
        findMany: vi.fn(async () => mockExpense.shares),
      },
      settlement: {
        findUnique: vi.fn(async ({ where }: any) => {
          if (where.id === mockSettlement.id) return mockSettlement;
          return null;
        }),
        findFirst: vi.fn(async () => mockSettlement),
        findMany: vi.fn(async () => [mockSettlement]),
        create: vi.fn(async () => mockSettlement),
      },
      auditLog: {
        create: vi.fn(async () => ({ id: "audit_1", createdAt: new Date() })),
      },
      $transaction: vi.fn(async (cb: any) => (typeof cb === "function" ? cb(mockPrisma) : Promise.all(cb))),
      $disconnect: vi.fn(),
    };

    return { mockUser, mockUser2, mockGroup, mockMember, mockExpense, mockSettlement, mockPrisma };
  });

vi.mock("../../src/db", () => ({ prisma: mockPrisma }));

vi.mock("../../src/services/stellar", async (importActual) => {
  const actual = await importActual<typeof import("../../src/services/stellar")>();
  return {
    ...actual,
    stellar: {
      ...actual.stellar,
      loadAccount: vi.fn(async () => ({
        exists: true,
        sequence: "100",
        balances: [{ asset_type: "native", balance: "1000.0000000" }],
        signers: [],
        thresholds: { low: 0, med: 0, high: 0 },
      })),
      submitPayment: vi.fn(),
    },
  };
});

import { buildApp } from "../../src/app";
import { signToken } from "../../src/plugins/auth";
import type {
  User,
  Group,
  GroupMember,
  Expense,
  ExpenseShare,
  Settlement,
  GroupWithSummary,
  PaginationMeta,
  ApiErrorResponse,
} from "../../src/types/contract";

describe("API Contract Alignment & Integration Test Suite", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let authToken: string;

  beforeAll(async () => {
    app = await buildApp();
    authToken = signToken({
      id: mockUser.id,
      stellarPublicKey: mockUser.stellarPublicKey,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  // 1. Auth Contract Tests
  describe("1. Auth Endpoints Contract Alignment", () => {
    it("POST /auth/challenge returns contract-compliant challenge payload", async () => {
      const validAccount = Keypair.random().publicKey();
      const res = await app.inject({
        method: "POST",
        url: "/auth/challenge",
        payload: { account: validAccount },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(typeof body.transaction).toBe("string");
      expect(body.transaction.length).toBeGreaterThan(0);
      expect(typeof body.networkPassphrase).toBe("string");
    });

    it("POST /auth/challenge rejects invalid account with standard ApiErrorResponse", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/auth/challenge",
        payload: { account: "INVALID_ACCOUNT_KEY" },
      });

      expect(res.statusCode).toBe(400);
      const body: ApiErrorResponse = res.json();
      expect(body.code).toBe("VALIDATION_ERROR");
      expect(typeof body.message).toBe("string");
      expect(typeof body.requestId).toBe("string");
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(Array.isArray(body.error.details)).toBe(true);
    });

    it("POST /auth/verify rejects malformed payload with standard ApiErrorResponse", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/auth/verify",
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      const body: ApiErrorResponse = res.json();
      expect(body.code).toBe("VALIDATION_ERROR");
      expect(typeof body.message).toBe("string");
      expect(body.error).toBeDefined();
    });
  });

  // 2. Groups Contract Tests
  describe("2. Groups Endpoints Contract Alignment", () => {
    it("POST /groups returns serialized Group DTO matching contract", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/groups",
        headers: { authorization: `Bearer ${authToken}` },
        payload: {
          name: "New Group",
          description: "A test description",
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.group).toBeDefined();

      const group: Group = body.group;
      expect(typeof group.id).toBe("string");
      expect(typeof group.name).toBe("string");
      expect(group.description === null || typeof group.description === "string").toBe(true);
      expect(typeof group.createdByUserId).toBe("string");
      expect(typeof group.treasuryEnabled).toBe("boolean");
      expect(typeof group.archived).toBe("boolean");
      expect(typeof group.createdAt).toBe("string");
      // ISO Date string format
      expect(group.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it("GET /groups returns paginated list of GroupWithSummary DTOs", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/groups?limit=10",
        headers: { authorization: `Bearer ${authToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.groups)).toBe(true);
      expect(body.meta).toBeDefined();

      const meta: PaginationMeta = body.meta;
      expect(typeof meta.hasMore).toBe("boolean");
      expect(meta.nextCursor === null || typeof meta.nextCursor === "string").toBe(true);

      if (body.groups.length > 0) {
        const item: GroupWithSummary = body.groups[0];
        expect(typeof item.id).toBe("string");
        expect(typeof item.name).toBe("string");
        expect(typeof item.memberCount).toBe("number");
        expect(typeof item.yourNet).toBe("string");
        expect(typeof item.netAssetCode).toBe("string");
      }
    });

    it("GET /groups/:id returns GroupDetailResponse with Group and GroupMember DTOs", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/groups/${mockGroup.id}`,
        headers: { authorization: `Bearer ${authToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.group).toBeDefined();
      expect(Array.isArray(body.members)).toBe(true);
      expect(typeof body.yourRole).toBe("string");
      expect(body.meta).toBeDefined();

      const group: Group = body.group;
      expect(group.id).toBe(mockGroup.id);

      const member: GroupMember = body.members[0];
      expect(typeof member.id).toBe("string");
      expect(typeof member.groupId).toBe("string");
      expect(typeof member.userId).toBe("string");
      expect(["admin", "member"]).toContain(member.role);
      expect(typeof member.joinedAt).toBe("string");
      expect(member.user).toBeDefined();

      const user: User = member.user;
      expect(typeof user.id).toBe("string");
      expect(typeof user.stellarPublicKey).toBe("string");
      expect(typeof user.displayName).toBe("string");
      expect(typeof user.createdAt).toBe("string");
    });
  });

  // 3. Expenses Contract Tests
  describe("3. Expenses Endpoints Contract Alignment", () => {
    it("GET /groups/:id/expenses returns paginated Expense DTOs with shares", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/groups/${mockGroup.id}/expenses`,
        headers: { authorization: `Bearer ${authToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.expenses)).toBe(true);
      expect(body.meta).toBeDefined();

      const meta: PaginationMeta = body.meta;
      expect(typeof meta.hasMore).toBe("boolean");
      expect(meta.nextCursor === null || typeof meta.nextCursor === "string").toBe(true);

      const expense: Expense = body.expenses[0];
      expect(typeof expense.id).toBe("string");
      expect(typeof expense.groupId).toBe("string");
      expect(typeof expense.payerUserId).toBe("string");
      expect(typeof expense.title).toBe("string");
      expect(typeof expense.amount).toBe("string");
      expect(typeof expense.assetCode).toBe("string");
      expect(typeof expense.splitType).toBe("string");
      expect(typeof expense.createdAt).toBe("string");
      expect(expense.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

      expect(Array.isArray(expense.shares)).toBe(true);
      const share: ExpenseShare = expense.shares[0];
      expect(typeof share.id).toBe("string");
      expect(typeof share.expenseId).toBe("string");
      expect(typeof share.userId).toBe("string");
      expect(typeof share.shareAmount).toBe("string");
      expect(["pending", "settled"]).toContain(share.status);
    });

    it("GET /expenses/:id returns individual Expense DTO matching contract", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/expenses/${mockExpense.id}`,
        headers: { authorization: `Bearer ${authToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.expense).toBeDefined();

      const expense: Expense = body.expense;
      expect(expense.id).toBe(mockExpense.id);
      expect(expense.shares).toHaveLength(2);
      expect(typeof expense.amount).toBe("string");
    });
  });

  // 4. Settlements Contract Tests
  describe("4. Settlements Endpoints Contract Alignment", () => {
    it("GET /groups/:id/settlements returns paginated Settlement DTOs", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/groups/${mockGroup.id}/settlements`,
        headers: { authorization: `Bearer ${authToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.settlements)).toBe(true);
      expect(body.meta).toBeDefined();

      const meta: PaginationMeta = body.meta;
      expect(typeof meta.hasMore).toBe("boolean");
      expect(meta.nextCursor === null || typeof meta.nextCursor === "string").toBe(true);

      const settlement: Settlement = body.settlements[0];
      expect(typeof settlement.id).toBe("string");
      expect(typeof settlement.groupId).toBe("string");
      expect(typeof settlement.fromUserId).toBe("string");
      expect(typeof settlement.toUserId).toBe("string");
      expect(typeof settlement.amount).toBe("string");
      expect(typeof settlement.assetCode).toBe("string");
      expect(typeof settlement.status).toBe("string");
      expect(typeof settlement.retryCount).toBe("number");
      expect(typeof settlement.createdAt).toBe("string");
      expect(settlement.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

      if (settlement.statusHistory) {
        expect(Array.isArray(settlement.statusHistory)).toBe(true);
        expect(typeof settlement.statusHistory[0].status).toBe("string");
      }
    });

    it("GET /settlements/:id/status returns Settlement DTO with status and terminal state", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/settlements/${mockSettlement.id}/status?refresh=false`,
        headers: { authorization: `Bearer ${authToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.settlement).toBeDefined();

      const settlement: Settlement = body.settlement;
      expect(settlement.id).toBe(mockSettlement.id);
      expect(typeof settlement.amount).toBe("string");
      expect(settlement.stellarTxHash).toBe(mockSettlement.stellarTxHash);
      expect(typeof body.status).toBe("string");
      expect(typeof body.terminal).toBe("boolean");
    });
  });

  // 5. Schema Validation & Error Envelope Compliance
  describe("5. Schema Validation & Error Envelopes", () => {
    it("rejects unauthorized access with 401 and contract ApiErrorResponse", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/groups",
      });

      expect(res.statusCode).toBe(401);
      const body: ApiErrorResponse = res.json();
      expect(body.code).toBe("UNAUTHORIZED");
      expect(typeof body.message).toBe("string");
      expect(typeof body.requestId).toBe("string");
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe("UNAUTHORIZED");
    });

    it("rejects bad pagination parameters with 400 and VALIDATION_ERROR envelope", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/groups?limit=9999",
        headers: { authorization: `Bearer ${authToken}` },
      });

      expect(res.statusCode).toBe(400);
      const body: ApiErrorResponse = res.json();
      expect(body.code).toBe("VALIDATION_ERROR");
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });
  });
});
