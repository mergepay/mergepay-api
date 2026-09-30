/**
 * Integration tests: full SEP-10 authentication to settlement flow.
 *
 * These tests run against a live Stellar testnet and the local backend API.
 * Ensure the server is running with DATABASE_URL_TEST before executing.
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

// Session tokens
let adminToken: string;
let member1Token: string;
let member2Token: string;

// Test data
let groupId: string;
let expenseId: string;
let serverAvailable = false;

describe("SEP-10 to Settlement Integration Flow", () => {
  beforeAll(async () => {
    serverAvailable = await isLiveServerAvailable();
    if (!serverAvailable) return;

    // Create and fund test accounts
    [adminKeypair, member1Keypair, member2Keypair] = await Promise.all([
      createTestAccount(),
      createTestAccount(),
      createTestAccount(),
    ]);

    // Authenticate all users via SEP-10
    [adminToken, member1Token, member2Token] = await Promise.all([
      authenticateUser(adminKeypair),
      authenticateUser(member1Keypair),
      authenticateUser(member2Keypair),
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
});
