import { describe, it, expect, beforeEach, vi } from "vitest";
import { signToken } from "../src/plugins/auth";
import {
  SETTLEMENT_STATUSES,
  isTerminalSettlementStatus,
  toPublicStatus,
} from "../src/services/settlement-status";
import { CLOCK_SKEW_TOLERANCE_SECONDS } from "../src/lib/time-bounds";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(async () => []),
  });
  const prisma: any = {
    settlement: model(),
    groupMember: model(),
    group: model(),
    user: model(),
    auditLog: model(),
  };
  prisma.$transaction = vi.fn(async (arg: any) =>
    typeof arg === "function" ? arg(prisma) : Promise.all(arg)
  );
  return { prisma, getTransaction: vi.fn() };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));
vi.mock("../src/services/stellar", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/stellar")>();
  return {
    ...actual,
    stellar: { ...actual.stellar, getTransaction: h.getTransaction },
  };
});

import { buildApp } from "../src/app";

let app: Awaited<ReturnType<typeof buildApp>>;
const prisma = h.prisma;

const MEMBER = "user_1";
const OUTSIDER = "user_outsider";
const KEY_A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const KEY_B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function authHeader(userId = MEMBER) {
  return {
    authorization: `Bearer ${signToken({ id: userId, stellarPublicKey: KEY_A })}`,
  };
}

