/**
 * Issue #810 — Stellar Horizon error mapping.
 *
 * These tests pin the translation from raw SDK/Horizon failures to the
 * repository's client-safe error envelope: known transaction and operation
 * result codes map to a stable API code, an appropriate HTTP status, and an
 * actionable hint; unrecognized codes still yield `PROVIDER_REJECTED` while
 * preserving only validated result-code tokens; unrelated errors are left
 * alone.
 */
import { describe, expect, it } from "vitest";
import { xdr } from "@stellar/stellar-sdk";
import {
  enumNameToResultCode,
  extractHorizonResultCodes,
  isPermanentHorizonResultCode,
  mapHorizonError,
} from "../src/services/horizon-errors";
import { classifyHorizonError } from "../src/services/horizon-retry";
import { isTransientHorizonError } from "../src/utils/retry";
import { TransportError, toProviderError } from "../src/services/timeout";
import { ProviderError } from "../src/lib/provider-error";

/** Build a base64 TransactionResult carrying the given top-level verdict. */
function resultXdr(result: xdr.TransactionResultResult): string {
  return new xdr.TransactionResult({
    feeCharged: xdr.Int64.fromString("100"),
    result,
    ext: xdr.TransactionResultExt.fromXDR(Buffer.alloc(4)),
  }).toXDR("base64");
}

/** The shape the Stellar SDK attaches to rejected submissions. */
function sdkError(data: Record<string, unknown>) {
  return { response: { status: 400, data } };
}

describe("mapHorizonError", () => {
  it("maps a transaction-level result code to its API code and status", () => {
    const mapping = mapHorizonError(
      sdkError({
        type: "https://stellar.org/horizon-errors/transaction_failed",
        extras: { result_codes: { transaction: "tx_bad_seq" } },
      })
    );

    expect(mapping).toEqual({
      status: 409,
      code: "STELLAR_SEQUENCE_CONFLICT",
      message: "The Stellar account sequence is out of date.",
      hint: "Refresh the account and rebuild the transaction before signing again.",
      resultCodes: ["tx_bad_seq"],
    });
  });

  it("maps the failing operation when the transaction verdict is tx_failed", () => {
    const mapping = mapHorizonError(
      sdkError({
        extras: {
          result_codes: {
            transaction: "tx_failed",
            operations: ["op_underfunded"],
          },
        },
      })
    );

    expect(mapping).toMatchObject({
      status: 422,
      code: "STELLAR_INSUFFICIENT_FUNDS",
    });
    expect(mapping?.resultCodes).toEqual(["tx_failed", "op_underfunded"]);
  });

  it("derives the transaction verdict from a base64 result_xdr", () => {
    const mapping = mapHorizonError(
      sdkError({
        extras: { result_xdr: resultXdr(xdr.TransactionResultResult.txBadSeq()) },
      })
    );

    expect(mapping).toMatchObject({
      status: 409,
      code: "STELLAR_SEQUENCE_CONFLICT",
    });
    expect(mapping?.resultCodes).toEqual(["tx_bad_seq"]);
  });

  it("prefers the result_xdr verdict over conflicting result codes", () => {
    const mapping = mapHorizonError(
      sdkError({
        extras: {
          result_codes: { transaction: "tx_insufficient_fee" },
          result_xdr: resultXdr(xdr.TransactionResultResult.txBadSeq()),
        },
      })
    );

    expect(mapping).toMatchObject({
      status: 409,
      code: "STELLAR_SEQUENCE_CONFLICT",
    });
    expect(mapping?.resultCodes).toEqual(["tx_bad_seq", "tx_insufficient_fee"]);
  });

  it("falls back to PROVIDER_REJECTED for codes it does not know", () => {
    const mapping = mapHorizonError(
      sdkError({ extras: { result_codes: { operations: ["op_spam"] } } })
    );

    expect(mapping).toEqual({
      status: 502,
      code: "PROVIDER_REJECTED",
      message: "Stellar rejected the transaction.",
      hint: "Review the transaction result codes before submitting a corrected transaction.",
      resultCodes: ["op_spam"],
    });
  });

  it("drops non-token values so upstream payloads cannot leak", () => {
    const mapping = mapHorizonError(
      sdkError({
        extras: {
          result_codes: {
            transaction: "tx_failed",
            operations: [
              "op_underfunded",
              "See https://horizon.example.com/?secret=1",
              42,
              { nested: "value" },
            ],
          },
        },
      })
    );

    expect(mapping?.resultCodes).toEqual(["tx_failed", "op_underfunded"]);
    expect(mapping?.message).not.toContain("horizon.example.com");
  });

  it("de-duplicates repeated codes", () => {
    const mapping = mapHorizonError(
      sdkError({
        extras: {
          result_codes: {
            transaction: "tx_failed",
            operations: ["op_underfunded", "op_underfunded"],
          },
        },
      })
    );

    expect(mapping?.resultCodes).toEqual(["tx_failed", "op_underfunded"]);
  });

  it("accepts result codes stashed at the top level of the response body", () => {
    const mapping = mapHorizonError(
      sdkError({ result_codes: { transaction: "tx_too_late" } })
    );

    expect(mapping).toMatchObject({
      status: 422,
      code: "STELLAR_TRANSACTION_EXPIRED",
    });
  });

  it("returns null for errors that are not structured Horizon rejections", () => {
    expect(mapHorizonError(new Error("socket hang up"))).toBeNull();
    expect(mapHorizonError({ response: { status: 503 } })).toBeNull();
    expect(mapHorizonError({ response: { data: {} } })).toBeNull();
    expect(mapHorizonError(null)).toBeNull();
  });

  it("returns null when result_xdr is not valid XDR", () => {
    expect(
      mapHorizonError(sdkError({ extras: { result_xdr: "not-xdr" } }))
    ).toBeNull();
  });

  it("maps operation-level funding and trustline failures", () => {
    const cases: Array<[string, number, string]> = [
      ["op_no_trust", 422, "STELLAR_MISSING_TRUSTLINE"],
      ["op_src_no_trust", 422, "STELLAR_MISSING_TRUSTLINE"],
      ["op_no_destination", 422, "STELLAR_DESTINATION_INVALID"],
      ["op_line_full", 422, "STELLAR_TRUSTLINE_LIMIT"],
      ["op_low_reserve", 422, "STELLAR_INSUFFICIENT_FUNDS"],
    ];

    for (const [code, status, apiCode] of cases) {
      const mapping = mapHorizonError(
        sdkError({ extras: { result_codes: { operations: [code] } } })
      );
      expect(mapping, code).toMatchObject({ status, code: apiCode });
    }
  });
});

