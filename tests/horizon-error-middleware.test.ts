import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { errorHandlerPlugin } from "../src/plugins/error-handler";
import { resolveHorizonFailure } from "../src/middleware/horizon-error";

function horizonError(resultCodes: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error("Request failed with status code 400"), {
    response: {
      status: 400,
      data: { extras: { result_codes: resultCodes, envelope_xdr: "SECRETXDR" }, title: "Transaction Failed" },
    },
    ...extra,
  });
}

describe("resolveHorizonFailure (#1083)", () => {
  it("maps ledger result codes to a stable API error", () => {
    const r = resolveHorizonFailure(horizonError({ transaction: "tx_failed", operations: ["op_underfunded"] }));
    expect(r?.status).toBe(422);
    expect(r?.code).toBe("STELLAR_INSUFFICIENT_FUNDS");
    expect(r?.details?.resultCodes).toContain("op_underfunded");
    expect(r?.level).toBe("warn");
  });

  it("maps tx_internal_error to a 5xx logged at error level", () => {
    const r = resolveHorizonFailure(horizonError({ transaction: "tx_internal_error" }));
    expect(r?.status).toBe(502);
    expect(r?.level).toBe("error");
  });

  it("maps network timeouts to 504", () => {
    const r = resolveHorizonFailure(Object.assign(new Error("timeout of 5000ms exceeded"), { code: "ECONNABORTED" }));
    expect(r?.status).toBe(504);
    expect(r?.code).toBe("UPSTREAM_TIMEOUT");
  });

  it("ignores unrelated errors", () => {
    expect(resolveHorizonFailure(new Error("boom"))).toBeNull();
    expect(resolveHorizonFailure(null)).toBeNull();
  });

  it("never exposes envelope XDR or raw messages in response or log fields", () => {
    const r = resolveHorizonFailure(horizonError({ transaction: "tx_bad_auth" }));
    const blob = JSON.stringify(r);
    expect(blob).not.toContain("SECRETXDR");
    expect(blob).not.toContain("Request failed");
  });
});

describe("error handler Horizon integration (#1083)", () => {
  it("answers with the mapped envelope and logs only safe fields", async () => {
    const app = Fastify({ logger: false });
    await app.register(errorHandlerPlugin);
    const logSpy = vi.fn();
    app.addHook("onRequest", async (req) => {
      (req.log as any).warn = logSpy;
      (req.log as any).error = logSpy;
    });
    app.post("/x", async () => {
      throw horizonError({ transaction: "tx_bad_seq" });
    });
    const res = await app.inject({ method: "POST", url: "/x", payload: { signedXdr: "AAAASECRET" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("STELLAR_SEQUENCE_CONFLICT");
    const logged = JSON.stringify(logSpy.mock.calls);
    expect(logged).toContain("tx_bad_seq");
    expect(logged).not.toContain("SECRETXDR");
    expect(logged).not.toContain("AAAASECRET");
    await app.close();
  });
});
