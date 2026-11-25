import { describe, it, expect, beforeEach, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { config } from "../../src/config";
import { AuditAction } from "../../src/services/audit-actions";

const h = vi.hoisted(() => {
  const prisma: any = {
    anchorSession: { create: vi.fn() },
    auditLog: { create: vi.fn(async () => ({ id: "audit_1" })) },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
  };
  return {
    prisma,
    getToml: vi.fn(),
    getChallenge: vi.fn(),
  };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));

vi.mock("../../src/services/anchor", async (importActual) => {
  const actual =
    await importActual<typeof import("../../src/services/anchor")>();
  return {
    ...actual,
    anchorService: {
      ...actual.anchorService,
      getToml: h.getToml,
      getChallenge: h.getChallenge,
    },
  };
});

import {
  initiateSep24Deposit,
  initiateSep24Withdrawal,
  startSep24InteractiveFlow,
} from "../../src/services/sep24";

const actor = {
  id: "user_1",
  stellarPublicKey: Keypair.random().publicKey(),
};

const challenge = {
  transaction: "sep10-challenge-xdr",
  networkPassphrase: "Test SDF Network ; September 2015",
};

function lastAudit() {
  const calls = h.prisma.auditLog.create.mock.calls;
  return calls[calls.length - 1][0].data;
}

beforeEach(() => {
  vi.clearAllMocks();

  h.getToml.mockResolvedValue({
    homeDomain: config.ANCHOR_HOME_DOMAIN,
    webAuthEndpoint: "https://anchor.test/auth",
    transferServerSep24: "https://anchor.test/sep24",
    signingKey: "anchor-signing-key",
    assets: [{ code: "USDC", issuer: config.STABLE_ASSET_ISSUER }],
  });
  h.getChallenge.mockResolvedValue(challenge);

  h.prisma.anchorSession.create.mockImplementation(async ({ data }: any) => ({
    id: "session_1",
    interactiveUrl: null,
    externalTransactionId: null,
    failureReason: null,
    retryCount: 0,
    lastPolledAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...data,
  }));
  h.prisma.auditLog.create.mockResolvedValue({ id: "audit_1" });
});

describe("startSep24InteractiveFlow — deposit", () => {
  it("creates an incomplete session and returns the SEP-10 challenge", async () => {
    const result = await initiateSep24Deposit({
      body: { assetCode: "USDC" },
      actor,
      correlationId: "req_123",
    });

    expect(h.getToml).toHaveBeenCalledWith(config.ANCHOR_HOME_DOMAIN);
    expect(h.getChallenge).toHaveBeenCalledWith(
      "https://anchor.test/auth",
      actor.stellarPublicKey
    );

    expect(h.prisma.anchorSession.create).toHaveBeenCalledWith({
      data: {
        userId: actor.id,
        anchorName: config.ANCHOR_NAME,
        kind: "deposit",
        assetCode: "USDC",
        status: "incomplete",
      },
    });
    expect(result.session).toMatchObject({
      id: "session_1",
      userId: actor.id,
      kind: "deposit",
      assetCode: "USDC",
      status: "incomplete",
    });
    expect(result.challenge).toEqual(challenge);
  });

  it("writes the start audit row inside the session transaction", async () => {
    await startSep24InteractiveFlow({
      kind: "deposit",
      body: { assetCode: "USDC", amount: "12.5" },
      actor,
      correlationId: "req_456",
    });

    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(lastAudit()).toMatchObject({
      userId: actor.id,
      action: AuditAction.ANCHOR_DEPOSIT_STARTED,
      entityType: "anchor_session",
      entityId: "session_1",
      correlationId: "req_456",
      metadata: expect.objectContaining({
        kind: "deposit",
        assetCode: "USDC",
        amount: "12.5",
      }),
    });
  });

  it("omits the amount from audit metadata when the deposit does not name one", async () => {
    await initiateSep24Deposit({ body: { assetCode: "USDC" }, actor });

    expect(lastAudit().metadata).not.toHaveProperty("amount");
  });

  it("honours an explicit anchor name and normalises the asset code", async () => {
    await initiateSep24Deposit({
      body: { assetCode: "usdc", anchorName: "Other Anchor" },
      actor,
    });

    expect(h.prisma.anchorSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        anchorName: "Other Anchor",
        assetCode: "USDC",
      }),
    });
  });
});

