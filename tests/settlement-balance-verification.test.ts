import { describe, it, expect, vi, beforeEach } from "vitest";
import { verifySettlementLimit } from "../src/services/group-balances";

describe("Settlement Balance Verification (#513)", () => {
  const groupId = "group_1";
  const fromUserId = "user_payer";
  const toUserId = "user_receiver";

  // We mock a transaction client
  let txMock: any;
  let mockExpenses: any[];
  let mockSettlements: any[];

  beforeEach(() => {
    mockExpenses = [];
    mockSettlements = [];

    txMock = {
      expense: {
        findMany: vi.fn(async () => mockExpenses)
      },
      settlement: {
        findMany: vi.fn(async (args) => {
          if (args?.where?.status?.not === "failed") {
            return mockSettlements.filter(s => s.status !== "failed");
          }
          return mockSettlements;
        })
      }
    };
  });

  it("Valid settlements within debt limits succeed", async () => {
    // Payer owes Receiver $10.00
    mockExpenses.push({
      groupId,
      payerUserId: toUserId,
      shares: [
        { userId: fromUserId, shareAmount: "10.00", status: "pending" }
      ]
    });

    // Should succeed for $5.00
    await expect(
      verifySettlementLimit(txMock, groupId, fromUserId, toUserId, "5.00")
    ).resolves.toBeUndefined();

    // Should succeed for $10.00
    await expect(
      verifySettlementLimit(txMock, groupId, fromUserId, toUserId, "10.00")
    ).resolves.toBeUndefined();
  });

  it("Settlement amounts exceeding the outstanding debt fail with the descriptive error", async () => {
    // Payer owes Receiver $10.00
    mockExpenses.push({
      groupId,
      payerUserId: toUserId,
      shares: [
        { userId: fromUserId, shareAmount: "10.00", status: "pending" }
      ]
    });

    // Try to settle $15.00
    await expect(
      verifySettlementLimit(txMock, groupId, fromUserId, toUserId, "15.00")
    ).rejects.toMatchObject({
      code: "OVER_SETTLEMENT",
      message: "Settlement amount exceeds outstanding debt balance"
    });
  });

  it("Concurrent/subsequent settlement attempts that together exceed the initial debt reject the excess payment", async () => {
    // Initial debt is $20.00
    mockExpenses.push({
      groupId,
      payerUserId: toUserId,
      shares: [
        { userId: fromUserId, shareAmount: "20.00", status: "pending" }
      ]
    });

    // A pending settlement of $15.00 already exists!
    mockSettlements.push({
      groupId,
      fromUserId: fromUserId,
      toUserId: toUserId,
      amount: "15.00",
      status: "pending"
    });

    // A subsequent settlement attempt for $10.00 should fail because $15 + $10 > $20
    await expect(
      verifySettlementLimit(txMock, groupId, fromUserId, toUserId, "10.00")
    ).rejects.toMatchObject({
      code: "OVER_SETTLEMENT"
    });

    // A subsequent settlement attempt for $5.00 should succeed because $15 + $5 <= $20
    await expect(
      verifySettlementLimit(txMock, groupId, fromUserId, toUserId, "5.00")
    ).resolves.toBeUndefined();
  });

  it("Handles offsetting debts correctly", async () => {
    // Receiver paid $30 for Payer
    mockExpenses.push({
      groupId,
      payerUserId: toUserId,
      shares: [
        { userId: fromUserId, shareAmount: "30.00", status: "pending" }
      ]
    });

    // Payer paid $10 for Receiver
    mockExpenses.push({
      groupId,
      payerUserId: fromUserId,
      shares: [
        { userId: toUserId, shareAmount: "10.00", status: "pending" }
      ]
    });

    // Net debt is $20.00

    // Should succeed for $20.00
    await expect(
      verifySettlementLimit(txMock, groupId, fromUserId, toUserId, "20.00")
    ).resolves.toBeUndefined();

    // Should fail for $25.00
    await expect(
      verifySettlementLimit(txMock, groupId, fromUserId, toUserId, "25.00")
    ).rejects.toMatchObject({
      code: "OVER_SETTLEMENT"
    });
  });

  it("Ignores settled shares and failed settlements", async () => {
    // Receiver paid $20 for Payer, but it's already settled
    mockExpenses.push({
      groupId,
      payerUserId: toUserId,
      shares: [
        { userId: fromUserId, shareAmount: "20.00", status: "settled" },
        { userId: fromUserId, shareAmount: "10.00", status: "pending" } // only 10 is active
      ]
    });

    // A failed settlement of $15.00 exists
    mockSettlements.push({
      groupId,
      fromUserId: fromUserId,
      toUserId: toUserId,
      amount: "15.00",
      status: "failed" // failed settlements do NOT reduce the limit!
    });

    // Should succeed for $10.00
    await expect(
      verifySettlementLimit(txMock, groupId, fromUserId, toUserId, "10.00")
    ).resolves.toBeUndefined();
    
    // Should fail for $10.01
    await expect(
      verifySettlementLimit(txMock, groupId, fromUserId, toUserId, "10.01")
    ).rejects.toMatchObject({
      code: "OVER_SETTLEMENT"
    });
  });
});
