/**
 * Issue #687 — the standard 400 envelope for *every* SEP-24 surface.
 *
 * The issue's third acceptance criterion is not "a schematized endpoint exists"
 * but "requests that fail validation return a standard 400 with clear
 * formatting". The individual rules each surface applies are covered by the
 * per-endpoint suites (tests/sep24-request-validation.test.ts,
 * tests/sep24-callback-validation.test.ts, tests/sep24-transaction-status.test.ts,
 * tests/sep24-transactions-list.test.ts); what this file pins down is the
 * contract a client codes against when *any* SEP-24 request is rejected:
 *
 *   400
 *   { error: { code: "VALIDATION_ERROR", message, timestamp, requestId,
 *              details: [{ field, message, code }],
 *              issues:  [{ path: string[], message, code }] },
 *     code: "VALIDATION_ERROR", message, requestId }   ← legacy mirrors
 *
 * The same envelope must come back from all five surfaces, from both validators
 * (the handler's Zod parse and Fastify's own pre-handler ajv pass on the
 * callback body), and always *before* any anchor I/O or database write — a
 * malformed request must never cost an upstream call or leave a row behind.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import jwt from "jsonwebtoken";
import { Keypair } from "@stellar/stellar-sdk";

const h = vi.hoisted(() => {
  const model = () => ({
    findUnique: vi.fn(async () => null),
    findFirst: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
    create: vi.fn(async () => ({ id: "row_1" })),
    update: vi.fn(),
    updateMany: vi.fn(async () => ({ count: 0 })),
  });
  const prisma: any = {
    anchorSession: model(),
    withdrawal: model(),
    auditLog: model(),
    statusHistory: model(),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $disconnect: vi.fn(),
  };
  return {
    prisma,
    getToml: vi.fn(),
    getChallenge: vi.fn(),
  };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

vi.mock("../src/services/anchor", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/anchor")>();
  return {
    ...actual,
    anchorService: {
      ...actual.anchorService,
      getToml: h.getToml,
      getChallenge: h.getChallenge,
    },
  };
});

import { buildApp } from "../src/app";
import { config } from "../src/config";
import { signToken } from "../src/plugins/auth";

const prisma = h.prisma;
const SIGNING_KEY = "sep24-envelope-signing-key";

let app: Awaited<ReturnType<typeof buildApp>>;

/**
 * A fresh identity per request. `anchorInit` / `anchorPoll` are keyed by the
 * caller's SEP-10 public key, so this keeps every request in its own rate-limit
 * bucket and no test can exhaust another's budget.
 */
function authHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${signToken({
      id: `user_${Keypair.random().publicKey().slice(0, 12)}`,
      stellarPublicKey: Keypair.random().publicKey(),
    })}`,
    "content-type": "application/json",
  };
}

/** Each callback request originates from its own address, for the IP-keyed bucket. */
let clientAddress = 0;
function nextIp(): string {
  clientAddress += 1;
  return `10.9.${Math.floor(clientAddress / 256)}.${(clientAddress % 256) + 1}`;
}

function anchorToken(): string {
  return jwt.sign({ sub: "anchor-tx-1", iss: config.ANCHOR_HOME_DOMAIN }, SIGNING_KEY, {
    algorithm: "HS256",
    expiresIn: "5m",
  });
}

interface InjectResponse {
  statusCode: number;
  json: () => any;
}

/**
 * Assert the one 400 contract every SEP-24 rejection shares, and that the
 * error names each expected field (via `details[].field`, `issues[].path`, or —
 * for an unrecognized key, which Zod reports with an empty path — the key
 * itself in `details[].field`).
 */
function expectStandardValidationEnvelope(res: InjectResponse, ...expectedFields: string[]) {
  expect(res.statusCode).toBe(400);
  const body = res.json();

  // Canonical envelope.
  expect(body.error).toBeDefined();
  expect(body.error.code).toBe("VALIDATION_ERROR");
  expect(body.error.message).toBe(body.message);
  expect(typeof body.error.message).toBe("string");
  expect(body.error.message.length).toBeGreaterThan(0);
  expect(Number.isNaN(Date.parse(body.error.timestamp))).toBe(false);
  expect(typeof body.error.requestId).toBe("string");
  expect(body.error.requestId.length).toBeGreaterThan(0);

  // Legacy top-level mirrors, kept for clients written against the old shape.
  expect(body.code).toBe("VALIDATION_ERROR");
  expect(body.requestId).toBe(body.error.requestId);

  // Both machine-readable views of the same issues.
  expect(Array.isArray(body.error.details)).toBe(true);
  expect(body.error.details.length).toBeGreaterThan(0);
  expect(Array.isArray(body.error.issues)).toBe(true);
  expect(body.error.issues.length).toBeGreaterThan(0);
  for (const detail of body.error.details) {
    expect(typeof detail.message).toBe("string");
    if (detail.field !== undefined) expect(typeof detail.field).toBe("string");
  }
  for (const issue of body.error.issues) {
    expect(Array.isArray(issue.path)).toBe(true);
    expect(typeof issue.message).toBe("string");
    expect(issue.message.length).toBeGreaterThan(0);
  }

  for (const field of expectedFields) {
    const named =
      body.error.details.some((d: any) => d.field === field) ||
      body.error.issues.some((i: any) => i.path.join(".") === field);
    expect(named, `expected the rejection to name "${field}"`).toBe(true);
  }

  return body;
}

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();

  h.getToml.mockResolvedValue({
    homeDomain: config.ANCHOR_HOME_DOMAIN,
    webAuthEndpoint: "https://anchor.test/auth",
    transferServerSep24: "https://anchor.test/sep24",
    signingKey: SIGNING_KEY,
    assets: [],
  });
  h.getChallenge.mockResolvedValue({
    transaction: "AAAA...challengeXDR",
    network_passphrase: "Test SDF Network ; September 2015",
  });
  prisma.anchorSession.create.mockImplementation(async ({ data }: any) => ({
    id: "session_envelope_1",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...data,
  }));
  prisma.$transaction.mockImplementation(async (arg: any) =>
    typeof arg === "function" ? arg(prisma) : Promise.all(arg)
  );
});

describe("POST /api/sep24/deposit — standard rejection envelope", () => {
  function deposit(payload: unknown) {
    return app.inject({
      method: "POST",
      url: "/api/sep24/deposit",
      headers: authHeaders(),
      payload: payload as any,
    });
  }

  it("rejects a body missing assetCode with the envelope, before touching the anchor", async () => {
    const body = expectStandardValidationEnvelope(await deposit({}), "assetCode");

    expect(body.error.message).toContain("assetCode");
    expect(h.getToml).not.toHaveBeenCalled();
    expect(h.getChallenge).not.toHaveBeenCalled();
    expect(prisma.anchorSession.create).not.toHaveBeenCalled();
  });

  it("rejects a negative amount with the envelope, naming amount", async () => {
    expectStandardValidationEnvelope(
      await deposit({ assetCode: "USDC", amount: "-10.5" }),
      "amount"
    );
    expect(h.getToml).not.toHaveBeenCalled();
  });

  it("rejects an ill-formed Stellar account, naming account", async () => {
    expectStandardValidationEnvelope(
      await deposit({ assetCode: "USDC", account: "NOT_A_STELLAR_KEY" }),
      "account"
    );
    expect(h.getToml).not.toHaveBeenCalled();
  });

  it("rejects an unknown field by name rather than silently dropping it", async () => {
    const body = expectStandardValidationEnvelope(
      await deposit({ assetCode: "USDC", unrecognisedKey: "value" }),
      "unrecognisedKey"
    );

    expect(
      body.error.details.some((d: any) => d.code === "unrecognized_keys")
    ).toBe(true);
    expect(h.getToml).not.toHaveBeenCalled();
  });
});

describe("POST /api/sep24/withdraw — standard rejection envelope", () => {
  function withdraw(payload: unknown) {
    return app.inject({
      method: "POST",
      url: "/api/sep24/withdraw",
      headers: authHeaders(),
      payload: payload as any,
    });
  }

  it("rejects a body missing the required amount, naming amount", async () => {
    expectStandardValidationEnvelope(await withdraw({ assetCode: "XLM" }), "amount");
    expect(h.getToml).not.toHaveBeenCalled();
  });

  it("rejects a zero amount, naming amount", async () => {
    expectStandardValidationEnvelope(
      await withdraw({ assetCode: "XLM", amount: "0" }),
      "amount"
    );
    expect(h.getToml).not.toHaveBeenCalled();
  });

  it("rejects an issuer on the native asset, naming assetIssuer", async () => {
    expectStandardValidationEnvelope(
      await withdraw({
        assetCode: "XLM",
        amount: "5",
        assetIssuer: Keypair.random().publicKey(),
      }),
      "assetIssuer"
    );
  });

  it("rejects a memo without its memoType, naming memoType", async () => {
    expectStandardValidationEnvelope(
      await withdraw({ assetCode: "USDC", amount: "5", memo: "hello" }),
      "memoType"
    );
  });

  it("rejects an unexpected query parameter, naming it", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sep24/withdraw?asset_code=XLM",
      headers: authHeaders(),
      payload: { assetCode: "XLM", amount: "5" },
    });

    expectStandardValidationEnvelope(res, "asset_code");
    expect(h.getToml).not.toHaveBeenCalled();
  });
});

describe("GET /api/sep24/transaction — standard rejection envelope", () => {
  function poll(url: string) {
    return app.inject({ method: "GET", url, headers: authHeaders() });
  }

  it("rejects a missing id, naming id", async () => {
    expectStandardValidationEnvelope(
      await poll("/api/sep24/transaction"),
      "id"
    );
    expect(prisma.anchorSession.findFirst).not.toHaveBeenCalled();
  });

  it("rejects an empty id, naming id", async () => {
    expectStandardValidationEnvelope(
      await poll("/api/sep24/transaction?id="),
      "id"
    );
  });

  it("rejects an id carrying whitespace, naming id", async () => {
    expectStandardValidationEnvelope(
      await poll("/api/sep24/transaction?id=has%20space"),
      "id"
    );
    expect(prisma.anchorSession.findFirst).not.toHaveBeenCalled();
  });

  it("rejects an unknown query parameter by name", async () => {
    expectStandardValidationEnvelope(
      await poll("/api/sep24/transaction?id=tx_1&page=2"),
      "page"
    );
  });

  it("rejects a lang outside the accepted length, naming lang", async () => {
    expectStandardValidationEnvelope(
      await poll("/api/sep24/transaction?id=tx_1&lang=x"),
      "lang"
    );
  });
});

describe("GET /api/sep24/transactions — standard rejection envelope", () => {
  function list(query: string) {
    return app.inject({
      method: "GET",
      url: `/api/sep24/transactions?${query}`,
      headers: authHeaders(),
    });
  }

  it("rejects limit=0, naming limit", async () => {
    expectStandardValidationEnvelope(await list("limit=0"), "limit");
    expect(prisma.anchorSession.findMany).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric limit, naming limit", async () => {
    expectStandardValidationEnvelope(await list("limit=abc"), "limit");
  });

  it("rejects limit above the page-size ceiling, naming limit", async () => {
    expectStandardValidationEnvelope(await list("limit=101"), "limit");
  });

  it("rejects an unknown kind, naming kind", async () => {
    expectStandardValidationEnvelope(await list("kind=transfer"), "kind");
  });

  it("rejects an unknown pagination parameter by name", async () => {
    expectStandardValidationEnvelope(await list("page=3"), "page");
  });

  it("rejects an unknown order, naming order", async () => {
    expectStandardValidationEnvelope(await list("order=sideways"), "order");
  });
});

describe("POST /api/sep24/callback — standard rejection envelope", () => {
  function callback(payload: unknown, url = "/api/sep24/callback") {
    return app.inject({
      method: "POST",
      url,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${anchorToken()}`,
      },
      payload: payload as any,
      remoteAddress: nextIp(),
    });
  }

  it("rejects an empty body with the envelope, before any database read", async () => {
    const body = expectStandardValidationEnvelope(await callback({}));

    expect(body.error.message).toMatch(/transaction id and status/i);
    expect(prisma.anchorSession.findMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects a non-string id at the ajv boundary in the same envelope", async () => {
    expectStandardValidationEnvelope(
      await callback({ id: { nested: true }, status: "completed" }),
      "id"
    );
    expect(prisma.anchorSession.findMany).not.toHaveBeenCalled();
  });

  it("rejects an empty id, naming id", async () => {
    expectStandardValidationEnvelope(
      await callback({ id: "", status: "completed" }),
      "id"
    );
    expect(prisma.anchorSession.findMany).not.toHaveBeenCalled();
  });

  it("rejects a callback missing only the status, naming the transaction pair", async () => {
    const body = expectStandardValidationEnvelope(await callback({ id: "anchor_tx_1" }));

    expect(body.error.message).toMatch(/transaction id and status/i);
    expect(prisma.anchorSession.findMany).not.toHaveBeenCalled();
  });

  it("rejects an unknown query parameter by name", async () => {
    expectStandardValidationEnvelope(
      await callback(
        { id: "anchor_tx_1", status: "completed" },
        "/api/sep24/callback?anchor_extra=1"
      ),
      "anchor_extra"
    );
    expect(prisma.anchorSession.findMany).not.toHaveBeenCalled();
  });
});

describe("control — valid SEP-24 requests are not caught in the 400 envelope", () => {
  it("starts a deposit with 200 when the payload is valid", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sep24/deposit",
      headers: authHeaders(),
      payload: { assetCode: "USDC", amount: "100.5" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().session).toBeDefined();
    expect(res.json().challenge).toBeDefined();
  });

  it("answers a valid status poll with the domain error (404), not a 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/sep24/transaction?id=tx_unknown",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("accepts a well-formed callback with 200", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sep24/callback",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${anchorToken()}`,
      },
      payload: { id: "anchor_tx_1", status: "completed" },
      remoteAddress: nextIp(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true, status: "completed" });
  });
});
