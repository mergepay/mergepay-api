import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const anchorSession = {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(async () => ({ count: 1 })),
  };
  const prisma: any = {
    anchorSession,
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
    $disconnect: vi.fn(),
  };
  return {
    prisma,
    audit: vi.fn(),
    getToml: vi.fn(),
  };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));
vi.mock("../src/services/stellar", () => ({
  stellar: { loadAccount: vi.fn(), buildPayment: vi.fn(), submitPayment: vi.fn() },
}));
vi.mock("../src/services/audit", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/audit")>();
  return { ...actual, audit: h.audit };
});
vi.mock("../src/worker/reconciliation", () => ({
  runReconciliation: vi.fn(),
  startReconciliation: vi.fn(() => () => {}),
}));
// Partial mock: keep the real pollTransaction (exercised against global.fetch
// below), but stub getToml so reconcileAnchors can reach the polling loop
// without a real stellar.toml round-trip. Status tables and mapAnchorStatus
// stay real because the worker (and this test) depend on their contents.
vi.mock("../src/services/anchor", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/anchor")>();
  return {
    ...actual,
    anchorService: {
      ...actual.anchorService,
      getToml: h.getToml,
    },
  };
});

// We mock fetch globally to test anchorService.pollTransaction network failures
const mockFetch = vi.fn();
global.fetch = mockFetch as any;

import { mapAnchorStatus, isKnownSep24Status, anchorService } from "../src/services/anchor";
import { anchorCircuit } from "../src/services/anchor-circuit";
import { reconcileAnchors } from "../src/worker/index";
import { applyAnchorSessionTransition } from "../src/services/anchor-status";

const prisma = h.prisma;
const TEST_PROVIDER = "tx:https://anchor.test/sep24";

function fakeSession(over: Record<string, any> = {}) {
  return {
    id: "session_1",
    userId: "user_1",
    status: "pending_anchor",
    externalTransactionId: "ext_1",
    anchorToken: "jwt",
    retryCount: 0,
    failureReason: null,
    lastPolledAt: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockReset();
  h.getToml.mockResolvedValue({ transferServerSep24: "https://anchor.test/sep24" });
  // The anchor circuit breaker is shared module state; reset it so failures
  // from one test do not trip the per-provider circuit for the next.
  anchorCircuit.reset(TEST_PROVIDER);
});

describe("SEP-24 Status Mapping Consistency", () => {
  it("maps raw statuses correctly to internal states", () => {
    // Terminal success
    expect(mapAnchorStatus("completed")).toBe("completed");

    // Terminal failure maps to error
    expect(mapAnchorStatus("error")).toBe("error");
    expect(mapAnchorStatus("expired")).toBe("error");
    expect(mapAnchorStatus("no_market")).toBe("error");
    expect(mapAnchorStatus("too_small")).toBe("error");
    expect(mapAnchorStatus("too_large")).toBe("error");

    // Refunded maps to refunded
    expect(mapAnchorStatus("refunded")).toBe("refunded");

    // User transfer start maps to pending_user_transfer_start
    expect(mapAnchorStatus("pending_user_transfer_start")).toBe("pending_user_transfer_start");

    // Other intermediate states map to pending_anchor
    expect(mapAnchorStatus("pending_user")).toBe("pending_anchor");
    expect(mapAnchorStatus("pending_transaction_info_update")).toBe("pending_anchor");
    expect(mapAnchorStatus("pending_receiver")).toBe("pending_anchor");
    expect(mapAnchorStatus("pending_sender")).toBe("pending_anchor");
    expect(mapAnchorStatus("pending_stellar")).toBe("pending_anchor");
    expect(mapAnchorStatus("pending_trust")).toBe("pending_anchor");
    expect(mapAnchorStatus("pending_anchor")).toBe("pending_anchor");

    // Initial state maps to incomplete
    expect(mapAnchorStatus("incomplete")).toBe("incomplete");

    // Unknown status maps to pending_anchor
    expect(mapAnchorStatus("unknown_status")).toBe("pending_anchor");
  });

  it("recognizes every documented SEP-24 status and rejects unknowns", () => {
    const known = [
      "incomplete",
      "pending_user_transfer_start",
      "pending_stellar",
      "pending_trust",
      "pending_user",
      "pending_anchor",
      "pending_transaction_info_update",
      "pending_receiver",
      "pending_sender",
      "completed",
      "no_market",
      "too_small",
      "too_large",
      "error",
      "refunded",
      "expired",
    ];
    for (const status of known) {
      expect(isKnownSep24Status(status)).toBe(true);
      expect(isKnownSep24Status(status.toUpperCase())).toBe(true);
    }
    expect(isKnownSep24Status("bogus_status")).toBe(false);
    expect(isKnownSep24Status("")).toBe(false);
  });

  it("flags unknown statuses as unrecognized on the poll result but keeps them safe", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        transaction: { id: "ext_1", status: "brand_new_future_status" },
      }),
    });

    const result = await anchorService.pollTransaction({
      transferServer: "https://anchor.test/sep24",
      token: "jwt",
      id: "ext_1",
    });

    expect(result.isError).toBe(false);
    expect(result.recognized).toBe(false);
    expect(result.rawStatus).toBe("brand_new_future_status");
    // Unknown statuses must not be treated as failures — they fall back to the
    // safe intermediate state so the worker keeps polling.
    expect(result.status).toBe("pending_anchor");
    expect(result.errorCategory).toBeUndefined();
  });

  it("rejects a whitespace-only status as a malformed response", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        transaction: { id: "ext_1", status: "   " },
      }),
    });

    const result = await anchorService.pollTransaction({
      transferServer: "https://anchor.test/sep24",
      token: "jwt",
      id: "ext_1",
    });

    expect(result.isError).toBe(true);
    expect(result.errorCategory).toBe("permanent");
  });
});