describe("startSep24InteractiveFlow — withdrawal", () => {
  it("records the amount and the withdrawal audit action", async () => {
    const result = await initiateSep24Withdrawal({
      body: { assetCode: "USDC", amount: "5.00" },
      actor,
      correlationId: "req_789",
    });

    expect(h.prisma.anchorSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "withdrawal",
        assetCode: "USDC",
        status: "incomplete",
      }),
    });
    expect(result.session.kind).toBe("withdrawal");

    const audit = lastAudit();
    expect(audit.action).toBe(AuditAction.ANCHOR_WITHDRAWAL_STARTED);
    expect(audit.metadata).toMatchObject({
      amount: "5.00",
      kind: "withdrawal",
    });
  });

  it("rejects a withdrawal without an amount before any anchor or database call", async () => {
    await expect(
      initiateSep24Withdrawal({ body: { assetCode: "USDC" }, actor })
    ).rejects.toThrow();

    expect(h.getToml).not.toHaveBeenCalled();
    expect(h.getChallenge).not.toHaveBeenCalled();
    expect(h.prisma.anchorSession.create).not.toHaveBeenCalled();
  });
});

describe("startSep24InteractiveFlow — validation ordering", () => {
  it("rejects an unknown request field before contacting the anchor", async () => {
    await expect(
      initiateSep24Deposit({
        body: { assetCode: "USDC", unexpected: true },
        actor,
      })
    ).rejects.toThrow();

    expect(h.getToml).not.toHaveBeenCalled();
    expect(h.prisma.anchorSession.create).not.toHaveBeenCalled();
  });

  it("rejects an unsupported asset before contacting the anchor", async () => {
    await expect(
      initiateSep24Deposit({ body: { assetCode: "DOGE" }, actor })
    ).rejects.toMatchObject({ code: "INVALID_ASSET" });

    expect(h.getToml).not.toHaveBeenCalled();
    expect(h.getChallenge).not.toHaveBeenCalled();
    expect(h.prisma.anchorSession.create).not.toHaveBeenCalled();
  });

  it("rejects an issuer on a native asset before contacting the anchor", async () => {
    await expect(
      initiateSep24Deposit({
        body: {
          assetCode: "XLM",
          assetIssuer: Keypair.random().publicKey(),
        },
        actor,
      })
    ).rejects.toThrow();

    expect(h.getToml).not.toHaveBeenCalled();
  });
});

describe("startSep24InteractiveFlow — anchor failures", () => {
  it("propagates a stellar.toml failure without creating a session", async () => {
    h.getToml.mockRejectedValue(new Error("toml unavailable"));

    await expect(
      initiateSep24Deposit({ body: { assetCode: "USDC" }, actor })
    ).rejects.toThrow("toml unavailable");

    expect(h.getChallenge).not.toHaveBeenCalled();
    expect(h.prisma.anchorSession.create).not.toHaveBeenCalled();
  });

  it("propagates a challenge failure without creating a session", async () => {
    h.getChallenge.mockRejectedValue(new Error("challenge rejected"));

    await expect(
      initiateSep24Withdrawal({
        body: { assetCode: "USDC", amount: "1" },
        actor,
      })
    ).rejects.toThrow("challenge rejected");

    expect(h.prisma.anchorSession.create).not.toHaveBeenCalled();
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("fails the whole start when the audit row cannot be written", async () => {
    h.prisma.auditLog.create.mockRejectedValue(new Error("audit store down"));

    await expect(
      initiateSep24Deposit({ body: { assetCode: "USDC" }, actor })
    ).rejects.toThrow("audit store down");

    // Both writes happen in the same transaction, so a failed audit write
    // rejects the start rather than committing a session without its record.
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("rejects with the caller's original error when session creation fails", async () => {
    h.prisma.anchorSession.create.mockRejectedValue(new Error("insert failed"));

    await expect(
      initiateSep24Deposit({ body: { assetCode: "USDC" }, actor })
    ).rejects.toThrow("insert failed");

    expect(h.prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
