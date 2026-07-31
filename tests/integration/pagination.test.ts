import { describe, test, expect, beforeAll } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import fetch from "node-fetch";
import {
  createTestAccount,
  authenticateUser,
  createGroup,
  createExpense,
  API_BASE_URL,
} from "./helpers";

const TEST_TIMEOUT = 30000;

describe("Pagination Integration Flow", () => {
  let adminToken: string;
  let adminKeypair: Keypair;
  let groupId: string;

  beforeAll(async () => {
    adminKeypair = await createTestAccount();
    adminToken = await authenticateUser(adminKeypair);
    const group = await createGroup(adminToken, "Pagination Test Group");
    groupId = group.id;
  }, TEST_TIMEOUT * 2);

  test(
    "generates a large dataset and verifies predictable cursor pagination ordering",
    async () => {
      // 1. Create a representative large dataset (e.g. 15 expenses)
      const expensesCount = 15;
      for (let i = 0; i < expensesCount; i++) {
        await createExpense(adminToken, groupId, {
          description: `Expense ${i}`,
          amount: "10",
          assetCode: "XLM",
          payerId: adminKeypair.publicKey(),
          splitType: "equal",
          shares: [{ userId: adminKeypair.publicKey() }],
        });
        // small delay to ensure slightly different timestamps just in case
        await new Promise((r) => setTimeout(r, 10));
      }

      // 2. Fetch first page with limit 6
      const res1 = await fetch(`${API_BASE_URL}/groups/${groupId}/expenses?limit=6`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(res1.ok).toBe(true);
      const page1 = await res1.json();
      expect(page1.expenses).toHaveLength(6);
      expect(page1.meta.hasMore).toBe(true);
      expect(page1.meta.nextCursor).toBeTruthy();

      // 3. Fetch second page with limit 6
      const res2 = await fetch(
        `${API_BASE_URL}/groups/${groupId}/expenses?limit=6&cursor=${page1.meta.nextCursor}`,
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );
      expect(res2.ok).toBe(true);
      const page2 = await res2.json();
      expect(page2.expenses).toHaveLength(6);
      expect(page2.meta.hasMore).toBe(true);
      expect(page2.meta.nextCursor).toBeTruthy();

      // 4. Fetch third page with limit 6 (should only return remaining 3)
      const res3 = await fetch(
        `${API_BASE_URL}/groups/${groupId}/expenses?limit=6&cursor=${page2.meta.nextCursor}`,
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );
      expect(res3.ok).toBe(true);
      const page3 = await res3.json();
      expect(page3.expenses).toHaveLength(3);
      expect(page3.meta.hasMore).toBe(false);
      expect(page3.meta.nextCursor).toBeNull();

      // Every page echoes the shared pagination metadata.
      for (const page of [page1, page2, page3]) {
        expect(page.meta.limit).toBe(6);
        expect(page.meta.order).toBe("desc");
      }

      // 5. Verify ordering: check that no items are duplicated or skipped
      const allFetchedIds = new Set([
        ...page1.expenses.map((e: any) => e.id),
        ...page2.expenses.map((e: any) => e.id),
        ...page3.expenses.map((e: any) => e.id),
      ]);
      expect(allFetchedIds.size).toBe(15);
    },
    TEST_TIMEOUT
  );

  test(
    "bounds page size and rejects malformed pagination input",
    async () => {
      const headers = { Authorization: `Bearer ${adminToken}` };

      const overMax = await fetch(
        `${API_BASE_URL}/groups/${groupId}/expenses?limit=9999`,
        { headers }
      );
      expect(overMax.status).toBe(400);
      expect((await overMax.json()).error).toBe("VALIDATION_ERROR");

      const badCursor = await fetch(
        `${API_BASE_URL}/groups/${groupId}/expenses?cursor=not-a-cursor`,
        { headers }
      );
      expect(badCursor.status).toBe(400);
      expect((await badCursor.json()).error).toBe("INVALID_CURSOR");

      // The default page size is applied and reported, never unbounded.
      const defaults = await fetch(`${API_BASE_URL}/groups/${groupId}/expenses`, {
        headers,
      });
      const body = await defaults.json();
      expect(body.meta.limit).toBe(50);
      expect(body.expenses.length).toBeLessThanOrEqual(50);
    },
    TEST_TIMEOUT
  );
});