/**
 * Issue #1057 — one result-code vocabulary for the whole codebase.
 *
 * The API error mapping, the Horizon retry policy, and the generic retry
 * utility all classify ledger rejections through `horizon-errors`. These tests
 * pin that agreement so the three can never drift into different verdicts for
 * the same code.
 */
describe("centralized Horizon result-code classification (#1057)", () => {
  it("extracts codes from the SDK response body", () => {
    expect(
      extractHorizonResultCodes(
        sdkError({
          extras: {
            result_codes: { transaction: "tx_failed", operations: ["op_no_trust"] },
          },
        })
      )
    ).toEqual(["tx_failed", "op_no_trust"]);
  });

  it("extracts codes from a direct `data` shape and from result_xdr", () => {
    expect(
      extractHorizonResultCodes({
        data: { extras: { result_codes: { transaction: "tx_too_early" } } },
      })
    ).toEqual(["tx_too_early"]);

    expect(
      extractHorizonResultCodes(
        sdkError({
          extras: { result_xdr: resultXdr(xdr.TransactionResultResult.txBadSeq()) },
        })
      )
    ).toEqual(["tx_bad_seq"]);
  });

  it("returns an empty list for errors without ledger result codes", () => {
    expect(extractHorizonResultCodes(new Error("socket hang up"))).toEqual([]);
    expect(extractHorizonResultCodes({ response: { status: 503 } })).toEqual([]);
    expect(extractHorizonResultCodes(null)).toEqual([]);
    expect(extractHorizonResultCodes(sdkError({ extras: {} }))).toEqual([]);
  });

  it("classifies codes that cannot be fixed by resubmitting the same envelope", () => {
    for (const code of [
      "tx_bad_auth",
      "tx_bad_seq",
      "tx_insufficient_fee",
      "tx_too_late",
      "tx_too_early",
      "tx_malformed",
      "tx_not_supported",
      "tx_failed",
      "op_no_destination",
      "op_underfunded",
      "op_no_trust",
      "op_src_not_authorized",
      "op_line_full",
    ]) {
      expect(isPermanentHorizonResultCode(code), code).toBe(true);
    }

    for (const code of [
      "tx_success",
      "tx_insufficient_balance",
      "op_low_reserve",
      "op_spam",
      "not_a_code",
    ]) {
      expect(isPermanentHorizonResultCode(code), code).toBe(false);
    }
  });

  it("makes every retry classifier agree with the shared classification", () => {
    const permanent = sdkError({
      extras: { result_codes: { transaction: "tx_bad_seq" } },
    });
    const transient = sdkError({
      extras: { result_codes: { transaction: "tx_failed", operations: ["op_underfunded"] } },
    });
    // No HTTP status: only the code itself can classify this one.
    const unknownCode = {
      data: { extras: { result_codes: { operations: ["op_spam"] } } },
    };

    expect(classifyHorizonError(permanent)).toBe("permanent");
    expect(isTransientHorizonError(permanent)).toBe(false);

    expect(classifyHorizonError(transient)).toBe("permanent");
    expect(isTransientHorizonError(transient)).toBe(false);

    // An unrecognized code is not a permanent verdict in either classifier.
    expect(classifyHorizonError(unknownCode)).toBe("transient");
    expect(isTransientHorizonError(unknownCode)).toBe(true);
  });

  it("still treats transport failures as retryable in both classifiers", () => {
    const transport = new TransportError("Horizon.submitTransaction", connectionError());

    expect(classifyHorizonError(transport)).toBe("transient");
    expect(isTransientHorizonError(transport)).toBe(true);
  });
});

