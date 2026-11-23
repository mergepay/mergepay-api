/**
 * Database-backed fixtures for the Postgres integration suite.
 *
 * Unlike `tests/integration/helpers.ts` (which drives a live API and Stellar
 * testnet), these helpers seed the real database directly and then drive the
 * Fastify app with `app.inject`, so the full route -> service -> Prisma path is
 * exercised without an HTTP server or a funded Stellar account.
 *
 * Every created user and group is tracked so a test file can clean up with a
 * single `cleanupSeededData()` call.
 */
import type { FastifyInstance } from "fastify";
import { Keypair } from "@stellar/stellar-sdk";
import { prisma } from "../../src/db";
import { signToken } from "../../src/plugins/auth";

export interface SeededUser {
  id: string;
  stellarPublicKey: string;
  displayName: string;
  keypair: Keypair;
  token: string;
}

export interface SeededGroup {
  id: string;
  name: string;
}

export interface ExpenseShareInput {
  userId: string;
  amount?: string;
  percent?: number;
}

export interface ExpensePayload {
  title: string;
  description?: string;
  amount: string;
  assetCode?: string;
  assetIssuer?: string | null;
  splitType: "equal" | "custom" | "percentage";
  shares: ExpenseShareInput[];
  payerUserId?: string;
  memo?: string;
  receiptUrl?: string | null;
}

export interface SerializedExpenseShare {
  id: string;
  expenseId: string;
  userId: string;
  shareAmount: string;
  status: string;
}

export interface SerializedExpense {
  id: string;
  groupId: string;
  payerUserId: string;
  title: string;
  description: string | null;
  amount: string;
  assetCode: string;
  assetIssuer: string | null;
  splitType: string;
  memo: string | null;
  receiptUrl: string | null;
  createdAt: string;
  shares: SerializedExpenseShare[];
}

const seededUserIds: string[] = [];
const seededGroupIds: string[] = [];

/** Bearer header for an authenticated request as `user`. */
export function authHeaders(user: SeededUser): { authorization: string } {
  return { authorization: `Bearer ${user.token}` };
}

/**
 * Create a user row with a real ed25519 keypair and a session token.
 *
 * The token is signed with the same helper the API uses, so requests go through
 * the production authentication path rather than a test-only bypass.
 */
export async function seedUser(label = "integration-user"): Promise<SeededUser> {
  const keypair = Keypair.random();
  const displayName = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const user = await prisma.user.create({
    data: {
      stellarPublicKey: keypair.publicKey(),
      displayName,
    },
  });
  seededUserIds.push(user.id);

  return {
    id: user.id,
    stellarPublicKey: user.stellarPublicKey,
    displayName: user.displayName,
    keypair,
    token: signToken({ id: user.id, stellarPublicKey: user.stellarPublicKey }),
  };
}

/** Create a group through the public API so its initial admin membership and audit row are real. */
export async function createGroupViaApi(
  app: FastifyInstance,
  creator: SeededUser,
  name: string
): Promise<SeededGroup> {
  const response = await app.inject({
    method: "POST",
    url: "/groups",
    headers: authHeaders(creator),
    payload: { name },
  });

  if (response.statusCode !== 200) {
    throw new Error(`createGroupViaApi failed (${response.statusCode}): ${response.body}`);
  }

  const body = response.json() as { group: SeededGroup };
  seededGroupIds.push(body.group.id);
  return body.group;
}

/** Add members directly: the API only exposes invitations, not direct insertion. */
export async function addGroupMembers(
  groupId: string,
  members: SeededUser[],
  role: "admin" | "member" = "member"
): Promise<void> {
  if (members.length === 0) return;
  await prisma.groupMember.createMany({
    data: members.map((member) => ({ groupId, userId: member.id, role })),
    skipDuplicates: true,
  });
}

/** Create a group owned by `creator`, then add `members` to it. */
export async function createGroupWithMembers(
  app: FastifyInstance,
  creator: SeededUser,
  members: SeededUser[],
  name: string
): Promise<SeededGroup> {
  const group = await createGroupViaApi(app, creator, name);
  await addGroupMembers(group.id, members);
  return group;
}

/** POST an expense through the API and return the serialized expense. */
export async function createExpenseViaApi(
  app: FastifyInstance,
  actor: SeededUser,
  groupId: string,
  payload: ExpensePayload
): Promise<SerializedExpense> {
  const response = await app.inject({
    method: "POST",
    url: `/groups/${groupId}/expenses`,
    headers: {
      ...authHeaders(actor),
      "x-idempotency-key": `integration-expense-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    },
    payload,
  });

  if (response.statusCode !== 200) {
    throw new Error(`createExpenseViaApi failed (${response.statusCode}): ${response.body}`);
  }

  return (response.json() as { expense: SerializedExpense }).expense;
}

/**
 * Remove everything this module created.
 *
 * Groups cascade to members, expenses, shares, settlements, invites, etc.
 * Audit rows survive group deletion (`onDelete: SetNull` for the group relation)
 * but still reference the user, so they are deleted before the users.
 */
export async function cleanupSeededData(): Promise<void> {
  const groupIds = seededGroupIds.splice(0);
  const userIds = seededUserIds.splice(0);

  if (groupIds.length > 0) {
    await prisma.group.deleteMany({ where: { id: { in: groupIds } } });
  }

  if (userIds.length > 0) {
    await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
}