function fakeUser(id: string, key: string) {
  return {
    id,
    stellarPublicKey: key,
    displayName: "Tester",
    avatarUrl: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function fakeSettlement(over: Record<string, unknown> = {}) {
  return {
    id: "settle_1",
    shortCode: "ABC123",
    groupId: "group_1",
    fromUserId: MEMBER,
    toUserId: "user_2",
    amount: "10",
    assetCode: "XLM",
    assetIssuer: null,
    stellarTxHash: null,
    // Present in the row, and must never appear in a status response.
    transactionXdr: "AAAAAgAAAAsupersecretsignedenvelope",
    status: "pending",
    retryCount: 0,
    failureReason: null,
    memo: "MP:ABC123",
    expenseId: null,
    expenseShareId: null,
    expiresAt: new Date(Date.now() + 300_000),
    createdAt: new Date("2026-07-30T12:00:00Z"),
    updatedAt: new Date("2026-07-30T12:00:00Z"),
    from: fakeUser(MEMBER, KEY_A),
    to: fakeUser("user_2", KEY_B),
    ...over,
  };
}

function statusInput(over: Record<string, unknown> = {}) {
  const row = fakeSettlement(over);
  return {
    status: row.status,
    stellarTxHash: row.stellarTxHash,
    failureReason: row.failureReason,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();
  prisma.groupMember.findUnique.mockResolvedValue({
    groupId: "group_1",
    userId: MEMBER,
    role: "member",
  });
  h.getTransaction.mockResolvedValue(null);
});

// ── The status vocabulary ───────────────────────────────────────────────────

describe("public status mapping", () => {
  it("documents a small, stable set of values", () => {
    expect([...SETTLEMENT_STATUSES]).toEqual([
      "awaiting_signature",
      "submitted",
      "confirmed",
      "failed",
      "expired",
    ]);
  });

  it("marks exactly the settled outcomes terminal", () => {
    expect(isTerminalSettlementStatus("confirmed")).toBe(true);
    expect(isTerminalSettlementStatus("failed")).toBe(true);
    expect(isTerminalSettlementStatus("expired")).toBe(true);
    expect(isTerminalSettlementStatus("awaiting_signature")).toBe(false);
    expect(isTerminalSettlementStatus("submitted")).toBe(false);
  });

  it("maps each persisted status to its public counterpart", () => {
    expect(toPublicStatus(statusInput({ status: "pending" }))).toBe("awaiting_signature");
    expect(toPublicStatus(statusInput({ status: "submitted" }))).toBe("submitted");
    expect(toPublicStatus(statusInput({ status: "confirmed" }))).toBe("confirmed");
    expect(toPublicStatus(statusInput({ status: "failed" }))).toBe("failed");
    expect(toPublicStatus(statusInput({ status: "expired" }))).toBe("expired");
  });

  it("reports an unknown internal status conservatively, never as paid", () => {
    const status = toPublicStatus(statusInput({ status: "some_future_state" }));
    expect(status).toBe("awaiting_signature");
    expect(isTerminalSettlementStatus(status)).toBe(false);
  });

  it("reports a lapsed signing window as expired", () => {
    const lapsed = new Date(
      Date.now() - (CLOCK_SKEW_TOLERANCE_SECONDS + 600) * 1000
    );
    expect(toPublicStatus(statusInput({ status: "pending", expiresAt: lapsed }))).toBe(
      "expired"
    );
    expect(toPublicStatus(statusInput({ status: "submitted", expiresAt: lapsed }))).toBe(
      "expired"
    );
  });

  it("never downgrades a confirmed settlement whose window has since passed", () => {
    const lapsed = new Date(Date.now() - 86_400_000);
    expect(toPublicStatus(statusInput({ status: "confirmed", expiresAt: lapsed }))).toBe(
      "confirmed"
    );
  });

  it("treats a row with no recorded deadline as still awaiting a signature", () => {
    expect(toPublicStatus(statusInput({ status: "pending", expiresAt: null }))).toBe(
      "awaiting_signature"
    );
  });
});

// ── Access control ──────────────────────────────────────────────────────────

describe("GET /settlements/:id/status — access", () => {
  it("lets an authenticated member read a settlement by id", async () => {
    prisma.settlement.findFirst.mockResolvedValue(fakeSettlement());

    const res = await app.inject({
      method: "GET",
      url: "/settlements/settle_1/status",
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().settlement.id).toBe("settle_1");
    expect(res.json().status).toBe("awaiting_signature");
  });

  it("also resolves the human-facing short code", async () => {
    prisma.settlement.findFirst.mockResolvedValue(fakeSettlement());

    const res = await app.inject({
      method: "GET",
      url: "/settlements/ABC123/status",
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.settlement.findFirst.mock.calls[0][0].where.OR).toEqual([
      { id: "ABC123" },
      { shortCode: "ABC123" },
    ]);
  });

  it("lets a member who is neither party read it, matching group scope", async () => {
    prisma.settlement.findFirst.mockResolvedValue(
      fakeSettlement({ fromUserId: "user_2", toUserId: "user_3" })
    );

    const res = await app.inject({
      method: "GET",
      url: "/settlements/settle_1/status",
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
  });

  it("refuses a non-member and tells them nothing about the settlement", async () => {
    prisma.settlement.findFirst.mockResolvedValue(fakeSettlement());
    prisma.groupMember.findUnique.mockResolvedValue(null);
    prisma.group.findUnique.mockResolvedValue({ id: "group_1" });

    const res = await app.inject({
      method: "GET",
      url: "/settlements/settle_1/status",
      headers: authHeader(OUTSIDER),
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error).toBe("FORBIDDEN");
    // No amount, party, group, asset, or hash in the refusal. The requestId is
    // a random correlation id that legitimately appears on every error response
    // (and is not settlement data), so exclude it — otherwise a short token like
    // "10" spuriously matches a hex digit run in the id and flakes CI.
    const { requestId: _requestId, ...rest } = body;
    const serialized = JSON.stringify(rest);
    for (const leak of ["10", KEY_B, "group_1", "XLM", "ABC123"]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("uses the shared membership helper rather than a second authorization path", async () => {
    prisma.settlement.findFirst.mockResolvedValue(fakeSettlement());

    await app.inject({
      method: "GET",
      url: "/settlements/settle_1/status",
      headers: authHeader(),
    });

    expect(prisma.groupMember.findUnique).toHaveBeenCalledWith({
      where: { groupId_userId: { groupId: "group_1", userId: MEMBER } },
    });
  });

  it("distinguishes a missing settlement from one the caller may not inspect", async () => {
    prisma.settlement.findFirst.mockResolvedValue(null);

    const res = await app.inject({
      method: "GET",
      url: "/settlements/settle_missing/status",
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error).toBe("NOT_FOUND");
    expect(body.message).toBe("Settlement not found");
    expect(body.requestId).toBeTruthy();
  });

  it("requires authentication", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/settlements/settle_1/status",
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("UNAUTHORIZED");
    expect(prisma.settlement.findFirst).not.toHaveBeenCalled();
  });

  it("rejects a malformed identifier before touching the database", async () => {
    for (const id of ["a", "with%20space", "..%2Fetc", "x".repeat(65)] as const) {
      const res = await app.inject({
        method: "GET",
        url: `/settlements/${id}/status`,
        headers: authHeader(),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("VALIDATION_ERROR");
    }
    expect(prisma.settlement.findFirst).not.toHaveBeenCalled();
  });

  it("validates the query string", async () => {
    prisma.settlement.findFirst.mockResolvedValue(fakeSettlement());

    const res = await app.inject({
      method: "GET",
      url: "/settlements/settle_1/status?refresh=maybe",
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("VALIDATION_ERROR");
  });
});

// ── Each public state ───────────────────────────────────────────────────────

describe("GET /settlements/:id/status — each public state", () => {
  async function statusFor(over: Record<string, unknown>) {
    prisma.settlement.findFirst.mockResolvedValue(fakeSettlement(over));
    const res = await app.inject({
      method: "GET",
      url: "/settlements/settle_1/status",
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  it("awaiting_signature: unsigned XDR issued, nothing signed yet", async () => {
    const body = await statusFor({ status: "pending", stellarTxHash: null });

    expect(body.status).toBe("awaiting_signature");
    expect(body.terminal).toBe(false);
    expect(body.onChain).toEqual({
      checked: false,
      found: false,
      successful: null,
      transactionHash: null,
    });
    expect(body.failure).toBeNull();
    // No Horizon call is possible without a hash.
    expect(h.getTransaction).not.toHaveBeenCalled();
  });

  it("submitted: signed and in flight, not yet visible on-chain", async () => {
    h.getTransaction.mockResolvedValue(null);
    const body = await statusFor({ status: "submitted", stellarTxHash: "hash_pending" });

    expect(body.status).toBe("submitted");
    expect(body.terminal).toBe(false);
    // A hash Horizon does not know yet is the normal state for a few seconds —
    // never reported as a confirmed payment.
    expect(body.onChain).toEqual({
      checked: true,
      found: false,
      successful: null,
      transactionHash: "hash_pending",
    });
  });

  it("confirmed: Horizon reports the transaction succeeded", async () => {
    h.getTransaction.mockResolvedValue({ successful: true });
    const body = await statusFor({ status: "submitted", stellarTxHash: "hash_ok" });

    expect(body.status).toBe("confirmed");
    expect(body.terminal).toBe(true);
    expect(body.onChain).toEqual({
      checked: true,
      found: true,
      successful: true,
      transactionHash: "hash_ok",
    });
  });

  it("failed: Horizon reports the transaction did not succeed", async () => {
    h.getTransaction.mockResolvedValue({ successful: false });
    const body = await statusFor({ status: "submitted", stellarTxHash: "hash_bad" });

    expect(body.status).toBe("failed");
    expect(body.terminal).toBe(true);
    expect(body.onChain.successful).toBe(false);
  });

  it("failed: a persisted failure surfaces its scrubbed reason and category", async () => {
    const body = await statusFor({
      status: "failed",
      stellarTxHash: null,
      failureReason: "Stellar rejected the transaction: tx_insufficient_balance",
      failureCategory: "ledger_rejected",
    });

    expect(body.status).toBe("failed");
    expect(body.terminal).toBe(true);
    expect(body.failure).toEqual({
      category: "ledger_rejected",
      reason: "Stellar rejected the transaction: tx_insufficient_balance",
    });
  });

  it("failed: a row predating the category column still answers usefully", async () => {
    const body = await statusFor({
      status: "failed",
      stellarTxHash: null,
      failureReason: "Stellar rejected the transaction: tx_insufficient_balance",
      failureCategory: null,
    });

    expect(body.failure).toEqual({
      category: "internal",
      reason: "Stellar rejected the transaction: tx_insufficient_balance",
    });
  });

  it("withholds a retry reason from a settlement that has not failed", async () => {
    // The worker records each attempt's reason before deciding to retry.
    // Reporting it on an in-flight settlement would call a live payment broken.
    h.getTransaction.mockResolvedValue(null);
    const body = await statusFor({
      status: "submitted",
      stellarTxHash: "hash_pending",
      failureReason: "attempt 1 timed out",
      failureCategory: "upstream",
    });

    expect(body.status).toBe("submitted");
    expect(body.failure).toBeNull();
  });

  it("expired: the signing window closed before submission", async () => {
    const body = await statusFor({
      status: "pending",
      expiresAt: new Date(Date.now() - (CLOCK_SKEW_TOLERANCE_SECONDS + 600) * 1000),
    });

    expect(body.status).toBe("expired");
    expect(body.terminal).toBe(true);
    expect(body.expiresInSeconds).toBeLessThan(0);
  });

  it("includes timestamps, the deadline, and the transaction id when available", async () => {
    const body = await statusFor({ status: "confirmed", stellarTxHash: "hash_ok" });

    expect(body.createdAt).toBe("2026-07-30T12:00:00.000Z");
    expect(body.updatedAt).toBe("2026-07-30T12:00:00.000Z");
    expect(body.checkedAt).toBeTruthy();
    expect(body.expiresAt).toBeTruthy();
    expect(typeof body.expiresInSeconds).toBe("number");
    expect(body.onChain.transactionHash).toBe("hash_ok");
    expect(body.settlement.stellarTxHash).toBe("hash_ok");
  });

  it("answers a terminal settlement from the database, without a Horizon call", async () => {
    await statusFor({ status: "confirmed", stellarTxHash: "hash_ok_terminal" });
    expect(h.getTransaction).not.toHaveBeenCalled();
  });

  it("degrades rather than failing when Horizon errors", async () => {
    h.getTransaction.mockRejectedValue(new Error("horizon 503 upstream detail"));
    const body = await statusFor({ status: "submitted", stellarTxHash: "hash_x" });

    // The persisted state still answers the request.
    expect(body.status).toBe("submitted");
    expect(body.onChain.checked).toBe(false);
    expect(body.onChain.found).toBe(false);
    // No upstream error text reaches the client.
    expect(JSON.stringify(body)).not.toContain("503");
    expect(JSON.stringify(body)).not.toContain("upstream detail");
  });

  it("does not block indefinitely on a hanging provider", async () => {
    h.getTransaction.mockImplementation(() => new Promise(() => {}));
    const body = await statusFor({ status: "submitted", stellarTxHash: "hash_slow" });

    expect(body.status).toBe("submitted");
    expect(body.onChain.found).toBe(false);
  }, 10_000);

  it("skips the provider lookup when the client asks for persisted state only", async () => {
    prisma.settlement.findFirst.mockResolvedValue(
      fakeSettlement({ status: "submitted", stellarTxHash: "hash_y" })
    );

    const res = await app.inject({
      method: "GET",
      url: "/settlements/settle_1/status?refresh=false",
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("submitted");
    expect(res.json().onChain.checked).toBe(false);
    expect(h.getTransaction).not.toHaveBeenCalled();
  });
});

// ── What must never be returned ─────────────────────────────────────────────

describe("GET /settlements/:id/status — never leaks sensitive material", () => {
  it("omits the signed XDR and any key or credential", async () => {
    prisma.settlement.findFirst.mockResolvedValue(
      fakeSettlement({ status: "submitted", stellarTxHash: "hash_ok" })
    );
    h.getTransaction.mockResolvedValue({ successful: true });

    const res = await app.inject({
      method: "GET",
      url: "/settlements/settle_1/status",
      headers: authHeader(),
    });

    const body = res.json();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("supersecretsignedenvelope");
    expect(body.settlement.transactionXdr).toBeUndefined();
    expect(body).not.toHaveProperty("transactionXdr");
    expect(body).not.toHaveProperty("signedXdr");
    for (const forbidden of ["privateKey", "secret", "anchorToken", "stack"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
