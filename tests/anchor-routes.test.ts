import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const prisma: any = {
    anchorSession: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    withdrawal: {
      findUnique: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
    $disconnect: vi.fn(),
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

vi.mock("../src/services/anchor", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/anchor")>();
  return {
    ...actual,
    anchorService: {
      ...actual.anchorService,
      getToml: vi.fn(),
      getChallenge: vi.fn(),
      getToken: vi.fn(),
      startInteractive: vi.fn(),
      getTransactionStatus: vi.fn(),
    },
  };
});

import { buildApp } from "../src/app";
import { signToken } from "../src/plugins/auth";
import { config } from "../src/config";

const prisma = h.prisma;

const fakeSession = (over: Record<string, any> = {}) => ({
  id: "session_1",
  userId: "user_1",
  anchorName: "Test Anchor",
  kind: "deposit",
  assetCode: "USDC",
  interactiveUrl: null,
  externalTransactionId: "ext_1",
  anchorToken: null,
  status: "incomplete",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

function authHeader() {
  const token = signToken({
    id: "user_1",
    stellarPublicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  });
  return { authorization: `Bearer ${token}` };
}

let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();
});

describe("POST /anchors/webhook — status transitions", () => {
  async function post(body: any, secret = config.ANCHOR_WEBHOOK_SECRET) {
    return app.inject({
      method: "POST",
      url: "/anchors/webhook",
      headers: { "x-webhook-secret": secret },
      payload: body,
    });
  }

  it("rejects an unauthenticated webhook without touching any session", async () => {
    const res = await post(
      { transaction: { id: "ext_1", status: "completed" } },
      "wrong-secret"
    );
    expect(res.statusCode).toBe(200); // deliberately opaque
    expect(prisma.anchorSession.findMany).not.toHaveBeenCalled();
  });

  it("applies a valid forward transition and records it", async () => {
    prisma.anchorSession.findMany.mockResolvedValue([{ id: "session_1" }]);
    prisma.anchorSession.findUnique.mockResolvedValue(
      fakeSession({ status: "pending_anchor" })
    );
    prisma.anchorSession.update.mockResolvedValue(fakeSession({ status: "completed" }));

    const res = await post({ transaction: { id: "ext_1", status: "completed" } });

    expect(res.statusCode).toBe(200);
    expect(prisma.anchorSession.update).toHaveBeenCalledWith({
      where: { id: "session_1" },
      data: { status: "completed" },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("ignores a duplicate delivery of the same status without re-auditing", async () => {
    prisma.anchorSession.findMany.mockResolvedValue([{ id: "session_1" }]);
    prisma.anchorSession.findUnique.mockResolvedValue(
      fakeSession({ status: "completed" })
    );

    const res = await post({ transaction: { id: "ext_1", status: "completed" } });

    expect(res.statusCode).toBe(200);
    expect(prisma.anchorSession.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("ignores an out-of-order regression from a terminal state", async () => {
    prisma.anchorSession.findMany.mockResolvedValue([{ id: "session_1" }]);
    prisma.anchorSession.findUnique.mockResolvedValue(
      fakeSession({ status: "completed" })
    );

    // A stale "pending_anchor" callback arrives after "completed" already
    // landed (out-of-order delivery).
    const res = await post({ transaction: { id: "ext_1", status: "pending_anchor" } });

    expect(res.statusCode).toBe(200);
    expect(prisma.anchorSession.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("does nothing when no session matches the external transaction id", async () => {
    prisma.anchorSession.findMany.mockResolvedValue([]);

    const res = await post({ transaction: { id: "unknown_ext", status: "completed" } });

    expect(res.statusCode).toBe(200);
    expect(prisma.anchorSession.update).not.toHaveBeenCalled();
  });

  it("also reconciles a Withdrawal row matched by anchorTxId", async () => {
    prisma.anchorSession.findMany.mockResolvedValue([]);
    const withdrawalRow = { id: "wth_1", userId: "user_1", status: "processing" };
    // Called once by the webhook handler (lookup by anchorTxId), then again
    // inside applyWithdrawalTransition (lookup by id).
    prisma.withdrawal.findUnique
      .mockResolvedValueOnce(withdrawalRow)
      .mockResolvedValueOnce(withdrawalRow);

    const res = await post({ transaction: { id: "ANCH-TX-1", status: "completed" } });

    expect(res.statusCode).toBe(200);
    expect(prisma.withdrawal.findUnique).toHaveBeenCalledWith({
      where: { anchorTxId: "ANCH-TX-1" },
    });
    expect(prisma.withdrawal.updateMany).toHaveBeenCalledWith({
      where: { id: "wth_1", status: "processing" },
      data: { status: "completed" },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "withdrawal.status_changed",
        entityType: "withdrawal",
        entityId: "wth_1",
        metadata: { from: "processing", to: "completed", source: "webhook" },
      }),
    });
  });

  it("does nothing when no withdrawal matches the external transaction id either", async () => {
    prisma.anchorSession.findMany.mockResolvedValue([]);
    prisma.withdrawal.findUnique.mockResolvedValueOnce(null);

    const res = await post({ transaction: { id: "unknown_ext", status: "completed" } });

    expect(res.statusCode).toBe(200);
    expect(prisma.withdrawal.updateMany).not.toHaveBeenCalled();
  });
});

describe("POST /anchors/sessions/:id/complete — transition + audit", () => {
  it("transitions incomplete -> pending_user_transfer_start and audits it", async () => {
    const { anchorService } = await import("../src/services/anchor");
    (anchorService.getToml as any).mockResolvedValue({
      webAuthEndpoint: "https://anchor.test/auth",
      transferServerSep24: "https://anchor.test/sep24",
    });
    (anchorService.getToken as any).mockResolvedValue("anchor-jwt");
    (anchorService.startInteractive as any).mockResolvedValue({
      url: "https://anchor.test/interactive/abc",
      id: "ext_new",
    });

    prisma.anchorSession.findUnique.mockResolvedValue(fakeSession({ status: "incomplete" }));
    prisma.anchorSession.update.mockResolvedValue(
      fakeSession({
        status: "pending_user_transfer_start",
        interactiveUrl: "https://anchor.test/interactive/abc",
        externalTransactionId: "ext_new",
      })
    );

    const res = await app.inject({
      method: "POST",
      url: "/anchors/sessions/session_1/complete",
      headers: authHeader(),
      payload: { signedXdr: "AAAA..." },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().session.status).toBe("pending_user_transfer_start");
    expect(prisma.anchorSession.update).toHaveBeenCalledWith({
      where: { id: "session_1" },
      data: {
        interactiveUrl: "https://anchor.test/interactive/abc",
        externalTransactionId: "ext_new",
        anchorToken: "anchor-jwt",
        status: "pending_user_transfer_start",
      },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "anchor_session.status_changed",
        metadata: {
          from: "incomplete",
          to: "pending_user_transfer_start",
          source: "user",
        },
      }),
    });
    // The anchor JWT must never appear in the audit trail.
    const auditCallArgs = prisma.auditLog.create.mock.calls[0][0];
    expect(JSON.stringify(auditCallArgs)).not.toContain("anchor-jwt");
  });

  it("rejects completing a session owned by another user", async () => {
    prisma.anchorSession.findUnique.mockResolvedValue(
      fakeSession({ userId: "someone_else" })
    );

    const res = await app.inject({
      method: "POST",
      url: "/anchors/sessions/session_1/complete",
      headers: authHeader(),
      payload: { signedXdr: "AAAA..." },
    });

    expect(res.statusCode).toBe(404);
    expect(prisma.anchorSession.update).not.toHaveBeenCalled();
  });
});
