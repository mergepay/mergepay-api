import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  HORIZON_STATUS_TIMEOUT_MS: 10000,
  mockTransactionCall: vi.fn(),
  mockPaymentsCall: vi.fn(),
}));

vi.mock("../src/config", () => ({
  config: {
    HORIZON_STATUS_TIMEOUT_MS: h.HORIZON_STATUS_TIMEOUT_MS,
    HORIZON_URL: "https://horizon-testnet.stellar.org",
    isTest: true,
  },
}));

vi.mock("@stellar/stellar-sdk", () => {
  const mockTransactions = () => ({
    transaction: vi.fn().mockReturnValue({ call: h.mockTransactionCall }),
  });
  const mockOperations = () => ({
    forTransaction: vi.fn().mockReturnValue({
      limit: vi.fn().mockReturnValue({
        call: h.mockPaymentsCall,
      }),
    }),
  });
  return {
    Horizon: {
      Server: vi.fn().mockImplementation(() => ({
        transactions: mockTransactions,
        operations: mockOperations,
      })),
    },
    Memo: {},
  };
});

vi.mock("../src/services/timeout", () => ({
  withTimeout: vi.fn((_name: string, _ms: number, fn: () => any) => fn()),
  TimeoutError: class TimeoutError extends Error {},
  TransportError: class TransportError extends Error {},
}));

import {
  verifyTransactionMemo,
  verifyPaymentOperation,
  getTransactionFromHorizon,
  getTransactionPayments,
  type HorizonTransactionRecord,
  type HorizonPaymentOperation,
} from "../src/services/horizonService";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeTxRecord(over: Partial<HorizonTransactionRecord> = {}): HorizonTransactionRecord {
  return {
    hash: "abc123def456",
    successful: true,
    memo: "MP:ABC123",
    memo_type: "text",
    source_account: "GFROM...",
    fee_charged: 100,
    operation_count: 1,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function makePaymentOp(over: Partial<HorizonPaymentOperation> = {}): HorizonPaymentOperation {
  return {
    type: "payment",
    destination: "GTO...",
    amount: "10.0000000",
    asset_type: "native",
    asset_code: undefined,
    asset_issuer: undefined,
    source_account: "GFROM...",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// getTransactionFromHorizon
// ---------------------------------------------------------------------------

describe("getTransactionFromHorizon", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a transaction record on success", async () => {
    const record = makeTxRecord();
    h.mockTransactionCall.mockResolvedValue(record);

    const result = await getTransactionFromHorizon("tx_hash_1");

    expect(result).toEqual(record);
  });

  it("returns null for 404", async () => {
    const error = Object.assign(new Error("Not Found"), {
      response: { status: 404 },
    });
    h.mockTransactionCall.mockRejectedValue(error);

    const result = await getTransactionFromHorizon("tx_hash_notfound");

    expect(result).toBeNull();
  });

  it("returns null for NotFoundError", async () => {
    const error = new Error("Not Found");
    error.name = "NotFoundError";
    h.mockTransactionCall.mockRejectedValue(error);

    const result = await getTransactionFromHorizon("tx_hash_notfound2");

    expect(result).toBeNull();
  });

  it("re-throws TimeoutError", async () => {
    const { TimeoutError } = await import("../src/services/timeout");
    h.mockTransactionCall.mockRejectedValue(new TimeoutError("timed out"));

    await expect(getTransactionFromHorizon("tx_hash_timeout")).rejects.toThrow("timed out");
  });

  it("re-throws TransportError", async () => {
    const { TransportError } = await import("../src/services/timeout");
    h.mockTransactionCall.mockRejectedValue(new TransportError("connection reset"));

    await expect(getTransactionFromHorizon("tx_hash_transport")).rejects.toThrow(
      "connection reset"
    );
  });

  it("wraps generic errors in Errors.upstream", async () => {
    h.mockTransactionCall.mockRejectedValue(new Error("Horizon request failed: connection timeout"));

    await expect(getTransactionFromHorizon("tx_hash_generic")).rejects.toThrow(
      "Horizon request failed: connection timeout"
    );
  });
});

// ---------------------------------------------------------------------------
// getTransactionPayments
// ---------------------------------------------------------------------------

describe("getTransactionPayments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns payment operations", async () => {
    const op = makePaymentOp();
    h.mockPaymentsCall.mockResolvedValue({ records: [op, { type: "manage_data" }] });

    const result = await getTransactionPayments("tx_hash_1");

    expect(result).toEqual([op]);
  });

  it("returns empty array when no payment ops", async () => {
    h.mockPaymentsCall.mockResolvedValue({ records: [{ type: "manage_data" }] });

    const result = await getTransactionPayments("tx_hash_2");

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// verifyTransactionMemo
// ---------------------------------------------------------------------------

describe("verifyTransactionMemo — valid MP: memo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns verified:true when memo matches", async () => {
    h.mockTransactionCall.mockResolvedValue(
      makeTxRecord({ memo: "MP:ABC123", memo_type: "text" })
    );

    const result = await verifyTransactionMemo("tx_hash_1", "MP:ABC123");

    expect(result).toEqual({ verified: true });
  });
});

describe("verifyTransactionMemo — memo mismatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws transaction_verification_failed when memo differs", async () => {
    h.mockTransactionCall.mockResolvedValue(
      makeTxRecord({ memo: "MP:DIFFERENT", memo_type: "text" })
    );

    await expect(verifyTransactionMemo("tx_hash_2", "MP:ABC123")).rejects.toThrow(
      "Transaction memo does not match the expected settlement reference"
    );
  });
});

