/**
 * SEP-24 transaction status type definitions.
 *
 * The canonical union in `src/services/sep24-types.ts` is only useful if every
 * layer actually derives from it, so these tests assert both the shape of the
 * type tables *and* that the consumers wired to them — `mapAnchorStatus` in
 * anchor.ts, the session vocabulary in anchor-status.ts — agree with it. A
 * future edit that re-introduces a hand-written copy of the list fails here.
 */
import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({
  prisma: {
    anchorSession: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("../src/services/anchor-circuit", () => ({
  anchorCircuit: {
    isOpen: vi.fn(() => false),
    recordFailure: vi.fn(),
    recordSuccess: vi.fn(),
  },
}));

vi.mock("../src/config", () => ({
  config: {
    ANCHOR_HOME_DOMAIN: "testanchor.stellar.org",
    ANCHOR_TOML_TIMEOUT_MS: 5000,
    ANCHOR_CHALLENGE_TIMEOUT_MS: 5000,
    ANCHOR_TOKEN_TIMEOUT_MS: 5000,
    ANCHOR_INTERACTIVE_TIMEOUT_MS: 5000,
    ANCHOR_POLL_TIMEOUT_MS: 5000,
    networkPassphrase: "Test SDF Network ; September 2015",
    UPSTREAM_RETRY_MAX_ATTEMPTS: 3,
    UPSTREAM_RETRY_INITIAL_DELAY_MS: 100,
    UPSTREAM_RETRY_MAX_DELAY_MS: 1000,
    UPSTREAM_RETRY_JITTER_RATIO: 0,
    SEP24_WEBHOOK_TOLERANCE_MS: 300000,
  },
  env: { NODE_ENV: "test", DATABASE_QUERY_TIMEOUT_MS: 10000 },
}));

vi.mock("../src/db", () => ({ prisma: h.prisma }));

import {
  SEP24_TRANSACTION_STATUSES,
  SEP24_LEGACY_STATUSES,
  SEP24_INITIAL_STATUSES,
  SEP24_INTERMEDIATE_STATUSES,
  SEP24_TERMINAL_STATUSES,
  SEP24_STATUS_CATEGORY,
  KNOWN_SEP24_STATUSES,
  isSep24TransactionStatus,
  isRecognisedSep24Status,
  isTerminalSep24Status,
  isIntermediateSep24Status,
  isInitialSep24Status,
  sep24StatusCategory,
  sep24TransactionState,
} from "../src/services/sep24-types";
import { mapAnchorStatus, isKnownSep24Status } from "../src/services/anchor";
import {
  ANCHOR_SESSION_STATUSES,
  isTerminalAnchorStatus,
} from "../src/services/anchor-status";

describe("canonical SEP-24 status union", () => {
  it("exposes the full documented status set with no duplicates", () => {
    expect(new Set(SEP24_TRANSACTION_STATUSES).size).toBe(
      SEP24_TRANSACTION_STATUSES.length
    );
    expect(SEP24_TRANSACTION_STATUSES).toHaveLength(16);
    expect(SEP24_TRANSACTION_STATUSES).toContain("incomplete");
    expect(SEP24_TRANSACTION_STATUSES).toContain("completed");
    expect(SEP24_TRANSACTION_STATUSES).toContain("expired");
    expect(SEP24_TRANSACTION_STATUSES).toContain("pending_anchor");
  });

  it("backs KNOWN_SEP24_STATUSES with the same members", () => {
    expect(KNOWN_SEP24_STATUSES.size).toBe(SEP24_TRANSACTION_STATUSES.length);
    for (const status of SEP24_TRANSACTION_STATUSES) {
      expect(KNOWN_SEP24_STATUSES.has(status)).toBe(true);
    }
  });

  it("recognises every member case-insensitively and with surrounding space", () => {
    for (const status of SEP24_TRANSACTION_STATUSES) {
      expect(isSep24TransactionStatus(status)).toBe(true);
      expect(isSep24TransactionStatus(status.toUpperCase())).toBe(true);
      expect(isSep24TransactionStatus(`  ${status}  `)).toBe(true);
    }
  });

  it("rejects unknown and empty statuses", () => {
    expect(isSep24TransactionStatus("brand_new_future_status")).toBe(false);
    expect(isSep24TransactionStatus("")).toBe(false);
    // The issue suggested `pending_external_submission`; it is not a SEP-24
    // status and is deliberately not invented into the union.
    expect(isSep24TransactionStatus("pending_external_submission")).toBe(false);
  });
});

describe("deprecated status aliases", () => {
  it("recognises historical statuses without admitting them to the union", () => {
    for (const legacy of SEP24_LEGACY_STATUSES) {
      expect(isRecognisedSep24Status(legacy)).toBe(true);
      expect(isSep24TransactionStatus(legacy)).toBe(false);
    }
  });

  it("still normalizes a deprecated status to the safe pending_anchor state", () => {
    expect(mapAnchorStatus("pending_external")).toBe("pending_anchor");
    expect(mapAnchorStatus("pending_user_transfer_complete")).toBe(
      "pending_anchor"
    );
  });
});

describe("lifecycle categories", () => {
  it("partitions the union exactly once across initial/intermediate/terminal", () => {
    const grouped = [
      ...SEP24_INITIAL_STATUSES,
      ...SEP24_INTERMEDIATE_STATUSES,
      ...SEP24_TERMINAL_STATUSES,
    ];
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual([...SEP24_TRANSACTION_STATUSES].sort());
  });

  it("classifies each status consistently across every accessor", () => {
    for (const status of SEP24_TRANSACTION_STATUSES) {
      const category = sep24StatusCategory(status);
      expect(SEP24_STATUS_CATEGORY[status]).toBe(category);
      expect(isInitialSep24Status(status)).toBe(category === "initial");
      expect(isIntermediateSep24Status(status)).toBe(
        category === "intermediate"
      );
      expect(isTerminalSep24Status(status)).toBe(category === "terminal");
    }
  });

  it("treats completed, error, refunded, expired, no_market, too_small and too_large as terminal", () => {
    expect([...SEP24_TERMINAL_STATUSES].sort()).toEqual(
      [
        "completed",
        "error",
        "refunded",
        "expired",
        "no_market",
        "too_small",
        "too_large",
      ].sort()
    );
  });
});

describe("wiring with existing anchor service logic", () => {
  it("re-exports isKnownSep24Status from anchor with identical behaviour", () => {
    for (const status of SEP24_TRANSACTION_STATUSES) {
      expect(isKnownSep24Status(status)).toBe(true);
      expect(isKnownSep24Status(status.toUpperCase())).toBe(true);
    }
    expect(isKnownSep24Status("nope")).toBe(false);
    expect(isKnownSep24Status("")).toBe(false);
  });

  it("maps every canonical status to itself", () => {
    for (const status of SEP24_TRANSACTION_STATUSES) {
      expect(mapAnchorStatus(status)).toBe(status);
      expect(mapAnchorStatus(status.toUpperCase())).toBe(status);
    }
  });

  it("collapses unknown statuses to the safe pending_anchor default", () => {
    expect(mapAnchorStatus("unknown_status")).toBe("pending_anchor");
    expect(mapAnchorStatus("")).toBe("pending_anchor");
  });

  it("shares one status vocabulary with the anchor-session state machine", () => {
    expect([...ANCHOR_SESSION_STATUSES].sort()).toEqual(
      [...SEP24_TRANSACTION_STATUSES].sort()
    );
  });

  it("agrees on which statuses are terminal", () => {
    for (const status of SEP24_TRANSACTION_STATUSES) {
      expect(isTerminalAnchorStatus(status)).toBe(
        isTerminalSep24Status(status)
      );
    }
  });
});

describe("sep24TransactionState", () => {
  it("builds a deposit state view with derived category and terminal flag", () => {
    const state = sep24TransactionState("deposit", "pending_anchor");
    expect(state).toEqual({
      kind: "deposit",
      status: "pending_anchor",
      category: "intermediate",
      terminal: false,
    });
  });

  it("builds a withdrawal state view for a terminal status", () => {
    const state = sep24TransactionState("withdrawal", "completed");
    expect(state).toEqual({
      kind: "withdrawal",
      status: "completed",
      category: "terminal",
      terminal: true,
    });
  });

  it("derives category and terminal correctly for every status", () => {
    for (const status of SEP24_TRANSACTION_STATUSES) {
      const state = sep24TransactionState("deposit", status);
      expect(state.category).toBe(SEP24_STATUS_CATEGORY[status]);
      expect(state.terminal).toBe(isTerminalSep24Status(status));
    }
  });
});
