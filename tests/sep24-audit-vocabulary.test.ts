import { describe, it, expect } from "vitest";
import {
  isWithdrawalKind,
  sep24StartAction,
  sep24LifecycleAction,
  sep24CallbackAuditMetadata,
  anchorTransactionAuditMetadata,
} from "../src/services/sep24-audit";
import { SEP24_TERMINAL_STATUSES } from "../src/services/sep24-types";

describe("SEP-24 audit action vocabulary", () => {
  it("names the start of each flow after its direction", () => {
    expect(sep24StartAction("deposit")).toBe("anchor.deposit.started");
    expect(sep24StartAction("withdrawal")).toBe("anchor.withdrawal.started");
  });

  it("maps a completed transaction to the completed action", () => {
    expect(sep24LifecycleAction("deposit", "completed")).toBe("anchor.deposit.completed");
    expect(sep24LifecycleAction("withdrawal", "completed")).toBe(
      "anchor.withdrawal.completed"
    );
  });

  it("maps every terminal failure status to the failed action", () => {
    for (const status of SEP24_TERMINAL_STATUSES.filter((s) => s !== "completed")) {
      expect(sep24LifecycleAction("deposit", status)).toBe("anchor.deposit.failed");
      expect(sep24LifecycleAction("withdrawal", status)).toBe(
        "anchor.withdrawal.failed"
      );
    }
  });

  it("leaves intermediate states to the generic session transition action", () => {
    for (const status of ["incomplete", "pending_anchor", "pending_stellar"] as const) {
      expect(sep24LifecycleAction("deposit", status)).toBeUndefined();
      expect(sep24LifecycleAction("withdrawal", status)).toBeUndefined();
    }
  });

  it("treats anything other than the withdrawal kind as a deposit", () => {
    expect(isWithdrawalKind("withdrawal")).toBe(true);
    expect(isWithdrawalKind("deposit")).toBe(false);
    expect(isWithdrawalKind(null)).toBe(false);
    expect(isWithdrawalKind(undefined)).toBe(false);
    expect(sep24LifecycleAction(null, "completed")).toBe("anchor.deposit.completed");
  });
});

describe("SEP-24 audit metadata", () => {
  it("keeps the raw status and the traceable public facts", () => {
    const metadata = sep24CallbackAuditMetadata({
      rawStatus: "completed",
      stellarTransactionId: "abc123",
      amountIn: "10.00",
      amountOut: "9.50",
      amountFee: "0.50",
    } as never);

    expect(metadata).toEqual({
      rawStatus: "completed",
      stellarTransactionId: "abc123",
      amountIn: "10.00",
      amountOut: "9.50",
      amountFee: "0.50",
    });
  });

  it("trims values and drops blank ones instead of writing empty keys", () => {
    const metadata = sep24CallbackAuditMetadata({
      rawStatus: "pending_anchor",
      stellarTransactionId: "  abc123  ",
      amountIn: "   ",
      amountOut: "",
      amountFee: undefined,
    } as never);

    expect(metadata).toEqual({
      rawStatus: "pending_anchor",
      stellarTransactionId: "abc123",
    });
    expect(Object.keys(metadata)).not.toContain("amountIn");
    expect(Object.keys(metadata)).not.toContain("amountFee");
  });

  it("copies only named fields, so tokens and signed payloads never reach the audit row", () => {
    const metadata = sep24CallbackAuditMetadata({
      rawStatus: "completed",
      anchorToken: "secret-anchor-token",
      jwt: "secret-jwt",
      signedXdr: "AAAAAgAAAAB-signed-xdr",
      privateKey: "SABCDEF",
    } as never);

    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain("secret-anchor-token");
    expect(serialized).not.toContain("secret-jwt");
    expect(serialized).not.toContain("signed-xdr");
    expect(serialized).not.toContain("SABCDEF");
    expect(metadata).toEqual({ rawStatus: "completed" });
  });

  it("maps a validated anchor transaction response and drops empty fields", () => {
    const metadata = anchorTransactionAuditMetadata({
      status: "completed",
      stellar_transaction_id: " tx-hash ",
      amount_in: "5.00",
      amount_out: null,
      amount_fee: "",
      amount_in_asset: "USDC",
    });

    expect(metadata).toEqual({
      rawStatus: "completed",
      stellarTransactionId: "tx-hash",
      amountIn: "5.00",
      assetCode: "USDC",
    });
  });
});
