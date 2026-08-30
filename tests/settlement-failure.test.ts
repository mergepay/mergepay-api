/**
 * Settlement failure classification and exposure (issue #195).
 *
 * Two things are being pinned down here: that a given failure lands in the same
 * category no matter which path observed it, and that nothing sensitive
 * survives into what gets persisted or returned.
 */
import { describe, it, expect } from "vitest";
import {
  MAX_FAILURE_DETAIL_LENGTH,
  SETTLEMENT_FAILURE_CATEGORIES,
  classifySettlementFailure,
  isSettlementFailureCategory,
  redactFailureDetail,
  settlementFailureFields,
  toSafeDetail,
} from "../src/services/settlement-failure";
import { toFailureInfo, toPublicStatus } from "../src/services/settlement-status";
import { AppError, Errors } from "../src/errors";
import { TimeoutError, TransportError } from "../src/services/timeout";

function statusRow(overrides: Record<string, unknown> = {}) {
  return {
    status: "failed",
    stellarTxHash: null,
    failureReason: "Stellar rejected the transaction",
    failureCategory: "ledger_rejected",
    expiresAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as Parameters<typeof toFailureInfo>[0];
}

describe("category set", () => {
  it("recognises every documented category and nothing else", () => {
    for (const category of SETTLEMENT_FAILURE_CATEGORIES) {
      expect(isSettlementFailureCategory(category)).toBe(true);
    }
    for (const bogus of ["", "unknown", "TRANSIENT", null, undefined, 7]) {
      expect(isSettlementFailureCategory(bogus)).toBe(false);
    }
  });
});

describe("classification by error code", () => {
  it.each([
    ["INTENT_EXPIRED", Errors.badRequest("intent_expired", "Window closed"), "expired"],
    ["XDR_MISMATCH", Errors.badRequest("xdr_mismatch", "Amount does not match"), "validation"],
    ["XDR_MALFORMED", Errors.badRequest("xdr_malformed", "Unparseable"), "validation"],
    ["ACCOUNT_UNFUNDED", Errors.badRequest("account_unfunded", "Fund it"), "insufficient_funds"],
    ["MISSING_TRUSTLINE", Errors.badRequest("missing_trustline", "No trustline"), "insufficient_funds"],
    ["INSUFFICIENT_BALANCE", Errors.badRequest("insufficient_balance", "Short"), "insufficient_funds"],
    ["INSUFFICIENT_FEE_BALANCE", Errors.badRequest("insufficient_fee_balance", "Short"), "insufficient_funds"],
    ["UNAUTHORIZED", Errors.unauthorized(), "validation"],
    ["FORBIDDEN", Errors.forbidden(), "validation"],
    ["UPSTREAM_ERROR", Errors.upstream("Horizon unavailable"), "upstream"],
  ] as const)("maps %s to %s", (_code, error, expected) => {
    expect(classifySettlementFailure(error).category).toBe(expected);
  });

  it("falls back to the status class for an unnamed code", () => {
    expect(
      classifySettlementFailure(new AppError(503, "SOMETHING_NEW", "Down")).category
    ).toBe("upstream");
    expect(
      classifySettlementFailure(new AppError(429, "SOMETHING_NEW", "Slow down")).category
    ).toBe("upstream");
    expect(
      classifySettlementFailure(new AppError(422, "SOMETHING_NEW", "Nope")).category
    ).toBe("validation");
  });
});

describe("classification by error type and message", () => {
  it("treats typed timeout and transport errors as upstream", () => {
    expect(classifySettlementFailure(new TimeoutError("op", 100)).category).toBe(
      "upstream"
    );
    expect(
      classifySettlementFailure(new TransportError("op", new Error("reset"))).category
    ).toBe("upstream");
  });

  it.each([
    ["op_underfunded", "insufficient_funds"],
    ["op_no_trust", "insufficient_funds"],
    ["tx_insufficient_fee", "insufficient_funds"],
    ["tx_too_late", "expired"],
    ["tx_bad_seq", "ledger_rejected"],
    ["Stellar rejected the transaction", "ledger_rejected"],
    ["socket hang up", "upstream"],
    ["ECONNREFUSED 127.0.0.1:8000", "upstream"],
    ["Transaction signature is invalid", "validation"],
    ["Payment destination does not match", "validation"],
  ] as const)("maps a %s message to %s", (message, expected) => {
    expect(classifySettlementFailure(new Error(message)).category).toBe(expected);
  });

  it("prefers expiry over ledger rejection for tx_too_late", () => {
    // tx_too_late is both an expiry and a rejection; expiry names the remedy.
    expect(
      classifySettlementFailure(new Error("tx_failed: tx_too_late")).category
    ).toBe("expired");
  });

  it("falls back to internal for an unrecognised failure", () => {
    expect(classifySettlementFailure(new Error("something odd")).category).toBe(
      "internal"
    );
    expect(classifySettlementFailure(null).category).toBe("internal");
  });
});

describe("sanitization", () => {
  it("strips a bare Stellar secret seed", () => {
    const seed = `S${"A".repeat(55)}`;
    const detail = toSafeDetail(new Error(`signing failed with ${seed}`));
    expect(detail).not.toContain(seed);
    expect(detail).toContain("[redacted]");
  });

  it("strips a bare XDR-sized base64 blob", () => {
    const xdr = "AAAAAg".repeat(40);
    const detail = toSafeDetail(new Error(`submit failed for ${xdr}`));
    expect(detail).not.toContain(xdr);
    expect(detail).toContain("[redacted]");
  });

  it("strips a labelled signed XDR", () => {
    const detail = toSafeDetail(new Error("failed: signedXdr=AAAAAgAAAABtest"));
    expect(detail).not.toContain("AAAAAgAAAABtest");
  });

  it("strips bearer tokens and labelled credentials", () => {
    const detail = toSafeDetail(
      new Error("upstream said bearer abc.def.ghi and secret=hunter2")
    );
    expect(detail).not.toContain("abc.def.ghi");
    expect(detail).not.toContain("hunter2");
  });

  it("leaves ordinary hashes and public keys alone", () => {
    // A tx hash is 64 hex chars — well under the XDR-blob threshold, and
    // useful to operators, so it must survive.
    const hash = "a".repeat(64);
    expect(redactFailureDetail(`Transaction ${hash} failed`)).toContain(hash);
  });

  it("caps the detail length", () => {
    const detail = toSafeDetail(new Error("x".repeat(5_000)));
    expect(detail.length).toBeLessThanOrEqual(MAX_FAILURE_DETAIL_LENGTH);
  });

  it("never yields an empty detail", () => {
    expect(toSafeDetail(new Error("")).length).toBeGreaterThan(0);
    expect(toSafeDetail(undefined).length).toBeGreaterThan(0);
  });

  it("collapses a multi-line stack into a single scrubbed line", () => {
    const error = new Error("boom");
    error.stack = "Error: boom\n    at foo (/srv/app/src/x.ts:1:1)";
    const detail = toSafeDetail(error);
    expect(detail).not.toContain("\n");
    expect(detail).toBe("boom");
  });
});

describe("persisted failure fields", () => {
  it("returns a category and a sanitized reason together", () => {
    const fields = settlementFailureFields(
      Errors.badRequest("xdr_mismatch", "Payment amount does not match")
    );
    expect(fields).toEqual({
      failureCategory: "validation",
      failureReason: "Payment amount does not match",
    });
  });

  it("sanitizes the reason it persists", () => {
    const fields = settlementFailureFields(
      new Error(`rejected for ${"AAAAAg".repeat(40)}`)
    );
    expect(fields.failureReason).toContain("[redacted]");
  });
});

describe("status exposure", () => {
  it("returns failure information for a failed settlement", () => {
    const row = statusRow();
    expect(toFailureInfo(row, toPublicStatus(row))).toEqual({
      category: "ledger_rejected",
      reason: "Stellar rejected the transaction",
    });
  });

  it.each(["pending", "submitted", "confirmed"] as const)(
    "withholds failure information from a %s settlement",
    (status) => {
      // The worker records a reason between retries; a settlement still in
      // flight must not report it as though it had failed.
      const row = statusRow({
        status,
        failureReason: "attempt 1 timed out",
        failureCategory: "upstream",
      });
      expect(toFailureInfo(row, toPublicStatus(row))).toBeNull();
    }
  );

  it("withholds failure information from an expired settlement", () => {
    const row = statusRow({
      status: "pending",
      expiresAt: new Date("2020-01-01T00:00:00Z"),
    });
    expect(toPublicStatus(row)).toBe("expired");
    expect(toFailureInfo(row, toPublicStatus(row))).toBeNull();
  });

  it("reads a pre-migration failed row as internal rather than dropping it", () => {
    // Rows that failed before failure_category existed still answer usefully.
    const row = statusRow({ failureCategory: null });
    expect(toFailureInfo(row, "failed")).toEqual({
      category: "internal",
      reason: "Stellar rejected the transaction",
    });
  });

  it("does not pass through an unrecognised persisted category", () => {
    const row = statusRow({ failureCategory: "something_else" });
    expect(toFailureInfo(row, "failed")?.category).toBe("internal");
  });

  it("supplies a reason when a failed row recorded none", () => {
    const row = statusRow({ failureReason: null, failureCategory: "upstream" });
    expect(toFailureInfo(row, "failed")).toEqual({
      category: "upstream",
      reason: "Settlement failed",
    });
  });
});
