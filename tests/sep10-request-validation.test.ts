/**
 * Issue #503 — strict Zod request validation on the SEP-10 endpoints.
 *
 * Every malformed `/auth/challenge` and `/auth/verify` request must be
 * rejected with 400 VALIDATION_ERROR *before* business logic runs: no
 * challenge is built, no XDR is decoded or verified, no user is upserted,
 * and no audit row is written. Valid requests must still succeed.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Keypair, Transaction } from "@stellar/stellar-sdk";

const h = vi.hoisted(() => {
  const consumed = new Set<string>();
  const prisma: any = {
    user: { upsert: vi.fn(), findUnique: vi.fn() },
    auditLog: { create: vi.fn(async () => ({})) },
    refreshToken: { create: vi.fn(async () => ({})) },
    $executeRaw: vi.fn(async (sql: { strings: string[]; values: unknown[] }) => {
      const text = sql.strings.join("?");
      if (text.includes("INSERT INTO")) {
        const [fingerprint] = sql.values as [string];
        if (consumed.has(fingerprint)) return 0;
        consumed.add(fingerprint);
        return 1;
      }
      return 0;
    }),
    $queryRawUnsafe: vi.fn(async () => [{ "?column?": 1 }]),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $disconnect: vi.fn(),
  };
  return { prisma, consumed };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

vi.mock("../src/services/stellar", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/stellar")>();
  return {
    ...actual,
    stellar: {
      ...actual.stellar,
      loadAccount: vi.fn(async () => ({
        exists: false,
        sequence: "0",
        balances: [],
        signers: [],
        thresholds: { low: 0, med: 0, high: 0 },
      })),
    },
  };
});

// Spy on the business-logic entry points while keeping their real behaviour,
// so each test can prove whether validation stopped the request first.
vi.mock("../src/services/sep10", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/sep10")>();
  return {
    ...actual,
    buildChallenge: vi.fn(actual.buildChallenge),
    verifyChallenge: vi.fn(actual.verifyChallenge),
  };
});

vi.mock("../src/services/refresh-token", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/refresh-token")>();
  return {
    ...actual,
    issueRefreshToken: vi.fn(async () => ({
      token: "refresh-token",
      expiresAt: new Date("2026-12-31T00:00:00.000Z"),
    })),
  };
});

import { buildApp } from "../src/app";
import { buildChallenge, verifyChallenge } from "../src/services/sep10";
import { config } from "../src/config";

const realSep10 = await vi.importActual<typeof import("../src/services/sep10")>(
  "../src/services/sep10"
);

let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  h.consumed.clear();
  h.prisma.auditLog.create.mockImplementation(async () => ({}));
  if (!app) app = await buildApp();
});

// The auth routes are rate limited per client IP. Each request gets its own
// address so this suite exercises validation, not the limiter.
let ipCounter = 0;
function inject(opts: Parameters<typeof app.inject>[0] & object) {
  ipCounter += 1;
  return app.inject({
    ...(opts as object),
    remoteAddress: `10.50.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`,
  } as Parameters<typeof app.inject>[0]);
}

function signedChallenge(client: Keypair): string {
  const { transaction } = realSep10.buildChallenge(client.publicKey());
  const tx = new Transaction(transaction, config.networkPassphrase);
  tx.sign(client);
  return tx.toXDR();
}

function expectValidationError(
  res: { statusCode: number; json: () => any },
  field?: string
): void {
  expect(res.statusCode).toBe(400);
  const body = res.json();
  expect(body.code ?? body.error?.code).toBe("VALIDATION_ERROR");
  if (field) {
    const details: Array<{ field: string }> = body.error?.details ?? body.details ?? [];
    expect(details.map((d) => d.field)).toContain(field);
  }
}

describe("POST /auth/challenge validation", () => {
  it("returns a challenge for a valid account", async () => {
    const client = Keypair.random();
    const res = await inject({
      method: "POST",
      url: "/auth/challenge",
      payload: { account: client.publicKey() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().transaction).toBeTruthy();
    expect(buildChallenge).toHaveBeenCalledWith(client.publicKey());
  });

  it.each([
    ["missing account", {}],
    ["null account", { account: null }],
    ["numeric account", { account: 42 }],
    ["empty account", { account: "" }],
    ["malformed account", { account: "not-a-key" }],
    ["secret seed", { account: Keypair.random().secret() }],
    ["oversized account", { account: "G".repeat(5_000) }],
  ])("rejects %s with 400 before building a challenge", async (_label, payload) => {
    const res = await inject({ method: "POST", url: "/auth/challenge", payload });
    expectValidationError(res, "account");
    expect(buildChallenge).not.toHaveBeenCalled();
  });

  it("rejects an unknown body field", async () => {
    const res = await inject({
      method: "POST",
      url: "/auth/challenge",
      payload: { account: Keypair.random().publicKey(), role: "admin" },
    });
    expectValidationError(res);
    expect(buildChallenge).not.toHaveBeenCalled();
  });

  it("rejects an array body", async () => {
    const res = await inject({
      method: "POST",
      url: "/auth/challenge",
      payload: [Keypair.random().publicKey()],
    });
    expectValidationError(res);
    expect(buildChallenge).not.toHaveBeenCalled();
  });

  it("rejects a request with no body", async () => {
    const res = await inject({ method: "POST", url: "/auth/challenge" });
    expectValidationError(res);
    expect(buildChallenge).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const res = await inject({
      method: "POST",
      url: "/auth/challenge",
      headers: { "content-type": "application/json" },
      payload: '{"account": ',
    });
    expectValidationError(res);
    expect(buildChallenge).not.toHaveBeenCalled();
  });

  it("rejects the account passed as a query parameter (SEP-10 GET habit)", async () => {
    const account = Keypair.random().publicKey();
    const res = await inject({
      method: "POST",
      url: `/auth/challenge?account=${account}`,
      payload: { account },
    });
    expectValidationError(res);
    expect(buildChallenge).not.toHaveBeenCalled();
  });
});

describe("POST /auth/verify validation", () => {
  it("issues a token for a valid signed challenge", async () => {
    const client = Keypair.random();
    h.prisma.user.upsert.mockResolvedValueOnce({
      id: "user_1",
      stellarPublicKey: client.publicKey(),
      displayName: "Tester",
      avatarUrl: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const res = await inject({
      method: "POST",
      url: "/auth/verify",
      payload: { transaction: signedChallenge(client) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBeTruthy();
  });

  it("accepts the optional SEP-10 domain fields", async () => {
    const client = Keypair.random();
    h.prisma.user.upsert.mockResolvedValueOnce({
      id: "user_2",
      stellarPublicKey: client.publicKey(),
      displayName: "Tester",
      avatarUrl: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const res = await inject({
      method: "POST",
      url: "/auth/verify",
      payload: {
        transaction: signedChallenge(client),
        home_domain: "anchor.example.com",
        client_domain: "wallet.example.com",
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it.each([
    ["missing transaction", {}, "transaction"],
    ["null transaction", { transaction: null }, "transaction"],
    ["numeric transaction", { transaction: 7 }, "transaction"],
    ["empty transaction", { transaction: "" }, "transaction"],
    ["non-base64 transaction", { transaction: "not-xdr!" }, "transaction"],
    ["non-canonical base64", { transaction: "AB==" }, "transaction"],
    ["oversized transaction", { transaction: "A".repeat(50_004) }, "transaction"],
    ["invalid client_domain", { transaction: "AAAA", client_domain: "exam_ple.com" }, "client_domain"],
    ["invalid home_domain", { transaction: "AAAA", home_domain: "-anchor.example.com" }, "home_domain"],
  ])("rejects %s with 400 before verification", async (_label, payload, field) => {
    const res = await inject({ method: "POST", url: "/auth/verify", payload });
    expectValidationError(res, field);
    expect(verifyChallenge).not.toHaveBeenCalled();
    expect(h.prisma.user.upsert).not.toHaveBeenCalled();
    expect(h.prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects an unknown body field before consuming the challenge", async () => {
    const client = Keypair.random();
    const transaction = signedChallenge(client);
    const res = await inject({
      method: "POST",
      url: "/auth/verify",
      payload: { transaction, account: client.publicKey() },
    });
    expectValidationError(res);
    expect(verifyChallenge).not.toHaveBeenCalled();
    // The challenge was not burned by the rejected request, so a corrected
    // retry with the same signed envelope still succeeds.
    expect(h.consumed.size).toBe(0);
  });

  it("rejects a query parameter", async () => {
    const res = await inject({
      method: "POST",
      url: "/auth/verify?transaction=AAAA",
      payload: { transaction: "AAAA" },
    });
    expectValidationError(res);
    expect(verifyChallenge).not.toHaveBeenCalled();
  });

  it("rejects a request with no body", async () => {
    const res = await inject({ method: "POST", url: "/auth/verify" });
    expectValidationError(res);
    expect(verifyChallenge).not.toHaveBeenCalled();
  });
});
