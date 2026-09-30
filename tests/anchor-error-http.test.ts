/**
 * HTTP mapping of the typed SEP-24 anchor errors (issue #524).
 *
 * A test route calls the real `anchorService.getTransaction` against a
 * stubbed fetch, so each case runs the whole chain — anchor response → typed
 * `AnchorError` → central error handler → HTTP response. Every anchor failure
 * is a dependency failure and answers 502 (see src/lib/provider-error.ts);
 * the `code` separates a permanent anchor rejection (`PROVIDER_REJECTED`)
 * from a transient or unusable response (`UPSTREAM_ERROR`).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

vi.mock("../src/db", () => ({
  prisma: {
    user: { findUnique: vi.fn(), upsert: vi.fn() },
    auditLog: { create: vi.fn() },
    $disconnect: vi.fn(),
  },
}));

const fetchMock = vi.fn();

import { buildApp } from "../src/app";
import { anchorService } from "../src/services/anchor";
import { anchorCircuit } from "../src/services/anchor-circuit";

const TRANSFER_SERVER = "https://anchor.example/sep24";
const TOKEN = "secret-sep10-jwt";

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp();
  app.get("/test-anchor/transaction", async () => ({
    transaction: await anchorService.getTransaction({
      transferServer: TRANSFER_SERVER,
      token: TOKEN,
      id: "tx_1",
      timeoutMs: 10,
    }),
  }));
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
});

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  anchorCircuit.reset(`tx:${TRANSFER_SERVER}`);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

async function call() {
  const res = await app.inject({ method: "GET", url: "/test-anchor/transaction" });
  return { status: res.statusCode, body: res.json(), raw: res.body };
}

describe("typed anchor errors → HTTP", () => {
  it.each([
    ["AnchorAuthError (401)", "PROVIDER_REJECTED", "Anchor rejected the SEP-10 token (HTTP 401)", () => json({ error: "expired" }, 401)],
    ["AnchorAuthError (403)", "PROVIDER_REJECTED", "Anchor rejected the SEP-10 token (HTTP 403)", () => json({ error: "forbidden" }, 403)],
    ["AnchorNotFoundError", "PROVIDER_REJECTED", "Anchor has no record of the transaction", () => json({ error: "no such tx" }, 404)],
    ["AnchorUpstreamError (4xx)", "PROVIDER_REJECTED", "Anchor responded with HTTP 400", () => json({}, 400)],
    ["AnchorUpstreamError (5xx)", "UPSTREAM_ERROR", "Anchor responded with HTTP 503", () => json({}, 503)],
    ["AnchorUpstreamError (429)", "UPSTREAM_ERROR", "Anchor responded with HTTP 429", () => json({}, 429)],
    ["AnchorValidationError (non-JSON)", "UPSTREAM_ERROR", "Anchor returned a malformed (non-JSON) response", () => new Response("<html>", { status: 200 })],
    ["AnchorValidationError (schema)", "UPSTREAM_ERROR", "Anchor returned an invalid SEP-24 transaction: transaction.kind", () => json({ transaction: { id: "tx_1", status: "completed" } })],
  ])("maps %s to 502 %s", async (_label, code, message, respond) => {
    fetchMock.mockImplementation(async () => respond());

    const { status, body, raw } = await call();

    expect(status).toBe(502);
    expect(body).toMatchObject({ code, message, error: { code, message } });
    expect(raw).not.toContain(TOKEN);
  });

  it("maps AnchorNetworkError to 502 UPSTREAM_ERROR", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed: ECONNREFUSED 10.0.0.1"));

    const { status, body, raw } = await call();

    expect(status).toBe(502);
    expect(body).toMatchObject({ code: "UPSTREAM_ERROR", message: "Anchor could not be reached" });
    expect(raw).not.toContain("10.0.0.1");
  });

  it("maps AnchorTimeoutError to 502 UPSTREAM_ERROR", async () => {
    fetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
          );
        })
    );

    const { status, body } = await call();

    expect(status).toBe(502);
    expect(body).toMatchObject({ code: "UPSTREAM_ERROR", message: "Anchor did not respond in time" });
  });

  it("returns the typed transaction on success", async () => {
    fetchMock.mockResolvedValue(
      json({ transaction: { id: "tx_1", kind: "withdrawal", status: "completed", amount_in: "5.5" } })
    );

    const { status, body } = await call();

    expect(status).toBe(200);
    expect(body.transaction).toEqual({ id: "tx_1", kind: "withdrawal", status: "completed", amount_in: "5.5" });
  });
});
