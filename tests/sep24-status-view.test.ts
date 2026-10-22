/**
 * Unit tests for the SEP-24 status view (#651) — `toSep24TransactionView` and
 * `sanitizeStatusReason` in src/services/sep24-status.ts.
 *
 * The module is pure, so these assert the formatting rules directly instead of
 * going through a route; tests/sep24-transaction-status.test.ts covers the wire.
 */
import { describe, it, expect } from "vitest";
import {
  sanitizeStatusReason,
  toSep24TransactionView,
  type Sep24StatusHistoryRow,
  type Sep24StatusSession,
} from "../src/services/sep24-status";

const T0 = new Date("2026-01-01T00:00:00.000Z");
const T1 = new Date("2026-01-02T00:00:00.000Z");
const T2 = new Date("2026-01-03T00:00:00.000Z");

function session(over: Partial<Sep24StatusSession> = {}): Sep24StatusSession {
  return {
    id: "session_1",
    kind: "deposit",
    status: "pending_user_transfer_start",
    externalTransactionId: "ext_1",
    createdAt: T0,
    updatedAt: T1,
    ...over,
  };
}

function row(over: Partial<Sep24StatusHistoryRow> = {}): Sep24StatusHistoryRow {
  return { status: "incomplete", createdAt: T0, source: "user", ...over };
}

describe("toSep24TransactionView — required fields", () => {
  it("always answers the three fields SEP-24 requires, plus Mergepay's ids", () => {
    const view = toSep24TransactionView(session());

    expect(view).toMatchObject({
      id: "ext_1",
      kind: "deposit",
      status: "pending_user_transfer_start",
      session_id: "session_1",
      started_at: "2026-01-01T00:00:00.000Z",
    });
    expect(view.status_history).toEqual([]);
  });

  it("falls back to Mergepay's own id while the anchor's is unknown", () => {
    const view = toSep24TransactionView(session({ externalTransactionId: null }));

    // A session started before the interactive flow returns has no anchor id,
    // and `id` is the field a client is told to poll with — it cannot be absent.
    expect(view.id).toBe("session_1");
    expect(view.session_id).toBe("session_1");
  });

  it("reports the withdrawal direction and normalizes anything else to deposit", () => {
    expect(toSep24TransactionView(session({ kind: "withdrawal" })).kind).toBe(
      "withdrawal"
    );
    // The column is free text; the API only ever writes the two directions.
    expect(toSep24TransactionView(session({ kind: "exchange" })).kind).toBe(
      "deposit"
    );
    expect(toSep24TransactionView(session({ kind: "" })).kind).toBe("deposit");
  });

  it("accepts timestamps as strings as well as Dates", () => {
    const view = toSep24TransactionView(
      session({ createdAt: "2026-02-01T10:00:00Z", updatedAt: "2026-02-01T11:00:00Z" })
    );

    expect(view.started_at).toBe("2026-02-01T10:00:00.000Z");
    expect(view.updated_at).toBe("2026-02-01T11:00:00.000Z");
  });
});

describe("toSep24TransactionView — optional fields", () => {
  it("omits the spec fields it cannot answer instead of inventing them", () => {
    const view = toSep24TransactionView(
      session({ interactiveUrl: null, updatedAt: null, failureReason: null })
    );

    expect(view).not.toHaveProperty("more_info_url");
    expect(view).not.toHaveProperty("updated_at");
    expect(view).not.toHaveProperty("message");
    expect(view).not.toHaveProperty("completed_at");
    // A client that trusts these fields must not be handed an empty string.
    expect(view).not.toHaveProperty("status_eta");
    expect(view).not.toHaveProperty("amount_in");
  });

  it("surfaces the interactive URL as more_info_url", () => {
    const view = toSep24TransactionView(
      session({ interactiveUrl: "https://anchor.example/sep24?id=ext_1" })
    );

    expect(view.more_info_url).toBe("https://anchor.example/sep24?id=ext_1");
  });

  it("stamps completed_at from the transition into the terminal status", () => {
    const view = toSep24TransactionView(session({ status: "completed" }), [
      row({ status: "pending_anchor", createdAt: T1 }),
      row({ status: "completed", createdAt: T2 }),
    ]);

    // The session row has no completion column; the history does.
    expect(view.completed_at).toBe("2026-01-03T00:00:00.000Z");
  });

  it("leaves completed_at absent for a terminal status with no history read", () => {
    const view = toSep24TransactionView(session({ status: "error" }));

    expect(view).not.toHaveProperty("completed_at");
  });

  it("leaves completed_at absent while the transaction is still in flight", () => {
    const view = toSep24TransactionView(session({ status: "pending_stellar" }), [
      row({ status: "pending_stellar", createdAt: T1 }),
    ]);

    expect(view).not.toHaveProperty("completed_at");
  });
});

