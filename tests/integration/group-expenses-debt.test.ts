import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { buildApp } from "../../src/app";
import { prisma } from "../../src/db";
import { Keypair } from "@stellar/stellar-sdk";
import { signToken } from "../../src/plugins/auth";

let app: Awaited<ReturnType<typeof buildApp>>;

describe("Group Expense and Debt Simplification Integration", () => {
  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Clean up all data
    await prisma.expenseShare.deleteMany({});
    await prisma.expense.deleteMany({});
    await prisma.groupMember.deleteMany({});
    await prisma.group.deleteMany({});
    await prisma.user.deleteMany({});
  });

  test("creates a group, adds expenses, and calculates simplified debt", async () => {
    // Setup 3 users
    const aliceKp = Keypair.random();
    const bobKp = Keypair.random();
    const charlieKp = Keypair.random();

    // Create users in DB (or let them be created via some route, but simpler to just insert)
    const alice = await prisma.user.create({
      data: { id: "alice_1", stellarPublicKey: aliceKp.publicKey(), displayName: "Alice" }
    });
    const bob = await prisma.user.create({
      data: { id: "bob_1", stellarPublicKey: bobKp.publicKey(), displayName: "Bob" }
    });
    const charlie = await prisma.user.create({
      data: { id: "charlie_1", stellarPublicKey: charlieKp.publicKey(), displayName: "Charlie" }
    });

    const aliceToken = signToken({ id: alice.id, stellarPublicKey: alice.stellarPublicKey });

    // 1. Create a group
    let res = await app.inject({
      method: "POST",
      url: "/groups",
      headers: { authorization: `Bearer ${aliceToken}` },
      payload: { name: "Debt Simplification Group" }
    });
    expect(res.statusCode).toBe(200);
    const createGroupBody = res.json();
    const groupId = createGroupBody.group.id;

    // 2. Add Bob and Charlie to group
    await prisma.groupMember.create({
      data: { groupId, userId: bob.id, role: "member" }
    });
    await prisma.groupMember.create({
      data: { groupId, userId: charlie.id, role: "member" }
    });

    // 3. Add an expense: Alice pays 30 for everyone (10 each)
    res = await app.inject({
      method: "POST",
      url: `/groups/${groupId}/expenses`,
      headers: { authorization: `Bearer ${aliceToken}` },
      payload: {
        title: "Dinner",
        amount: "30",
        assetCode: "XLM",
        payerUserId: alice.id,
        splitType: "equal",
        shares: [
          { userId: alice.id },
          { userId: bob.id },
          { userId: charlie.id }
        ]
      }
    });
    expect(res.statusCode).toBe(200);

    // 4. Query group balances
    res = await app.inject({
      method: "GET",
      url: `/groups/${groupId}/balances`,
      headers: { authorization: `Bearer ${aliceToken}` }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    
    // Check net balances
    // Alice paid 30. Shares are 10 each.
    // Alice net = +20, Bob net = -10, Charlie net = -10
    const balances = body.balances;
    expect(balances).toHaveLength(3);
    
    const aliceBalance = balances.find((b: any) => b.userId === alice.id);
    const bobBalance = balances.find((b: any) => b.userId === bob.id);
    const charlieBalance = balances.find((b: any) => b.userId === charlie.id);
    
    expect(aliceBalance.net).toBe("20");
    expect(bobBalance.net).toBe("-10");
    expect(charlieBalance.net).toBe("-10");

    // Check suggestions (simplified debt transactions)
    const suggestions = body.suggestions;
    expect(suggestions).toHaveLength(2);
    
    // Bob should owe Alice 10, and Charlie should owe Alice 10
    const bobSuggestion = suggestions.find((s: any) => s.fromUserId === bob.id);
    const charlieSuggestion = suggestions.find((s: any) => s.fromUserId === charlie.id);
    
    expect(bobSuggestion.toUserId).toBe(alice.id);
    expect(bobSuggestion.amount).toBe("10");
    expect(charlieSuggestion.toUserId).toBe(alice.id);
    expect(charlieSuggestion.amount).toBe("10");
  });
});
