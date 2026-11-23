import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const model = () => ({
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  });
  const prisma: any = {
    settlement: model(),
    groupMember: model(),
    idempotencyKey: model(),
    statusHistory: model(),
    auditLog: { create: vi.fn() },
    group: model(),
    $transaction: vi.fn(async (arg: any) => typeof arg === "function" ? arg(prisma) : Promise.all(arg)),
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));
vi.mock("../src/services/stellar", () => ({
  stellar: { getTransaction: vi.fn() },
  memoText: vi.fn(),
  validateSignedXdr: vi.fn(() => ({ tx: {}, hash: "h" })),
}));

import { buildApp } from "../src/app";
import { signToken } from "../src/plugins/auth";
import { hashRequest } from "../src/services/idempotency";

const prisma = h.prisma;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();
  prisma.settlement.findUnique.mockResolvedValue({ id: "s1", groupId: "g1", fromUserId: "u1" });
  prisma.groupMember.findUnique.mockResolvedValue({ groupId: "g1", userId: "u1", role: "member" });
});

it("audits idempotent replay on settlement confirm", async () => {
  prisma.idempotencyKey.findUnique.mockResolvedValue({
    userId: "u1",
    scope: "settlement.confirm",
    key: "k1",
    requestHash: hashRequest("settlement.confirm", "s1", { signedXdr: "AAAA" }),
    responseJson: JSON.stringify({ settlement: { id: "s1", status: "submitted", groupId: "g1" } }),
  });
  const token = signToken({ id: "u1", stellarPublicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
  const res = await app.inject({
    method: "POST",
    url: "/settlements/s1/confirm",
    headers: { authorization: `Bearer ${token}`, "idempotency-key": "k1" },
    payload: { signedXdr: "AAAA" },
  });
  expect(res.statusCode).toBe(200);
  expect(prisma.auditLog.create).toHaveBeenCalled();
  const call = prisma.auditLog.create.mock.calls[0][0];
  expect(call.data.action).toBe("settlement.idempotent_replay");
});