describe("toSep24TransactionView — status_history", () => {
  it("renders the timeline oldest-first from a newest-first read", () => {
    // getStatusHistory orders `desc` for callers that want the latest entry;
    // a timeline has to be reversed, or it reads backwards.
    const view = toSep24TransactionView(session(), [
      row({ status: "pending_anchor", createdAt: T2, reason: "Settling" }),
      row({ status: "incomplete", createdAt: T0, reason: null }),
      row({ status: "pending_user_transfer_start", createdAt: T1, source: "poll" }),
    ]);

    expect(view.status_history.map((e) => e.status)).toEqual([
      "incomplete",
      "pending_user_transfer_start",
      "pending_anchor",
    ]);
    expect(view.status_history[0]).toEqual({
      status: "incomplete",
      at: "2026-01-01T00:00:00.000Z",
      source: "user",
      reason: null,
    });
  });

  it("keeps each transition's own reason and source", () => {
    const view = toSep24TransactionView(session(), [
      row({ status: "pending_trust", createdAt: T1, reason: "Add a trustline" }),
      row({ status: "incomplete", createdAt: T0, reason: "Session created" }),
    ]);

    expect(view.status_history.map((e) => e.reason)).toEqual([
      "Session created",
      "Add a trustline",
    ]);
  });

  it("normalizes a missing reason or source to null", () => {
    const view = toSep24TransactionView(session(), [
      { status: "incomplete", createdAt: T0 } as Sep24StatusHistoryRow,
    ]);

    expect(view.status_history[0]).toMatchObject({ reason: null, source: null });
  });

  it("does not mutate the rows it was given", () => {
    const rows = [
      row({ status: "completed", createdAt: T2 }),
      row({ status: "incomplete", createdAt: T0 }),
    ];
    const before = rows.map((r) => r.createdAt);

    toSep24TransactionView(session(), rows);

    expect(rows.map((r) => r.createdAt)).toEqual(before);
  });
});

describe("toSep24TransactionView — message", () => {
  it("prefers the session's freshest anchor message", () => {
    // failureReason is rewritten on every callback and poll, including a
    // re-delivery that records no history row, so it is the only field that can
    // still describe the status the client is looking at.
    const view = toSep24TransactionView(
      session({ status: "pending_trust", failureReason: "Waiting on a trustline" }),
      [row({ status: "incomplete", createdAt: T0, reason: "Session created" })]
    );

    expect(view.message).toBe("Waiting on a trustline");
  });

  it("falls back to the newest transition's reason", () => {
    const view = toSep24TransactionView(session({ failureReason: null }), [
      row({ status: "pending_anchor", createdAt: T2, reason: "Settling" }),
      row({ status: "incomplete", createdAt: T0, reason: "Session created" }),
    ]);

    expect(view.message).toBe("Settling");
  });

  it("scrubs a credential out of the stored message before showing it", () => {
    const view = toSep24TransactionView(
      session({ failureReason: "retry with Bearer sk-secret-token later" })
    );

    expect(view.message).not.toContain("sk-secret-token");
    expect(view.message).toContain("bearer [redacted]");
  });

  it("omits the message for a failure reason that sanitizes to nothing", () => {
    const view = toSep24TransactionView(session({ failureReason: "   " }));

    expect(view).not.toHaveProperty("message");
  });
});

describe("sanitizeStatusReason", () => {
  it("returns undefined for absent, empty and whitespace-only text", () => {
    expect(sanitizeStatusReason(undefined)).toBeUndefined();
    expect(sanitizeStatusReason(null)).toBeUndefined();
    expect(sanitizeStatusReason("")).toBeUndefined();
    expect(sanitizeStatusReason("   \n\t ")).toBeUndefined();
  });

  it("redacts bearer tokens, key=value secrets and transaction envelopes", () => {
    // The value is replaced and the caller's own separator kept — `token=` and
    // `token:` both read as a credential assignment to the scrubber.
    expect(sanitizeStatusReason("use Bearer abc123.def-ghi to retry")).toBe(
      "use bearer [redacted] to retry"
    );
    expect(sanitizeStatusReason("token=shhh please wait")).toBe(
      "token=[redacted] please wait"
    );
    expect(sanitizeStatusReason("secret:hunter2")).toBe("secret:[redacted]");
    expect(sanitizeStatusReason("xdr:AAAAVE52Q0VWQUVTU1RSQU5TRUVTVElPTA==")).toBe(
      "xdr:[redacted]"
    );
  });

  it("collapses runs of whitespace and trims", () => {
    expect(sanitizeStatusReason("  your\ndeposit\t is   ready  ")).toBe(
      "your deposit is ready"
    );
  });

  it("bounds the result to the session column's length", () => {
    const long = "a".repeat(900);

    expect(sanitizeStatusReason(long)).toHaveLength(500);
  });

  it("is idempotent, so a stored reason survives a second pass", () => {
    const once = sanitizeStatusReason("Bearer abc123 then wait")!;

    expect(sanitizeStatusReason(once)).toBe(once);
  });
});