describe("verifyTransactionMemo — missing memo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws transaction_verification_failed when memo is absent", async () => {
    h.mockTransactionCall.mockResolvedValue(
      makeTxRecord({ memo: undefined, memo_type: "none" })
    );

    await expect(verifyTransactionMemo("tx_hash_3", "MP:ABC123")).rejects.toThrow(
      "Transaction has no memo"
    );
  });
});

describe("verifyTransactionMemo — wrong memo type", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws transaction_verification_failed when memo type is 'id'", async () => {
    h.mockTransactionCall.mockResolvedValue(
      makeTxRecord({ memo: "12345", memo_type: "id" })
    );

    await expect(verifyTransactionMemo("tx_hash_4", "MP:ABC123")).rejects.toThrow(
      'Unexpected memo type: expected "text", got "id"'
    );
  });

  it("throws transaction_verification_failed when memo type is 'hash'", async () => {
    h.mockTransactionCall.mockResolvedValue(
      makeTxRecord({ memo: undefined, memo_type: "hash" })
    );

    await expect(verifyTransactionMemo("tx_hash_4b", "MP:ABC123")).rejects.toThrow(
      'Unexpected memo type: expected "text", got "hash"'
    );
  });
});

describe("verifyTransactionMemo — failed transaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws transaction_verification_failed when successful is false", async () => {
    h.mockTransactionCall.mockResolvedValue(
      makeTxRecord({ successful: false })
    );

    await expect(verifyTransactionMemo("tx_hash_5", "MP:ABC123")).rejects.toThrow(
      "Transaction was not successful on Stellar"
    );
  });
});

describe("verifyTransactionMemo — transaction not found", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws not_found when transaction does not exist", async () => {
    h.mockTransactionCall.mockResolvedValue(null);

    await expect(verifyTransactionMemo("tx_hash_6", "MP:ABC123")).rejects.toThrow(
      "Transaction not found on Horizon"
    );
  });
});

describe("verifyTransactionMemo — Horizon network error", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("propagates upstream errors from getTransactionFromHorizon", async () => {
    h.mockTransactionCall.mockRejectedValue(
      new Error("Horizon request failed: connection timeout")
    );

    await expect(verifyTransactionMemo("tx_hash_7", "MP:ABC123")).rejects.toThrow(
      "Horizon request failed: connection timeout"
    );
  });
});

