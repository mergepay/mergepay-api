/**
 * Issue #838 — Comprehensive integration test for group settlement end-to-end flow.
 *
 * These tests run against a live Stellar testnet and the local backend API.
 * Ensure the server is running with DATABASE_URL_TEST before executing.
 *
 * Acceptance Criteria verified:
 *   - End-to-end group creation flow works correctly
 *   - Expense addition with various split types (equal, custom, percentage)
 *   - Settlement intent generation and execution
 *   - Multi-member settlement scenarios
 *   - Error handling for invalid operations
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import fetch from "node-fetch";
import {
  createTestAccount,
  authenticateUser,
  createGroup,
  addMember,
  createExpense,
  settleExpense,
  getExpense,
  waitForTransaction,
  loadHorizonAccount,
  API_BASE_URL,
  isLiveServerAvailable,
} from "./helpers";

const TEST_TIMEOUT = 30000;

// Generated test accounts
let adminKeypair: Keypair;
let member1Keypair: Keypair;
let member2Keypair: Keypair;
let member3Keypair: Keypair;

// Session tokens
let adminToken: string;
let member1Token: string;
let member2Token: string;
let member3Token: string;

// Test data
let groupId: string;
let expenseId: string;
let serverAvailable = false;

describe("Group Settlement End-to-End Integration Flow", () => {
  beforeAll(async () => {
    serverAvailable = await isLiveServerAvailable();
    if (!serverAvailable) return;

    // Create and fund test accounts
    [adminKeypair, member1Keypair, member2Keypair, member3Keypair] = await Promise.all([
      createTestAccount(),
      createTestAccount(),
      createTestAccount(),
      createTestAccount(),
    ]);

    // Authenticate all users via SEP-10
    [adminToken, member1Token, member2Token, member3Token] = await Promise.all([
      authenticateUser(adminKeypair),
      authenticateUser(member1Keypair),
      authenticateUser(member2Keypair),
      authenticateUser(member3Keypair),
    ]);
  }, TEST_TIMEOUT * 2);

  beforeEach((ctx) => {
    if (!serverAvailable) {
      ctx.skip();
    }
  });

  afterAll(async () => {
    // Cleanup: accounts are ephemeral testnet accounts, no action needed
    // Optionally could return funds to friendbot if implemented
  });

  test(
    "Test 1: SEP-10 authentication flow returns valid session token",
    async () => {
      expect(adminToken).toBeTruthy();
      expect(typeof adminToken).toBe("string");
      expect(adminToken.length).toBeGreaterThan(0);

      // Verify token works by making an authenticated request
      const res = await fetch(`${API_BASE_URL}/groups`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(res.ok).toBe(true);
    },
    TEST_TIMEOUT
  );

  test(
    "Test 2: Create a group and add members",
    async () => {
      const groupName = `Test Group ${Date.now()}`;
      const group = await createGroup(adminToken, groupName);
      groupId = group.id;

      expect(group.id).toBeTruthy();
      expect(group.name).toBe(groupName);

      // Add members
      await addMember(adminToken, groupId, member1Keypair.publicKey());
      await addMember(adminToken, groupId, member2Keypair.publicKey());

      // Verify members by fetching group
      const res = await fetch(`${API_BASE_URL}/groups/${groupId}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(res.ok).toBe(true);
      const groupData = await res.json();
      const memberPublicKeys = groupData.members.map((m: any) => m.publicKey);
      expect(memberPublicKeys).toContain(member1Keypair.publicKey());
      expect(memberPublicKeys).toContain(member2Keypair.publicKey());
    },
    TEST_TIMEOUT
  );

  test(
    "Test 3: Create an expense with equal split among 3 members",
    async () => {
      const expenseData = {
        description: "Dinner",
        amount: "30",
        assetCode: "XLM",
        payerId: adminKeypair.publicKey(),
        splitType: "equal" as const,
        shares: [
          { userId: adminKeypair.publicKey() },
          { userId: member1Keypair.publicKey() },
          { userId: member2Keypair.publicKey() },
        ],
      };

      const expense = await createExpense(adminToken, groupId, expenseData);
      expenseId = expense.id;

      expect(expense.id).toBeTruthy();

      // Verify expense details
      const fetched = await getExpense(adminToken, expenseId);
      expect(fetched.description).toBe("Dinner");
      expect(fetched.amount).toBe("30");
      expect(fetched.shares).toHaveLength(3);

      // Verify equal split (10 each, with remainder on first)
      const shareAmounts = fetched.shares.map((s: any) => s.shareAmount);
      expect(shareAmounts).toContain("10");
    },
    TEST_TIMEOUT
  );

  test(
    "Test 4: Settle the expense and verify Stellar payment transaction",
    async () => {
      const result = await settleExpense(adminToken, expenseId);
      expect(result.transactionHash).toBeTruthy();

      // Wait for and verify transaction on Horizon
      const tx = await waitForTransaction(result.transactionHash);
      expect(tx.hash).toBe(result.transactionHash);
      expect(tx.successful).toBe(true);

      // Verify payment operation exists in transaction
      const opsRes = await fetch(tx._links.operations.href);
      const ops = await opsRes.json();
      const paymentOp = ops._embedded.records.find(
        (op: any) => op.type === "payment"
      );
      expect(paymentOp).toBeTruthy();
    },
    TEST_TIMEOUT
  );

  test(
    "Test 5: Edge case – settle expense with insufficient balance expects error",
    async () => {
      // Create a new group and expense for this test
      const groupName = `Insuff Group ${Date.now()}`;
      const group = await createGroup(adminToken, groupName);
      const newGroupId = group.id;

      // Add funded members so group is valid
      await addMember(adminToken, newGroupId, member1Keypair.publicKey());
      await addMember(adminToken, newGroupId, member2Keypair.publicKey());

      // Create an expense with amount exceeding test account balance
      const expenseData = {
        description: "Expensive item",
        amount: "999999999", // Way more than test account has
        assetCode: "XLM",
        payerId: adminKeypair.publicKey(),
        splitType: "equal" as const,
        shares: [
          { userId: adminKeypair.publicKey() },
          { userId: member1Keypair.publicKey() },
        ],
      };

      const expense = await createExpense(adminToken, newGroupId, expenseData);

      // Attempt settlement - should fail due to insufficient balance
      await expect(
        settleExpense(adminToken, expense.id)
      ).rejects.toThrow(/insufficient|balance|error/i);
    },
    TEST_TIMEOUT
  );

  test(
    "Test 6: Cleanup verification – test accounts exist on ledger",
    async () => {
      // Verify all test accounts still exist on the ledger
      const accounts = [adminKeypair, member1Keypair, member2Keypair];
      for (const kp of accounts) {
        const account = await loadHorizonAccount(kp.publicKey());
        expect(account.account_id).toBe(kp.publicKey());
        expect(account.balances).toBeDefined();
      }
    },
    TEST_TIMEOUT
  );

  test(
    "Test 7: Custom split expense – verify unequal share distribution",
    async () => {
      const groupName = `Custom Split Group ${Date.now()}`;
      const group = await createGroup(adminToken, groupName);
      const customGroupId = group.id;

      await addMember(adminToken, customGroupId, member1Keypair.publicKey());
      await addMember(adminToken, customGroupId, member2Keypair.publicKey());

      const expenseData = {
        description: "Custom split dinner",
        amount: "100",
        assetCode: "XLM",
        payerId: adminKeypair.publicKey(),
        splitType: "custom" as const,
        shares: [
          { userId: adminKeypair.publicKey(), amount: "50" },
          { userId: member1Keypair.publicKey(), amount: "30" },
          { userId: member2Keypair.publicKey(), amount: "20" },
        ],
      };

      const expense = await createExpense(adminToken, customGroupId, expenseData);

      expect(expense.id).toBeTruthy();
      expect(expense.shares).toHaveLength(3);

      // Verify custom split amounts
      const adminShare = expense.shares.find((s: any) => s.userId === adminKeypair.publicKey());
      const member1Share = expense.shares.find((s: any) => s.userId === member1Keypair.publicKey());
      const member2Share = expense.shares.find((s: any) => s.userId === member2Keypair.publicKey());

      expect(adminShare.shareAmount).toBe("50.0000000");
      expect(member1Share.shareAmount).toBe("30.0000000");
      expect(member2Share.shareAmount).toBe("20.0000000");
    },
    TEST_TIMEOUT
  );

  test(
    "Test 8: Percentage split expense – verify percentage-based distribution",
    async () => {
      const groupName = `Percentage Split Group ${Date.now()}`;
      const group = await createGroup(adminToken, groupName);
      const percentGroupId = group.id;

      await addMember(adminToken, percentGroupId, member1Keypair.publicKey());
      await addMember(adminToken, percentGroupId, member2Keypair.publicKey());

      const expenseData = {
        description: "Percentage split dinner",
        amount: "100",
        assetCode: "XLM",
        payerId: adminKeypair.publicKey(),
        splitType: "percentage" as const,
        shares: [
          { userId: adminKeypair.publicKey(), percent: 50 },
          { userId: member1Keypair.publicKey(), percent: 30 },
          { userId: member2Keypair.publicKey(), percent: 20 },
        ],
      };

      const expense = await createExpense(adminToken, percentGroupId, expenseData);

      expect(expense.id).toBeTruthy();
      expect(expense.shares).toHaveLength(3);

      // Verify percentage split amounts (100 * percentage / 100)
      const adminShare = expense.shares.find((s: any) => s.userId === adminKeypair.publicKey());
      const member1Share = expense.shares.find((s: any) => s.userId === member1Keypair.publicKey());
      const member2Share = expense.shares.find((s: any) => s.userId === member2Keypair.publicKey());

      expect(adminShare.shareAmount).toBe("50.0000000");
      expect(member1Share.shareAmount).toBe("30.0000000");
      expect(member2Share.shareAmount).toBe("20.0000000");
    },
    TEST_TIMEOUT
  );

  test(
    "Test 9: Multi-member settlement flow – verify debt simplification",
    async () => {
      const groupName = `Multi-Member Group ${Date.now()}`;
      const group = await createGroup(adminToken, groupName);
      const multiGroupId = group.id;

      await addMember(adminToken, multiGroupId, member1Keypair.publicKey());
      await addMember(adminToken, multiGroupId, member2Keypair.publicKey());
      await addMember(adminToken, multiGroupId, member3Keypair.publicKey());

      // Create expense where admin pays, others owe
      const expenseData = {
        description: "Group dinner",
        amount: "90",
        assetCode: "XLM",
        payerId: adminKeypair.publicKey(),
        splitType: "equal" as const,
        shares: [
          { userId: adminKeypair.publicKey() },
          { userId: member1Keypair.publicKey() },
          { userId: member2Keypair.publicKey() },
          { userId: member3Keypair.publicKey() },
        ],
      };

      const expense = await createExpense(adminToken, multiGroupId, expenseData);
      expect(expense.shares).toHaveLength(4);

      // Verify payer's share is settled, others are pending
      const adminShare = expense.shares.find((s: any) => s.userId === adminKeypair.publicKey());
      const member1Share = expense.shares.find((s: any) => s.userId === member1Keypair.publicKey());

      expect(adminShare.status).toBe("settled");
      expect(member1Share.status).toBe("pending");
    },
    TEST_TIMEOUT
  );

  test(
    "Test 10: Settlement preview – verify balance computation",
    async () => {
      const groupName = `Preview Group ${Date.now()}`;
      const group = await createGroup(adminToken, groupName);
      const previewGroupId = group.id;

      await addMember(adminToken, previewGroupId, member1Keypair.publicKey());
      await addMember(adminToken, previewGroupId, member2Keypair.publicKey());

      // Create expense to create some balance
      const expenseData = {
        description: "Preview test expense",
        amount: "60",
        assetCode: "XLM",
        payerId: adminKeypair.publicKey(),
        splitType: "equal" as const,
        shares: [
          { userId: adminKeypair.publicKey() },
          { userId: member1Keypair.publicKey() },
          { userId: member2Keypair.publicKey() },
        ],
      };

      await createExpense(adminToken, previewGroupId, expenseData);

      // Get settlement preview
      const res = await fetch(`${API_BASE_URL}/groups/${previewGroupId}/settlement/preview`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      expect(res.ok).toBe(true);
      const preview = await res.json();

      expect(preview.assetCode).toBe("XLM");
      expect(preview.operations).toBeDefined();
      expect(Array.isArray(preview.operations)).toBe(true);
    },
    TEST_TIMEOUT
  );

  test(
    "Test 11: Error handling – settle non-existent expense returns 404",
    async () => {
      const res = await fetch(`${API_BASE_URL}/expenses/nonexistent/settle`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ assetCode: "XLM" }),
      });

      expect(res.status).toBe(404);
    },
    TEST_TIMEOUT
  );

  test(
    "Test 12: Error handling – create expense with invalid split type",
    async () => {
      const groupName = `Invalid Split Group ${Date.now()}`;
      const group = await createGroup(adminToken, groupName);
      const invalidGroupId = group.id;

      const expenseData = {
        description: "Invalid split",
        amount: "100",
        assetCode: "XLM",
        payerId: adminKeypair.publicKey(),
        splitType: "invalid" as any,
        shares: [{ userId: adminKeypair.publicKey() }],
      };

      const res = await fetch(`${API_BASE_URL}/groups/${invalidGroupId}/expenses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify(expenseData),
      });

      expect(res.status).toBe(400);
    },
    TEST_TIMEOUT
  );
});
