import { describe, it, expect } from "vitest";
import {
  SETTLEMENT_STATUSES,
  canTransitionSettlementStatus,
  isTerminalSettlementStatus,
  isSettlementRecoverable,
  type SettlementStatus,
} from "../src/services/settlement-machine";

/**
 * These tests state the properties the settlement state machine must have for
 * every pair of statuses, rather than listing examples: a table entry that lets
 * a terminal row move, or that makes a status both terminal and recoverable,
 * would corrupt settlement history and possibly double-pay an expense share.
 */
describe("settlement transition matrix invariants", () => {
  it("never allows a status to transition to itself", () => {
    for (const status of SETTLEMENT_STATUSES) {
      expect(
        canTransitionSettlementStatus(status, status),
        `${status} must not transition to itself`
      ).toBe(false);
    }
  });

  it("never allows a transition out of a terminal status", () => {
    for (const terminal of SETTLEMENT_STATUSES.filter(isTerminalSettlementStatus)) {
      for (const target of SETTLEMENT_STATUSES) {
        expect(
          canTransitionSettlementStatus(terminal, target),
          `${terminal} is terminal but allows ${target}`
        ).toBe(false);
      }
    }
  });

  it("only ever targets known statuses", () => {
    for (const from of SETTLEMENT_STATUSES) {
      for (const to of SETTLEMENT_STATUSES) {
        if (canTransitionSettlementStatus(from, to)) {
          expect(SETTLEMENT_STATUSES).toContain(to);
        }
      }
    }
  });

  it("reaches every non-terminal status from pending through legal steps", () => {
    const reachable = new Set<SettlementStatus>(["pending"]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const from of [...reachable]) {
        for (const to of SETTLEMENT_STATUSES) {
          if (!reachable.has(to) && canTransitionSettlementStatus(from, to)) {
            reachable.add(to);
            changed = true;
          }
        }
      }
    }

    for (const status of SETTLEMENT_STATUSES) {
      expect(reachable, `${status} is unreachable from pending`).toContain(status);
    }
  });

  it("keeps recovery limited to in-flight states", () => {
    for (const status of SETTLEMENT_STATUSES) {
      if (isSettlementRecoverable(status)) {
        expect(isTerminalSettlementStatus(status), `${status} cannot be both`).toBe(false);
      }
    }

    // needs_review is intentionally neither: Horizon could not be asked, so it
    // is not safe to retry blindly, and it is not proof of failure either.
    expect(isSettlementRecoverable("needs_review")).toBe(false);
    expect(isTerminalSettlementStatus("needs_review")).toBe(false);
  });

  it("keeps the documented edges of the machine", () => {
    expect(canTransitionSettlementStatus("pending", "submitted")).toBe(true);
    expect(canTransitionSettlementStatus("pending", "confirmed")).toBe(false);
    expect(canTransitionSettlementStatus("submitted", "verifying")).toBe(true);
    expect(canTransitionSettlementStatus("verifying", "needs_review")).toBe(true);
    expect(canTransitionSettlementStatus("verifying", "submitted")).toBe(true);
    expect(canTransitionSettlementStatus("pending_confirmation", "expired")).toBe(true);
    expect(canTransitionSettlementStatus("needs_review", "pending_confirmation")).toBe(
      true
    );
    expect(canTransitionSettlementStatus("needs_review", "submitted")).toBe(false);
  });

  it("classifies terminal, recoverable and review states consistently", () => {
    expect(SETTLEMENT_STATUSES.filter(isTerminalSettlementStatus).sort()).toEqual([
      "confirmed",
      "expired",
      "failed",
    ]);
    expect(SETTLEMENT_STATUSES.filter(isSettlementRecoverable).sort()).toEqual([
      "pending",
      "submitted",
      "verifying",
    ]);
  });
});
