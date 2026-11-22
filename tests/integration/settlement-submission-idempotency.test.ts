import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { Prisma } from "@prisma/client";
import { prisma } from "../../src/db";
import { runIdempotent } from "../../src/services/idempotency";

const createdUserIds: string[] = [];
const createdGroupIds: string[] = [];

afterEach(async () => {
  if (createdGroupIds.length) {
    await prisma.group.deleteMany({ where: { id: { in: createdGroupIds.splice(0) } } });
  }
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds.splice(0) } } });
  }
});

async function seedSettlement() {
  const from = await prisma.user.create({
    data: {
      stellarPublicKey: Keypair.random().publicKey(),
      displayName: `idem-from-${randomUUID()}`,
    },
  });
  const to = await prisma.user.create({
    data: {
      stellarPublicKey: Keypair.random().publicKey(),
      displayName: `idem-to-${randomUUID()}`,
    },
  });
  createdUserIds.push(from.id, to.id);

  const group = await prisma.group.create({
    data: { name: `idem-group-${randomUUID()}`, createdByUserId: from.id },
  });
  createdGroupIds.push(group.id);

  const settlement = await prisma.settlement.create({
    data: {
      shortCode: randomUUID().slice(0, 12),
      groupId: group.id,
      fromUserId: from.id,
      toUserId: to.id,
      amount: "10.0000000",
      assetCode: "XLM",
    },
  });

  return { userId: from.id, settlementId: settlement.id };
}

describe("settlement submission idempotency (real Postgres)", () => {
  it("replays the first response without mutating state twice", async () => {
    const { userId, settlementId } = await seedSettlement();
    const key = `confirm-${randomUUID()}`;
    const payload = { signedXdr: "AAAA-integration-xdr" };
    let executions = 0;

    const operation = async (tx: Prisma.TransactionClient) => {
      executions += 1;
      const updated = await tx.settlement.update({
        where: { id: settlementId },
        data: { status: "submitted", transactionXdr: payload.signedXdr },
      });
      return { settlement: { id: updated.id, status: updated.status } };
    };

    const first = await runIdempotent({
      userId,
      scope: "settlement.confirm",
      key,
      resourceId: settlementId,
      payload,
      operation,
    });
    const second = await runIdempotent({
      userId,
      scope: "settlement.confirm",
      key,
      resourceId: settlementId,
      payload,
      operation,
    });

    expect(second).toEqual(first);
    expect(executions).toBe(1);

    const row = await prisma.settlement.findUnique({ where: { id: settlementId } });
    expect(row?.status).toBe("submitted");

    const keys = await prisma.idempotencyKey.findMany({
      where: { userId, scope: "settlement.confirm", key },
    });
    expect(keys).toHaveLength(1);
    expect(keys[0]?.status).toBe("completed");
    expect(keys[0]?.responseJson).toBe(JSON.stringify(first));
  });

  it("conflicts when the key is reused with a different body", async () => {
    const { userId, settlementId } = await seedSettlement();
    const key = `confirm-${randomUUID()}`;

    await runIdempotent({
      userId,
      scope: "settlement.confirm",
      key,
      resourceId: settlementId,
      payload: { signedXdr: "FIRST" },
      operation: async () => ({ ok: true }),
    });

    await expect(
      runIdempotent({
        userId,
        scope: "settlement.confirm",
        key,
        resourceId: settlementId,
        payload: { signedXdr: "SECOND" },
        operation: async () => ({ ok: false }),
      })
    ).rejects.toThrow(/different request/i);
  });

  it("rolls back the settlement mutation when the operation fails", async () => {
    const { userId, settlementId } = await seedSettlement();
    const key = `confirm-${randomUUID()}`;

    await expect(
      runIdempotent({
        userId,
        scope: "settlement.confirm",
        key,
        resourceId: settlementId,
        payload: { signedXdr: "AAAA-failing" },
        operation: async (tx) => {
          await tx.settlement.update({
            where: { id: settlementId },
            data: { status: "submitted", transactionXdr: "AAAA-failing" },
          });
          throw new Error("simulated failure after update");
        },
      })
    ).rejects.toThrow("simulated failure after update");

    const row = await prisma.settlement.findUnique({ where: { id: settlementId } });
    expect(row?.status).toBe("pending");

    const keyRow = await prisma.idempotencyKey.findUnique({
      where: { userId_scope_key: { userId, scope: "settlement.confirm", key } },
    });
    expect(keyRow?.status).toBe("failed");
  });
});