// ---------------------------------------------------------------------------
// verifyPaymentOperation
// ---------------------------------------------------------------------------

describe("verifyPaymentOperation — wrong destination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws settlement_verification_failed when destination mismatches", () => {
    const op = makePaymentOp({ destination: "GWRONG..." });

    expect(() =>
      verifyPaymentOperation(op, {
        destination: "GTO...",
        amount: "10.0000000",
        assetCode: "XLM",
        assetIssuer: null,
      })
    ).toThrow("Payment destination does not match the expected recipient");
  });
});

describe("verifyPaymentOperation — wrong amount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws settlement_verification_failed when amount mismatches", () => {
    const op = makePaymentOp({ amount: "5.0000000" });

    expect(() =>
      verifyPaymentOperation(op, {
        destination: "GTO...",
        amount: "10.0000000",
        assetCode: "XLM",
        assetIssuer: null,
      })
    ).toThrow("Payment amount does not match the expected settlement amount");
  });
});

describe("verifyPaymentOperation — valid payment accepted", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts a matching native XLM payment", () => {
    const op = makePaymentOp({
      destination: "GTO...",
      amount: "10.0000000",
      asset_type: "native",
    });

    expect(() =>
      verifyPaymentOperation(op, {
        destination: "GTO...",
        amount: "10.0000000",
        assetCode: "XLM",
        assetIssuer: null,
      })
    ).not.toThrow();
  });

  it("accepts a matching USDC payment", () => {
    const op = makePaymentOp({
      destination: "GTO...",
      amount: "25.5000000",
      asset_type: "credit_alphanum4",
      asset_code: "USDC",
      asset_issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    });

    expect(() =>
      verifyPaymentOperation(op, {
        destination: "GTO...",
        amount: "25.5000000",
        assetCode: "USDC",
        assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      })
    ).not.toThrow();
  });

  it("normalizes amounts for comparison (trailing zeros)", () => {
    const op = makePaymentOp({
      destination: "GTO...",
      amount: "10.0",
      asset_type: "native",
    });

    expect(() =>
      verifyPaymentOperation(op, {
        destination: "GTO...",
        amount: "10.0000000",
        assetCode: "XLM",
        assetIssuer: null,
      })
    ).not.toThrow();
  });
});

describe("verifyPaymentOperation — edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects wrong asset code for non-native", () => {
    const op = makePaymentOp({
      asset_type: "credit_alphanum4",
      asset_code: "EURC",
      asset_issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    });

    expect(() =>
      verifyPaymentOperation(op, {
        destination: "GTO...",
        amount: "10.0000000",
        assetCode: "USDC",
        assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      })
    ).toThrow('Payment asset code does not match: expected "USDC", got "EURC"');
  });

  it("rejects wrong asset issuer", () => {
    const op = makePaymentOp({
      asset_type: "credit_alphanum4",
      asset_code: "USDC",
      asset_issuer: "GWRONG...",
    });

    expect(() =>
      verifyPaymentOperation(op, {
        destination: "GTO...",
        amount: "10.0000000",
        assetCode: "USDC",
        assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      })
    ).toThrow("Payment asset issuer does not match");
  });

  it("rejects non-native when native expected", () => {
    const op = makePaymentOp({
      asset_type: "credit_alphanum4",
      asset_code: "XLM",
      asset_issuer: null,
    });

    expect(() =>
      verifyPaymentOperation(op, {
        destination: "GTO...",
        amount: "10.0000000",
        assetCode: "XLM",
        assetIssuer: null,
      })
    ).toThrow("Payment asset does not match: expected native XLM");
  });

  it("rejects non-payment operation type", () => {
    const op = { type: "create_account", destination: "GTO...", amount: "10.0000000" };

    expect(() =>
      verifyPaymentOperation(op as any, {
        destination: "GTO...",
        amount: "10.0000000",
        assetCode: "XLM",
        assetIssuer: null,
      })
    ).toThrow('Expected a payment operation, got "create_account"');
  });
});