function connectionError(): Error {
  return new Error("ECONNRESET");
}

describe("enumNameToResultCode", () => {
  it("converts XDR enum member names to Horizon result codes", () => {
    expect(enumNameToResultCode("txBadSeq")).toBe("tx_bad_seq");
    expect(enumNameToResultCode("txTooLate")).toBe("tx_too_late");
    expect(enumNameToResultCode("txInsufficientFee")).toBe(
      "tx_insufficient_fee"
    );
    expect(enumNameToResultCode("txBadMinSeqAgeOrGap")).toBe(
      "tx_bad_min_seq_age_or_gap"
    );
    expect(enumNameToResultCode("opUnderfunded")).toBe("op_underfunded");
    expect(enumNameToResultCode("txSuccess")).toBe("tx_success");
  });
});

describe("toProviderError with Horizon result codes", () => {
  const ctx = {
    provider: "horizon",
    operation: "Horizon.submitTransaction",
    fallbackMessage: "Stellar rejected the transaction",
  };

  it("promotes a mapped rejection onto the ProviderError status, code and details", () => {
    const converted = toProviderError(
      sdkError({ extras: { result_codes: { transaction: "tx_bad_seq" } } }),
      ctx
    );

    expect(converted).toBeInstanceOf(ProviderError);
    const providerError = converted as ProviderError;
    expect(providerError.status).toBe(409);
    expect(providerError.code).toBe("STELLAR_SEQUENCE_CONFLICT");
    expect(providerError.category).toBe("rejected");
    expect(providerError.retryable).toBe(false);
    expect(providerError.detail).toEqual(["tx_bad_seq"]);
    expect(providerError.details).toEqual({
      hint: "Refresh the account and rebuild the transaction before signing again.",
      resultCodes: ["tx_bad_seq"],
    });
    expect(providerError.message).toContain("tx_bad_seq");
  });

  it("does not leak the raw upstream payload into the message", () => {
    const converted = toProviderError(
      sdkError({
        title: "Transaction Failed",
        detail: "secret material in the upstream body",
        extras: { result_codes: { transaction: "tx_bad_auth" } },
      }),
      ctx
    );

    expect(converted.message).not.toContain("upstream body");
    expect(converted.message).not.toContain("Transaction Failed");
  });

  it("does not apply Horizon mappings to another provider", () => {
    const converted = toProviderError(
      sdkError({ extras: { result_codes: { transaction: "tx_bad_seq" } } }),
      {
        provider: "anchor",
        operation: "Anchor.submit",
        fallbackMessage: "Anchor rejected the request",
      }
    );

    expect(converted.status).toBe(502);
    expect(converted.code).toBe("PROVIDER_REJECTED");
  });

  it("keeps a 429 without result codes classified as rate limited", () => {
    const error = {
      response: {
        status: 429,
        headers: { "retry-after": "7" },
        data: { extras: {} },
      },
    };
    const converted = toProviderError(error, ctx) as ProviderError;

    expect(converted.category).toBe("rate_limited");
    expect(converted.status).toBe(503);
    expect(converted.code).toBe("SERVICE_UNAVAILABLE");
    expect(converted.retryAfterSeconds).toBe(7);
  });

  it("unwraps a TransportError to reach the Horizon response", () => {
    const cause = sdkError({
      extras: { result_codes: { operations: ["op_underfunded"] } },
    });
    const transport = new TransportError("Horizon.submitTransaction", cause);

    const converted = toProviderError(transport, ctx) as ProviderError;

    expect(converted).toBeInstanceOf(ProviderError);
    expect(converted.category).toBe("rejected");
    expect(converted.status).toBe(422);
    expect(converted.code).toBe("STELLAR_INSUFFICIENT_FUNDS");
  });
});
