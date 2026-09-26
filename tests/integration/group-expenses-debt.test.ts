import { describe, test, expect, beforeAll } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import fetch from "node-fetch";
import {
  createTestAccount,
  authenticateUser,
  createGroup,
  addMember,
  createExpense,
  API_BASE_URL,
} from "./helpers";

const TEST_TIMEOUT = 30000;

describe("Group Expense and Debt Simplification Integration", () => {
  let aliceKp: Keypair;
  let bobKp: Keypair;
  let charlieKp: Keypair;
  let aliceToken: string;
  let bobToken: string;
  let charlieToken: string;

  beforeAll(async () => {
    [aliceKp, bobKp, charlieKp] = await Promise.all([
      createTestAccount(),
      createTestAccount(),
      createTestAccount(),
    ]);

    [aliceToken, bobToken, charlieToken] = await Promise.all([
      authenticateUser(aliceKp),
      authenticateUser(bobKp),
      authenticateUser(charlieKp),
    ]);
  }, TEST_TIMEOUT * 2);

  test(
    "creates a group, adds expenses, and calculates simplified debt",
    async () => {
      // 1. Create a group
      const group = await createGroup(aliceToken, "Debt Simplification Group");
      const groupId = group.id;

      // 2. Add Bob and Charlie to group
      await addMember(aliceToken, groupId, bobKp.publicKey());
      await addMember(aliceToken, groupId, charlieKp.publicKey());

      // 3. Add an expense: Alice pays 30 for everyone (10 each)
      await createExpense(aliceToken, groupId, {
        description: "Dinner",
        amount: "30",
        assetCode: "XLM",
        payerId: aliceKp.publicKey(),
        splitType: "equal",
        shares: [
          { userId: aliceKp.publicKey() },
          { userId: bobKp.publicKey() },
          { userId: charlieKp.publicKey() },
        ],
      });

      // 4. Query group balances
      const res = await fetch(`${API_BASE_URL}/groups/${groupId}/balances`, {
        headers: { Authorization: `Bearer ${aliceToken}` },
      });
      expect(res.ok).toBe(true);
      const body = await res.json();

      // Check net balances
      const balances = body.balances;
      expect(balances).toHaveLength(3);

      const aliceBalance = balances.find((b: any) => b.user.stellarPublicKey === aliceKp.publicKey());
      const bobBalance = balances.find((b: any) => b.user.stellarPublicKey === bobKp.publicKey());
      const charlieBalance = balances.find((b: any) => b.user.stellarPublicKey === charlieKp.publicKey());

      expect(aliceBalance.net).toBe("20");
      expect(bobBalance.net).toBe("-10");
      expect(charlieBalance.net).toBe("-10");

      // Check suggestions (simplified debt transactions)
      const suggestions = body.suggestions;
      expect(suggestions).toHaveLength(2);

      const bobSuggestion = suggestions.find((s: any) => s.from.stellarPublicKey === bobKp.publicKey());
      const charlieSuggestion = suggestions.find((s: any) => s.from.stellarPublicKey === charlieKp.publicKey());

      expect(bobSuggestion.to.stellarPublicKey).toBe(aliceKp.publicKey());
      expect(bobSuggestion.amount).toBe("10");
      expect(charlieSuggestion.to.stellarPublicKey).toBe(aliceKp.publicKey());
      expect(charlieSuggestion.amount).toBe("10");
    },
    TEST_TIMEOUT
  );
});