describe("Anchor response validation & malformed response handling", () => {
  it("rejects malformed non-JSON responses as permanent errors", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.reject(new Error("Unexpected token < in JSON")),
    });

    const result = await anchorService.pollTransaction({
      transferServer: "https://anchor.test/sep24",
      token: "jwt",
      id: "ext_1",
    });

    expect(result.isError).toBe(true);
    expect(result.errorCategory).toBe("permanent");
    expect(result.message).toContain("malformed");
  });

  it("rejects invalid JSON structure (missing transaction field) as permanent error", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ not_transaction: {} }),
    });

    const result = await anchorService.pollTransaction({
      transferServer: "https://anchor.test/sep24",
      token: "jwt",
      id: "ext_1",
    });

    expect(result.isError).toBe(true);
    expect(result.errorCategory).toBe("permanent");
    expect(result.message).toContain("invalid or malformed");
  });

  it("rejects missing status inside transaction as permanent error", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ transaction: { id: "ext_1" } }), // missing status
    });

    const result = await anchorService.pollTransaction({
      transferServer: "https://anchor.test/sep24",
      token: "jwt",
      id: "ext_1",
    });

    expect(result.isError).toBe(true);
    expect(result.errorCategory).toBe("permanent");
  });

  it("accepts valid transaction response with number for amount_in", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        transaction: {
          id: "ext_1",
          status: "completed",
          amount_in: 100.50, // number
        },
      }),
    });

    const result = await anchorService.pollTransaction({
      transferServer: "https://anchor.test/sep24",
      token: "jwt",
      id: "ext_1",
    });

    expect(result.isError).toBe(false);
    expect(result.status).toBe("completed");
    expect(result.amountIn).toBe("100.5");
  });
});

describe("Transient vs Permanent HTTP and network failures", () => {
  it("treats timeout fetch errors as transient and retryable in the worker", async () => {
    mockFetch.mockRejectedValue(new TypeError("fetch failed due to timeout"));

    const session = fakeSession();
    prisma.anchorSession.findMany.mockResolvedValue([session]);
    prisma.anchorSession.findUnique.mockResolvedValue(session);

    await reconcileAnchors();

    // It should update retry Count and set category to transient without changing the status to error
    expect(prisma.anchorSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "session_1" },
        data: expect.objectContaining({
          retryCount: 1,
          errorCategory: "transient",
        }),
      })
    );
  });

  it("treats HTTP 500 Server Error as transient and retryable in the worker", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
    });

    const session = fakeSession();
    prisma.anchorSession.findMany.mockResolvedValue([session]);
    prisma.anchorSession.findUnique.mockResolvedValue(session);

    await reconcileAnchors();

    expect(prisma.anchorSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "session_1" },
        data: expect.objectContaining({
          retryCount: 1,
          errorCategory: "transient",
        }),
      })
    );
  });

  it("treats HTTP 403 Forbidden as permanent error, transitions status to error, and stops retrying", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
    });

    const session = fakeSession();
    prisma.anchorSession.findMany.mockResolvedValue([session]);
    prisma.anchorSession.findUnique.mockResolvedValue(session);
    prisma.anchorSession.update.mockResolvedValue({ ...session, status: "error" });
    prisma.anchorSession.updateMany.mockResolvedValue({ count: 1 });

    await reconcileAnchors();

    expect(prisma.anchorSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "session_1", status: "pending_anchor" },
        data: expect.objectContaining({
          status: "error",
          errorCategory: "permanent",
          nextAttemptAt: null,
          retryCount: 0,
        }),
      })
    );
  });
});

