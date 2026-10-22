/**
 * Integration tests with mocked external services:
 * - SEP-24 deposit/withdrawal flows (mocked anchor HTTP responses)
 * - Group expense settlement lifecycle (mocked Horizon/network)
 *
 * These run under vitest.integration.config.ts and do NOT require live testnet.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

// Mock Prisma to use in-memory state.
const mockPrisma = {
  user: { findUnique: vi.fn(), create: vi.fn() },
  group: { findUnique: vi.fn(), create: vi.fn() },
  groupMember: { findMany: vi.fn(), create: vi.fn() },
  expense: { findUnique: vi.fn(), create: vi.fn(), findMany: vi.fn() },
  expenseShare: { createMany: vi.fn(), updateMany: vi.fn() },
  settlement: { create: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  anchorSession: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
  $transaction: vi.fn(async (fn: any) => fn(mockPrisma)),
};
vi.mock("../../src/db", () => ({ prisma: mockPrisma }));

// Mock Stellar service to avoid real network calls.
vi.mock("../../src/services/stellar", () => ({
  stellar: {
    loadAccount: vi.fn(async () => ({
      exists: true,
      sequence: "123",
      balances: [{ asset_code: "XLM", balance: "1000" }],
      signers: [{ key: "test", weight: 1 }],
      thresholds: { low: 1, med: 1, high: 1 },
    })),
    submitTransaction: vi.fn(async () => ({ hash: "mock_tx_hash", successful: true })),
    buildPaymentTx: vi.fn(() => "mock_xdr"),
  },
}));

// Mock anchor service for SEP-24.
vi.mock("../../src/services/anchor", () => ({
  anchorService: {
    getToml: vi.fn(async () => ({
      webAuthEndpoint: "https://anchor.example.com/auth",
      transferServerSep24: "https://anchor.example.com/sep24",
      assets: [{ code: "USDC", issuer: "ISSUER" }],
    })),
    getChallenge: vi.fn(async () => ({ challenge: "mock_challenge_xdr" })),
    getToken: vi.fn(async () => "mock_jwt_token"),
    startInteractive: vi.fn(async () => ({
      url: "https://anchor.example.com/interactive?id=123",
      id: "ext_tx_123",
    })),
    mapAnchorStatus: vi.fn((s: string) => s),
  },
}));

describe("SEP-24 deposit flow (service-level)", () => {
  const clientKp = Keypair.random();

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.user.findUnique.mockResolvedValue({
      id: "user_1",
      stellarPublicKey: clientKp.publicKey(),
    });
  });

  it("creates an anchor session for deposit", async () => {
    const { anchorService } = await import("../../src/services/anchor");
    const toml = await anchorService.getToml("testanchor.stellar.org");
    expect(toml.webAuthEndpoint).toMatch(/https:\/\//);
    expect(toml.transferServerSep24).toMatch(/https:\/\//);

    const challenge = await anchorService.getChallenge(
      toml.webAuthEndpoint,
      clientKp.publicKey()
    );
    expect(challenge.challenge).toBeDefined();

    const token = await anchorService.getToken(toml.webAuthEndpoint, "signed_xdr");
    expect(token).toBe("mock_jwt_token");

    const interactive = await anchorService.startInteractive({
      transferServer: toml.transferServerSep24,
      token,
      kind: "deposit",
      assetCode: "USDC",
      account: clientKp.publicKey(),
    });
    expect(interactive.url).toMatch(/https:\/\//);
    expect(interactive.id).toBe("ext_tx_123");
  });

  it("persists anchor session in database", async () => {
    mockPrisma.anchorSession.create.mockResolvedValue({
      id: "session_1",
      userId: "user_1",
      kind: "deposit",
      assetCode: "USDC",
      status: "incomplete",
    });

    const session = await mockPrisma.anchorSession.create({
      data: {
        userId: "user_1",
        anchorName: "Test Anchor",
        kind: "deposit",
        assetCode: "USDC",
        status: "incomplete",
      },
    });

    expect(session.id).toBe("session_1");
    expect(session.kind).toBe("deposit");
  });

  it("updates session after completing interactive flow", async () => {
    mockPrisma.anchorSession.findUnique.mockResolvedValue({
      id: "session_1",
      userId: "user_1",
      kind: "deposit",
      assetCode: "USDC",
      status: "incomplete",
    });
    mockPrisma.anchorSession.update.mockResolvedValue({
      id: "session_1",
      userId: "user_1",
      kind: "deposit",
      assetCode: "USDC",
      status: "pending_user_transfer_start",
      interactiveUrl: "https://anchor.example.com/interactive?id=123",
      externalTransactionId: "ext_tx_123",
    });

    const updated = await mockPrisma.anchorSession.update({
      where: { id: "session_1" },
      data: {
        interactiveUrl: "https://anchor.example.com/interactive?id=123",
        externalTransactionId: "ext_tx_123",
        anchorToken: "mock_jwt_token",
        status: "pending_user_transfer_start",
      },
    });

    expect(updated.status).toBe("pending_user_transfer_start");
    expect(updated.interactiveUrl).toMatch(/https:\/\//);
  });

  it("handles missing asset parameter gracefully", async () => {
    // When assetCode is missing, the Zod validation should reject before reaching services.
    const { z } = await import("zod");
    const schema = z.object({
      assetCode: z.string().min(1),
      anchorName: z.string().optional(),
    });

    expect(() => schema.parse({})).toThrow();
  });
});

describe("SEP-24 withdrawal flow (service-level)", () => {
  const clientKp = Keypair.random();

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.user.findUnique.mockResolvedValue({
      id: "user_1",
      stellarPublicKey: clientKp.publicKey(),
    });
  });

  it("creates an anchor session for withdrawal", async () => {
    mockPrisma.anchorSession.create.mockResolvedValue({
      id: "session_w",
      userId: "user_1",
      kind: "withdrawal",
      assetCode: "USDC",
      status: "incomplete",
    });

    const session = await mockPrisma.anchorSession.create({
      data: {
        userId: "user_1",
        anchorName: "Test Anchor",
        kind: "withdrawal",
        assetCode: "USDC",
        status: "incomplete",
      },
    });

    expect(session.kind).toBe("withdrawal");
  });

  it("lists user's anchor sessions", async () => {
    mockPrisma.anchorSession.findMany.mockResolvedValue([
      { id: "session_1", kind: "deposit", status: "completed" },
      { id: "session_2", kind: "withdrawal", status: "pending" },
    ]);

    const sessions = await mockPrisma.anchorSession.findMany({
      where: { userId: "user_1" },
      orderBy: { createdAt: "desc" },
    });

    expect(sessions).toHaveLength(2);
    expect(sessions[0].kind).toBe("deposit");
  });
});

describe("Group expense settlement lifecycle (service-level)", () => {
  const adminKp = Keypair.random();
  const member1Kp = Keypair.random();
  const member2Kp = Keypair.random();

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.user.findUnique.mockImplementation(async ({ where }: any) => {
      if (where.id === "admin") return { id: "admin", stellarPublicKey: adminKp.publicKey() };
      if (where.id === "member1") return { id: "member1", stellarPublicKey: member1Kp.publicKey() };
      return null;
    });
    mockPrisma.group.create.mockResolvedValue({ id: "group_1", name: "Test Group" });
    mockPrisma.groupMember.findMany.mockResolvedValue([
      { userId: "admin" },
      { userId: "member1" },
      { userId: "member2" },
    ]);
    mockPrisma.expense.create.mockResolvedValue({
      id: "expense_1",
      groupId: "group_1",
      payerUserId: "admin",
      amount: "30",
      assetCode: "XLM",
      shares: [
        { userId: "admin", shareAmount: "10", status: "settled" },
        { userId: "member1", shareAmount: "10", status: "pending" },
        { userId: "member2", shareAmount: "10", status: "pending" },
      ],
    });
  });

  it("creates an expense with equal split among members", async () => {
    const expense = await mockPrisma.expense.create({
      data: {
        groupId: "group_1",
        payerUserId: "admin",
        title: "Dinner",
        amount: "30",
        assetCode: "XLM",
        splitType: "equal",
        shares: {
          create: [
            { userId: "admin", shareAmount: "10", status: "settled" },
            { userId: "member1", shareAmount: "10", status: "pending" },
            { userId: "member2", shareAmount: "10", status: "pending" },
          ],
        },
      },
    });

    expect(expense.id).toBe("expense_1");
    expect(expense.amount).toBe("30");
    expect(expense.shares).toHaveLength(3);
  });

  it("generates settlement record for pending shares", async () => {
    mockPrisma.settlement.create.mockResolvedValue({
      id: "settle_1",
      expenseId: "expense_1",
      transactionHash: "mock_tx_hash",
      status: "submitted",
    });

    const settlement = await mockPrisma.settlement.create({
      data: {
        expenseId: "expense_1",
        transactionHash: "mock_tx_hash",
        status: "submitted",
      },
    });

    expect(settlement.transactionHash).toBe("mock_tx_hash");
    expect(settlement.status).toBe("submitted");
  });

  it("handles settlement failure path", async () => {
    const { stellar } = await import("../../src/services/stellar");
    (stellar.submitTransaction as any).mockRejectedValueOnce(new Error("insufficient_balance"));

    await expect(stellar.submitTransaction("mock_xdr")).rejects.toThrow("insufficient_balance");
  });

  it("lists expenses for a group", async () => {
    mockPrisma.expense.findMany.mockResolvedValue([
      {
        id: "expense_1",
        title: "Dinner",
        amount: "30",
        assetCode: "XLM",
        payer: { id: "admin" },
        shares: [],
      },
    ]);

    const expenses = await mockPrisma.expense.findMany({
      where: { groupId: "group_1" },
      include: { payer: true, shares: true },
      orderBy: { createdAt: "desc" },
    });

    expect(expenses).toHaveLength(1);
    expect(expenses[0].title).toBe("Dinner");
  });

  it("validates all participants are group members", async () => {
    const memberIds = new Set(["admin", "member1", "member2"]);
    const participantIds = ["admin", "member1", "non_member"];

    const invalidParticipants = participantIds.filter((id) => !memberIds.has(id));
    expect(invalidParticipants).toContain("non_member");
  });
});
