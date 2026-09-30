/**
 * State-transition persistence for SEP-24 anchor sessions (issue #524).
 *
 * Runs `applyAnchorSessionTransition` — and, for the lifecycles, the worker's
 * real poll path — against a small stateful Prisma fake rather than
 * per-call stubs, so the assertions are about what ends up stored:
 *
 *  - `updateMany` honours its `status` condition against the stored row, and
 *    each read/write yields to the event loop first, so two concurrent
 *    transitions genuinely interleave (both read before either writes).
 *  - `$transaction` rolls every write back when its callback throws.
 *
 * No database or network is touched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Row = Record<string, any>;

const h = vi.hoisted(() => {
  const state = {
    sessions: new Map<string, Row>(),
    history: [] as Row[],
    audits: [] as Row[],
  };
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

  const client = {
    anchorSession: {
      findUnique: vi.fn(async ({ where }: any) => {
        await tick();
        const row = state.sessions.get(where.id);
        return row ? { ...row } : null;
      }),
      findMany: vi.fn(async ({ where }: any) => {
        await tick();
        return [...state.sessions.values()]
          .filter((row) => row.externalTransactionId !== null)
          .filter((row) => row.errorCategory !== "permanent")
          .filter((row) => where?.status?.in === undefined || where.status.in.includes(row.status))
          .map((row) => ({ ...row }));
      }),
      update: vi.fn(async ({ where, data }: any) => {
        await tick();
        const next = { ...state.sessions.get(where.id), ...data };
        state.sessions.set(where.id, next);
        return { ...next };
      }),
      // The check-and-set runs synchronously after the yield, like a row
      // lock: the WHERE clause is evaluated against the latest stored row.
      updateMany: vi.fn(async ({ where, data }: any) => {
        await tick();
        const row = state.sessions.get(where.id);
        if (!row || (typeof where.status === "string" && row.status !== where.status)) {
          return { count: 0 };
        }
        state.sessions.set(where.id, { ...row, ...data });
        return { count: 1 };
      }),
    },
    statusHistory: {
      create: vi.fn(async ({ data }: any) => {
        await tick();
        const row = { ...data, createdAt: new Date() };
        state.history.push(row);
        return row;
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        state.audits.push(data);
        return data;
      }),
    },
  };

  const prisma: any = {
    ...client,
    $transaction: vi.fn(async (fn: (tx: typeof client) => Promise<unknown>) => {
      const snapshot = {
        sessions: new Map([...state.sessions].map(([id, row]) => [id, { ...row }])),
        history: [...state.history],
        audits: [...state.audits],
      };
      try {
        return await fn(client);
      } catch (err) {
        state.sessions = snapshot.sessions;
        state.history = snapshot.history;
        state.audits = snapshot.audits;
        throw err;
      }
    }),
    $disconnect: vi.fn(),
  };

  return { state, prisma, getToml: vi.fn() };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));
vi.mock("../src/services/stellar", () => ({
  stellar: { loadAccount: vi.fn(), buildPayment: vi.fn(), submitPayment: vi.fn() },
}));
vi.mock("../src/worker/reconciliation", () => ({
  runReconciliation: vi.fn(),
  startReconciliation: vi.fn(() => () => {}),
}));
vi.mock("../src/services/anchor", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/anchor")>();
  return { ...actual, anchorService: { ...actual.anchorService, getToml: h.getToml } };
});

import { applyAnchorSessionTransition } from "../src/services/anchor-status";
import { anchorCircuit } from "../src/services/anchor-circuit";
import { reconcileAnchors } from "../src/worker/index";

const TRANSFER_SERVER = "https://anchor.test/sep24";
const fetchMock = vi.fn();

function seed(over: Row = {}): Row {
  const row = {
    id: "session_1",
    userId: "user_1",
    anchorName: "Test Anchor",
    kind: "deposit",
    assetCode: "USDC",
    interactiveUrl: null,
    externalTransactionId: "anchor_tx_1",
    anchorToken: "anchor-jwt",
    status: "pending_anchor",
    failureReason: null,
    errorCategory: null,
    retryCount: 0,
    lastPolledAt: null,
    nextAttemptAt: null,
    leaseExpiresAt: null,
    ...over,
  };
  h.state.sessions.set(row.id, row);
  return row;
}

const stored = (id = "session_1") => h.state.sessions.get(id)!;
const historyOf = (id = "session_1") =>
  h.state.history.filter((row) => row.entityId === id).map((row) => row.status);
const transitionAudits = () =>
  h.state.audits.filter((row) => row.action === "anchor_session.status_changed");

function anchorAnswers(...statuses: string[]) {
  for (const status of statuses) {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          transaction: {
            id: "anchor_tx_1",
            kind: stored().kind,
            status,
            amount_in: "100.25",
            amount_out: "99.75",
            amount_fee: "0.5",
          },
        }),
        { status: 200 }
      )
    );
  }
}

beforeEach(() => {
  h.state.sessions = new Map();
  h.state.history = [];
  h.state.audits = [];
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  h.getToml.mockResolvedValue({ transferServerSep24: TRANSFER_SERVER });
  anchorCircuit.reset(`tx:${TRANSFER_SERVER}`);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── 8. A change updates the row and records exactly one transition ────────

describe("applyAnchorSessionTransition — recording", () => {
  it("updates the session and writes one history row and one audit row", async () => {
    seed({ status: "pending_anchor" });

    const result = await applyAnchorSessionTransition({
      sessionId: "session_1",
      nextStatus: "pending_stellar",
      source: "poll",
      rawStatus: "pending_stellar",
    });

    expect(result.changed).toBe(true);
    expect(result.session.status).toBe("pending_stellar");
    expect(stored().status).toBe("pending_stellar");
    expect(h.state.history).toEqual([
      expect.objectContaining({
        entityType: "anchor_session",
        entityId: "session_1",
        status: "pending_stellar",
        source: "poll",
      }),
    ]);
    expect(transitionAudits()).toHaveLength(1);
    expect(transitionAudits()[0].metadata).toMatchObject({
      from: "pending_anchor",
      to: "pending_stellar",
      source: "poll",
      rawStatus: "pending_stellar",
    });
  });

  it("stores a safe reason on the history row", async () => {
    seed({ status: "pending_anchor" });

    await applyAnchorSessionTransition({
      sessionId: "session_1",
      nextStatus: "error",
      source: "poll",
      reason: "Bank rejected the transfer",
    });

    expect(h.state.history[0]).toMatchObject({ status: "error", reason: "Bank rejected the transfer" });
  });

  it("rolls the status change back when the history write fails", async () => {
    seed({ status: "pending_anchor" });
    h.prisma.statusHistory.create.mockRejectedValueOnce(new Error("disk full"));

    await expect(
      applyAnchorSessionTransition({ sessionId: "session_1", nextStatus: "completed", source: "poll" })
    ).rejects.toThrow("disk full");

    expect(stored().status).toBe("pending_anchor");
    expect(h.state.history).toHaveLength(0);
    expect(transitionAudits()).toHaveLength(0);
  });

  it("ignores a status outside the SEP-24 set instead of guessing a state", async () => {
    seed({ status: "pending_stellar" });

    const result = await applyAnchorSessionTransition({
      sessionId: "session_1",
      nextStatus: "pending_quantum_review",
      source: "webhook",
    });

    expect(result.changed).toBe(false);
    expect(stored().status).toBe("pending_stellar");
    expect(h.state.history).toHaveLength(0);
  });
});

// ─── 9. Idempotency ──────────────────────────────────────────────────────────

describe("applyAnchorSessionTransition — idempotency", () => {
  it("records nothing when the same status is applied again", async () => {
    seed({ status: "pending_anchor" });

    const first = await applyAnchorSessionTransition({
      sessionId: "session_1",
      nextStatus: "completed",
      source: "poll",
    });
    const second = await applyAnchorSessionTransition({
      sessionId: "session_1",
      nextStatus: "completed",
      source: "webhook",
    });

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(historyOf()).toEqual(["completed"]);
    expect(transitionAudits()).toHaveLength(1);
  });
});

// ─── 10. Terminal states ─────────────────────────────────────────────────────

describe("applyAnchorSessionTransition — terminal states", () => {
  it.each(["completed", "refunded", "expired", "no_market", "too_small", "too_large"])(
    "never moves a %s session back to a pending state",
    async (terminal) => {
      seed({ status: terminal });

      for (const late of ["pending_anchor", "pending_stellar", "incomplete", "pending_user_transfer_start"]) {
        const result = await applyAnchorSessionTransition({
          sessionId: "session_1",
          nextStatus: late,
          source: "poll",
        });
        expect(result.changed).toBe(false);
      }

      expect(stored().status).toBe(terminal);
      expect(h.state.history).toHaveLength(0);
    }
  );

  it("lets error resolve to refunded, and nothing after that", async () => {
    seed({ status: "error" });

    expect(
      (await applyAnchorSessionTransition({ sessionId: "session_1", nextStatus: "pending_anchor", source: "poll" })).changed
    ).toBe(false);
    expect(
      (await applyAnchorSessionTransition({ sessionId: "session_1", nextStatus: "refunded", source: "poll" })).changed
    ).toBe(true);
    expect(
      (await applyAnchorSessionTransition({ sessionId: "session_1", nextStatus: "completed", source: "poll" })).changed
    ).toBe(false);

    expect(stored().status).toBe("refunded");
    expect(historyOf()).toEqual(["refunded"]);
  });

  it("refuses a stale writer whose snapshot no longer matches", async () => {
    seed({ status: "completed" });

    const result = await applyAnchorSessionTransition({
      sessionId: "session_1",
      nextStatus: "error",
      source: "poll",
      expectedCurrentStatus: "pending_anchor",
    });

    expect(result.changed).toBe(false);
    expect(stored().status).toBe("completed");
  });
});

// ─── 11. Concurrency ─────────────────────────────────────────────────────────

describe("applyAnchorSessionTransition — concurrency", () => {
  it("records exactly one transition when two writers race to the same status", async () => {
    seed({ status: "pending_anchor" });

    const results = await Promise.all([
      applyAnchorSessionTransition({ sessionId: "session_1", nextStatus: "completed", source: "poll" }),
      applyAnchorSessionTransition({ sessionId: "session_1", nextStatus: "completed", source: "webhook" }),
    ]);

    // Both read pending_anchor before either wrote — the conditional update
    // is the only thing that stopped the second one.
    expect(h.prisma.anchorSession.updateMany).toHaveBeenCalledTimes(2);
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect(historyOf()).toEqual(["completed"]);
    expect(transitionAudits()).toHaveLength(1);
  });

  it("lets exactly one of two conflicting terminal statuses win", async () => {
    seed({ status: "pending_anchor" });

    const results = await Promise.all([
      applyAnchorSessionTransition({ sessionId: "session_1", nextStatus: "completed", source: "poll" }),
      applyAnchorSessionTransition({ sessionId: "session_1", nextStatus: "error", source: "webhook" }),
    ]);

    const winners = results.filter((r) => r.changed);
    expect(winners).toHaveLength(1);
    expect(historyOf()).toEqual([stored().status]);
    expect(transitionAudits()).toHaveLength(1);
  });
});

// ─── 12. Lifecycles through the worker's poll path ──────────────────────────

describe("worker poll lifecycle", () => {
  it("walks a deposit from the interactive flow to completed", async () => {
    seed({ kind: "deposit", status: "pending_user_transfer_start" });
    anchorAnswers(
      "pending_user_transfer_start", // no change yet: user has not paid
      "pending_anchor",
      "pending_anchor", // re-polled: must not duplicate anything
      "pending_stellar",
      "completed"
    );

    for (let i = 0; i < 5; i += 1) await reconcileAnchors();

    expect(stored().status).toBe("completed");
    expect(historyOf()).toEqual(["pending_anchor", "pending_stellar", "completed"]);
    expect(transitionAudits().map((a) => [a.metadata.from, a.metadata.to])).toEqual([
      ["pending_user_transfer_start", "pending_anchor"],
      ["pending_anchor", "pending_stellar"],
      ["pending_stellar", "completed"],
    ]);
    expect(h.state.history.every((row) => row.source === "poll")).toBe(true);

    // Once terminal, the worker stops polling the session.
    await reconcileAnchors();
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("walks a withdrawal through legacy and unknown statuses to completed", async () => {
    seed({ kind: "withdrawal", status: "pending_user_transfer_start" });
    anchorAnswers(
      "pending_anchor",
      "pending_external", // deprecated alias → pending_anchor: no change
      "pending_quantum_review", // unknown: must not overwrite pending_anchor
      "pending_receiver",
      "completed"
    );

    for (let i = 0; i < 5; i += 1) {
      await reconcileAnchors();
      if (i === 2) expect(stored().status).toBe("pending_anchor");
    }

    expect(stored().status).toBe("completed");
    expect(historyOf()).toEqual(["pending_anchor", "pending_receiver", "completed"]);
  });

  it("records a terminal anchor error once, with the anchor's message as the reason", async () => {
    seed({ status: "pending_anchor" });
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          transaction: { id: "anchor_tx_1", kind: "deposit", status: "error", message: "KYC rejected" },
        }),
        { status: 200 }
      )
    );

    await reconcileAnchors();

    expect(stored()).toMatchObject({ status: "error", failureReason: "KYC rejected" });
    expect(h.state.history).toEqual([
      expect.objectContaining({ status: "error", reason: "KYC rejected", source: "poll" }),
    ]);
  });
});