describe("Stale updates and terminal-state protection", () => {
  it("never overwrites a local completed state with any incoming status", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        transaction: {
          id: "ext_1",
          status: "pending_anchor", // stale state
        },
      }),
    });

    const session = fakeSession({ status: "completed" });
    prisma.anchorSession.findMany.mockResolvedValue([session]);

    await reconcileAnchors();

    // Since local status is completed, the worker should ignore the update
    expect(prisma.anchorSession.update).not.toHaveBeenCalled();
  });

  it("allows transitions from error to refunded but not back to pending", async () => {
    // 1. error to refunded should succeed
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        transaction: {
          id: "ext_1",
          status: "refunded",
        },
      }),
    });

    const session = fakeSession({ status: "error" });
    prisma.anchorSession.findMany.mockResolvedValue([session]);
    prisma.anchorSession.findUnique.mockResolvedValue(session);
    prisma.anchorSession.update.mockResolvedValue({ ...session, status: "refunded" });
    prisma.anchorSession.updateMany.mockResolvedValue({ count: 1 });

    await reconcileAnchors();

    expect(prisma.anchorSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "session_1", status: "error" },
        data: expect.objectContaining({
          status: "refunded",
        }),
      })
    );

    // 2. error to pending_anchor should be ignored
    vi.clearAllMocks();
    prisma.anchorSession.updateMany.mockResolvedValue({ count: 1 });
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        transaction: {
          id: "ext_1",
          status: "pending_anchor",
        },
      }),
    });

    await reconcileAnchors();
    // claim + release call updateMany, but no transition (status change) may be
    // applied from a terminal error state back to a pending state.
    const statusChangingCalls = prisma.anchorSession.updateMany.mock.calls.filter(
      ([args]: any[]) => args?.data?.status
    );
    expect(statusChangingCalls).toHaveLength(0);
  });
});

describe("Conditional stale-write guard (expectedCurrentStatus)", () => {
  it("no-ops the transition when the live status diverges from the caller's snapshot", async () => {
    // The worker read the session as pending_anchor, but a concurrent writer
    // already advanced it to completed before applyAnchorSessionTransition ran;
    // the snapshot guard refuses to walk the terminal state back.
    prisma.anchorSession.findUnique.mockResolvedValue(
      fakeSession({ status: "completed" })
    );
    prisma.anchorSession.update.mockResolvedValue(fakeSession({ status: "completed" }));
    prisma.anchorSession.updateMany.mockResolvedValue({ count: 0 }); // stale: no row matched

    const result = await applyAnchorSessionTransition({
      sessionId: "session_1",
      nextStatus: "pending_anchor",
      source: "poll",
      expectedCurrentStatus: "pending_anchor",
    });

    expect(result.changed).toBe(false);
    expect(result.session.status).toBe("completed");
    // No write is attempted at all: the guard detects the divergence from the
    // snapshot before issuing any conditional update.
    expect(prisma.anchorSession.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("refuses the write when the conditional update matches no row (count 0)", async () => {
    // The snapshot still matched at read time, but the row moved between the
    // read and the conditional update — the database itself rejects it.
    prisma.anchorSession.findUnique.mockResolvedValue(fakeSession({ status: "pending_anchor" }));
    prisma.anchorSession.update.mockResolvedValue(fakeSession({ status: "pending_anchor" }));
    prisma.anchorSession.updateMany.mockResolvedValue({ count: 0 });

    const result = await applyAnchorSessionTransition({
      sessionId: "session_1",
      nextStatus: "completed",
      source: "poll",
      expectedCurrentStatus: "pending_anchor",
    });

    expect(result.changed).toBe(false);
    expect(result.session.status).toBe("pending_anchor");
    expect(prisma.anchorSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "session_1", status: "pending_anchor" },
      })
    );
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("applies the transition only when the live status still matches the snapshot", async () => {
    prisma.anchorSession.findUnique.mockResolvedValue(fakeSession({ status: "pending_anchor" }));
    prisma.anchorSession.updateMany.mockResolvedValue({ count: 1 });

    const result = await applyAnchorSessionTransition({
      sessionId: "session_1",
      nextStatus: "completed",
      source: "poll",
      expectedCurrentStatus: "pending_anchor",
    });

    expect(result.changed).toBe(true);
    expect(prisma.anchorSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "session_1", status: "pending_anchor" },
        data: expect.objectContaining({ status: "completed" }),
      })
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: { from: "pending_anchor", to: "completed", source: "poll" },
        }),
      })
    );
  });
});
