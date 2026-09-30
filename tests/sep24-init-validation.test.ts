/**
 * Issue #543 — Zod request validation for the SEP-24 deposit and withdrawal
 * initiation endpoints.
 *
 * The schemas live in src/validations/sep24.ts (re-exported from
 * src/schemas/sep24.ts) and are applied in the handlers of
 * src/routes/anchors.ts (`/anchors/deposit`, `/anchors/withdraw`) and
 * src/routes/sep24.ts (`/api/sep24/deposit`, `/api/sep24/withdraw`). Both
 * route pairs document the same contract through `openApiBody(..., {
 * enforce: false })`, which keeps the Zod parse the only thing that can reject
 * a request, so every rejection below is the same VALIDATION_ERROR envelope
 * with `details` and `issues` — never a second, ajv-worded validator.
 *
 * Covered here:
 *  1. valid deposit/withdraw starts pass through to the anchor flow
 *  2. unsupported asset codes and issuer mismatches are rejected with 400
 *  3. malformed Stellar public keys are rejected with 400
 *  4. memo/memoType pairing and memo-type rules are enforced
 *  5. unknown body and query keys are rejected with 400 before any anchor I/O
 *  6. a valid `lang` query parameter is still accepted
 *  7. the documented OpenAPI body keeps its fields and loses only the rules
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(),
    findUnique: vi.fn(async () => null),
    findFirst: vi.fn(),
    findMany: vi.fn(async () => []),
    update: vi.fn(),
    updateMany: vi.fn(async () => ({ count: 1 })),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(async () => 0),
    upsert: vi.fn(),
  });
  const prisma: any = {
    user: model(),
    group: model(),
    groupMember: model(),
    expense: model(),
    expenseShare: model(),
    settlement: model(),
    treasuryTransaction: model(),
    treasuryProposal: model(),
    invite: model(),
    invitation: model(),
    anchorSession: model(),
    auditLog: model(),
    idempotencyKey: model(),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $disconnect: vi.fn(),
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));
vi.mock("../src/services/anchor", () => ({
  anchorService: {
    getToml: vi.fn(),
    getChallenge: vi.fn(),
    getToken: vi.fn(),
    startInteractive: vi.fn(),
  },
}));

import { buildApp } from "../src/app";
import { config } from "../src/config";
import { signToken } from "../src/plugins/auth";
import { anchorService } from "../src/services/anchor";
import { sep24InitQuerySchema, sep24WithdrawRequestSchema } from "../src/validations/sep24";
import { openApiBody } from "../src/lib/openapi";

const prisma = h.prisma;
let app: Awaited<ReturnType<typeof buildApp>>;

let userSeq = 0;

const userKey = Keypair.random().publicKey();
const otherKey = Keypair.random().publicKey();

/** A full-length key whose final character breaks the ed25519 checksum. */
function checksumBrokenKey(): string {
  const key = Keypair.random().publicKey();
  const last = key.slice(-1);
  return key.slice(0, -1) + (last === "A" ? "B" : "A");
}

const brokenKey = checksumBrokenKey();

/**
 * Every request authenticates as a distinct user — a fresh id *and* a fresh
 * Stellar public key — because the anchor-init budget is keyed by the key
 * itself (src/services/rate-limit-keys.ts), so a shared key would let one test
 * spend the next test's quota and answer 429 where a 400 is expected.
 */
const authHeader = () => ({
  authorization: `Bearer ${signToken({
    id: `user_${(userSeq += 1)}`,
    stellarPublicKey: Keypair.random().publicKey(),
  })}`,
  "content-type": "application/json",
});

const createdSession = (kind: string, over: Record<string, any> = {}) => ({
  id: `session_${kind}_${Math.random().toString(16).slice(2, 8)}`,
  userId: "user_1",
  anchorName: config.ANCHOR_NAME,
  kind,
  assetCode: "XLM",
  interactiveUrl: null,
  externalTransactionId: null,
  status: "incomplete",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();

  vi.mocked(anchorService.getToml).mockResolvedValue({
    homeDomain: config.ANCHOR_HOME_DOMAIN,
    webAuthEndpoint: "https://testanchor.stellar.org/auth",
    transferServerSep24: "https://testanchor.stellar.org/sep24",
    signingKey: userKey,
    assets: [],
  } as any);
  vi.mocked(anchorService.getChallenge).mockResolvedValue({
    transaction: "challenge-xdr",
  } as any);
  prisma.anchorSession.create.mockImplementation(
    async ({ data }: any) => createdSession(data.kind, data)
  );
  prisma.auditLog.create.mockResolvedValue({ id: "audit_1" });
});

/** POST a body (and optional query string) to a SEP-24 initiation route. */
function post(path: string, payload: unknown, query = "") {
  return app.inject({
    method: "POST",
    url: `${path}${query}`,
    headers: authHeader(),
    payload: payload as any,
  });
}

/** The four initiation routes: two aliases for deposit, two for withdrawal. */
const DEPOSIT_ROUTES = ["/anchors/deposit", "/api/sep24/deposit"] as const;
const WITHDRAW_ROUTES = ["/anchors/withdraw", "/api/sep24/withdraw"] as const;

/**
 * Assert the standardized validation envelope: a 400 whose body carries the
 * VALIDATION_ERROR code, per-field `details`, and the Zod `issues` array.
 */
function expectValidation400(res: { statusCode: number; json: () => any }) {
  const body = res.json();
  expect(res.statusCode).toBe(400);
  expect(body.code).toBe("VALIDATION_ERROR");
  expect(body.error.code).toBe("VALIDATION_ERROR");
  expect(typeof body.message).toBe("string");
  expect(body.error.details.length).toBeGreaterThan(0);
  expect(body.error.details[0].field).toBeTruthy();
  expect(body.error.issues.length).toBeGreaterThan(0);
  return body;
}

/** Assert nothing upstream or persistent was touched for a rejected request. */
function expectNoSideEffects() {
  expect(anchorService.getToml).not.toHaveBeenCalled();
  expect(anchorService.getChallenge).not.toHaveBeenCalled();
  expect(anchorService.startInteractive).not.toHaveBeenCalled();
  expect(prisma.anchorSession.create).not.toHaveBeenCalled();
  expect(prisma.auditLog.create).not.toHaveBeenCalled();
}

describe("SEP-24 initiation — valid requests", () => {
  it.each(DEPOSIT_ROUTES)("POST %s accepts a fully-specified deposit", async (path) => {
    const res = await post(path, {
      assetCode: "usdc",
      assetIssuer: config.STABLE_ASSET_ISSUER,
      amount: "5.25",
      account: userKey,
      memo: "invoice 42",
      memoType: "text",
      walletName: "Mergepay Wallet",
      extraMetadata: { source: "mobile" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().session.kind).toBe("deposit");
    // Asset codes are normalised to upper case before they are stored.
    expect(res.json().session.assetCode).toBe("USDC");
    expect(anchorService.getChallenge).toHaveBeenCalled();
  });

  it.each(DEPOSIT_ROUTES)("POST %s accepts a minimal deposit", async (path) => {
    const res = await post(path, { assetCode: "XLM" });

    expect(res.statusCode).toBe(200);
    expect(res.json().challenge).toEqual({ transaction: "challenge-xdr" });
  });

  it.each(WITHDRAW_ROUTES)("POST %s accepts a valid withdrawal", async (path) => {
    const res = await post(path, {
      assetCode: "XLM",
      amount: "10.00",
      to: userKey,
      refundAddress: otherKey,
      refundMemo: "refund-7",
      refundMemoType: "text",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().session.kind).toBe("withdrawal");
    expect(prisma.anchorSession.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ kind: "withdrawal" }) })
    );
  });

  it("accepts an issued asset with no issuer (the configured one is implied)", async () => {
    const res = await post("/api/sep24/deposit", { assetCode: "USDC" });

    expect(res.statusCode).toBe(200);
  });
});

describe("SEP-24 initiation — asset rules", () => {
  it.each(DEPOSIT_ROUTES)("POST %s rejects an unsupported asset code with 400", async (path) => {
    const res = await post(path, { assetCode: "ZZZ" });

    expect(res.statusCode).toBe(400);
    expectNoSideEffects();
  });

  it.each(DEPOSIT_ROUTES)(
    "POST %s rejects an asset issuer that is not a Stellar public key",
    async (path) => {
      const res = await post(path, { assetCode: "USDC", assetIssuer: "not-a-stellar-key" });

      const body = expectValidation400(res);
      expect(body.error.details[0].field).toBe("assetIssuer");
      expectNoSideEffects();
    }
  );

  it.each(DEPOSIT_ROUTES)(
    "POST %s rejects a checksum-broken issuer key",
    async (path) => {
      const res = await post(path, { assetCode: "USDC", assetIssuer: brokenKey });

      expectValidation400(res);
      expectNoSideEffects();
    }
  );

  it.each(DEPOSIT_ROUTES)(
    "POST %s rejects an issuer Mergepay does not issue that asset under",
    async (path) => {
      // A perfectly valid public key, just not this asset's issuer. Accepting
      // it would create the session against the configured issuer instead of
      // the one the caller asked for.
      const res = await post(path, { assetCode: "USDC", assetIssuer: otherKey });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/issuer mismatch/i);
      expectNoSideEffects();
    }
  );

  it.each(DEPOSIT_ROUTES)("POST %s rejects an issuer on the native asset", async (path) => {
    const res = await post(path, { assetCode: "XLM", assetIssuer: userKey });

    expectValidation400(res);
    expectNoSideEffects();
  });

  it.each(DEPOSIT_ROUTES)("POST %s rejects an asset code that is not alphanumeric", async (path) => {
    const res = await post(path, { assetCode: "US-D" });

    const body = expectValidation400(res);
    // The message comes from the Zod schema, not from ajv: only the handler's
    // parse may reject this request, and its wording is the documented one.
    expect(body.error.details[0].field).toBe("assetCode");
    expect(body.error.details[0].message).toMatch(/letters and digits/i);
    expect(body.error.issues[0].path).toEqual(["assetCode"]);
    expectNoSideEffects();
  });

  it.each(DEPOSIT_ROUTES)("POST %s rejects a missing asset code", async (path) => {
    const res = await post(path, { amount: "5" });

    const body = expectValidation400(res);
    expect(body.error.details.map((d: any) => d.field)).toContain("assetCode");
    expectNoSideEffects();
  });
});

describe("SEP-24 initiation — Stellar account rules", () => {
  it.each(DEPOSIT_ROUTES)("POST %s rejects a malformed account", async (path) => {
    const res = await post(path, { assetCode: "XLM", account: "GCV7D6Z5MJS" });

    const body = expectValidation400(res);
    expect(body.error.details[0].field).toBe("account");
    expectNoSideEffects();
  });

  it.each(WITHDRAW_ROUTES)("POST %s rejects a malformed destination", async (path) => {
    const res = await post(path, { assetCode: "XLM", amount: "5", to: "not-a-stellar-account" });

    const body = expectValidation400(res);
    expect(body.error.details[0].field).toBe("to");
    expectNoSideEffects();
  });

  it.each(DEPOSIT_ROUTES)("POST %s rejects a secret seed in place of an account", async (path) => {
    const res = await post(path, { assetCode: "XLM", account: Keypair.random().secret() });

    expectValidation400(res);
    expectNoSideEffects();
  });

  it.each(DEPOSIT_ROUTES)("POST %s rejects a malformed refund address", async (path) => {
    const res = await post(path, { assetCode: "XLM", refundAddress: "G" });

    const body = expectValidation400(res);
    expect(body.error.details[0].field).toBe("refundAddress");
    expectNoSideEffects();
  });
});

describe("SEP-24 initiation — amount rules", () => {
  it.each(WITHDRAW_ROUTES)("POST %s requires an amount for a withdrawal", async (path) => {
    const res = await post(path, { assetCode: "XLM" });

    const body = expectValidation400(res);
    expect(body.error.details[0].field).toBe("amount");
    expectNoSideEffects();
  });

  it.each(WITHDRAW_ROUTES)("POST %s rejects a non-positive amount", async (path) => {
    const res = await post(path, { assetCode: "XLM", amount: "0" });

    const body = expectValidation400(res);
    expect(body.error.details[0].field).toBe("amount");
    expectNoSideEffects();
  });

  it.each(WITHDRAW_ROUTES)("POST %s rejects excess decimal precision", async (path) => {
    const res = await post(path, { assetCode: "XLM", amount: "1.00000008" });

    expectValidation400(res);
    expectNoSideEffects();
  });

  it.each(WITHDRAW_ROUTES)("POST %s rejects a numeric amount without coercing it", async (path) => {
    const res = await post(path, { assetCode: "XLM", amount: 5 });

    const body = expectValidation400(res);
    expect(body.error.details[0].field).toBe("amount");
    expectNoSideEffects();
  });

  it.each(WITHDRAW_ROUTES)("POST %s rejects exponent notation", async (path) => {
    const res = await post(path, { assetCode: "XLM", amount: "1e3" });

    expectValidation400(res);
    expectNoSideEffects();
  });
});

describe("SEP-24 initiation — memo rules", () => {
  it.each(DEPOSIT_ROUTES)("POST %s requires memoType alongside memo", async (path) => {
    const res = await post(path, { assetCode: "XLM", memo: "TAG" });

    const body = expectValidation400(res);
    expect(body.error.details[0].field).toBe("memoType");
    expectNoSideEffects();
  });

  it.each(DEPOSIT_ROUTES)("POST %s requires memo alongside memoType", async (path) => {
    const res = await post(path, { assetCode: "XLM", memoType: "text" });

    const body = expectValidation400(res);
    expect(body.error.details[0].field).toBe("memo");
    expectNoSideEffects();
  });

  it.each(DEPOSIT_ROUTES)("POST %s rejects an unsupported memo type", async (path) => {
    const res = await post(path, { assetCode: "XLM", memo: "TAG", memoType: "binary" });

    const body = expectValidation400(res);
    expect(body.error.details[0].field).toBe("memoType");
    expectNoSideEffects();
  });

  it.each(DEPOSIT_ROUTES)("POST %s rejects an id memo that is not an unsigned integer", async (path) => {
    const res = await post(path, { assetCode: "XLM", memo: "12.5", memoType: "id" });

    const body = expectValidation400(res);
    expect(body.error.details[0].field).toBe("memo");
    expectNoSideEffects();
  });

  it.each(DEPOSIT_ROUTES)("POST %s rejects a text memo over 28 UTF-8 bytes", async (path) => {
    const res = await post(path, { assetCode: "XLM", memo: "a".repeat(29), memoType: "text" });

    const body = expectValidation400(res);
    expect(body.error.details[0].field).toBe("memo");
    expectNoSideEffects();
  });

  it("accepts a base64-encoded 32-byte hash memo", async () => {
    const memo = Buffer.alloc(32, 7).toString("base64");
    const res = await post("/api/sep24/deposit", { assetCode: "XLM", memo, memoType: "hash" });

    expect(res.statusCode).toBe(200);
  });

  it.each(DEPOSIT_ROUTES)("POST %s rejects a refundMemo without its type", async (path) => {
    const res = await post(path, { assetCode: "XLM", refundMemo: "refund 7" });

    const body = expectValidation400(res);
    expect(body.error.details[0].field).toBe("refundMemoType");
    expectNoSideEffects();
  });
});

describe("SEP-24 initiation — strict payloads", () => {
  it.each(DEPOSIT_ROUTES)("POST %s rejects an unknown body field", async (path) => {
    const res = await post(path, { assetCode: "XLM", unexpected: true });

    const body = expectValidation400(res);
    expect(body.error.details[0].field).toBe("unexpected");
    expect(body.error.issues.some((i: any) => i.code === "unrecognized_keys")).toBe(true);
    expectNoSideEffects();
  });

  it.each(DEPOSIT_ROUTES)(
    "POST %s rejects the SEP-24 wire spelling of a body field",
    async (path) => {
      // The contract is camelCase in the body; `asset_code` belongs nowhere,
      // and silently ignoring it would start a session for a different asset.
      const res = await post(path, { asset_code: "XLM" });

      const body = expectValidation400(res);
      expect(body.error.details.map((d: any) => d.field)).toContain("asset_code");
      expectNoSideEffects();
    }
  );

  it.each(DEPOSIT_ROUTES)("POST %s rejects a non-object body", async (path) => {
    const res = await post(path, ["XLM"]);

    expect(res.statusCode).toBe(400);
    expectNoSideEffects();
  });

  it.each(DEPOSIT_ROUTES)("POST %s rejects an oversized extraMetadata payload", async (path) => {
    const res = await post(path, {
      assetCode: "XLM",
      extraMetadata: { blob: "x".repeat(4096) },
    });

    const body = expectValidation400(res);
    expect(body.error.details[0].field).toBe("extraMetadata");
    expectNoSideEffects();
  });
});

describe("SEP-24 initiation — query parameters", () => {
  it.each(DEPOSIT_ROUTES)("POST %s accepts a valid lang parameter", async (path) => {
    const res = await post(path, { assetCode: "XLM" }, "?lang=en");

    expect(res.statusCode).toBe(200);
  });

  it.each(DEPOSIT_ROUTES)("POST %s rejects an unknown query parameter", async (path) => {
    const res = await post(path, { assetCode: "XLM" }, "?foo=bar");

    const body = expectValidation400(res);
    expect(body.error.details[0].field).toBe("foo");
    expectNoSideEffects();
  });

  it.each(DEPOSIT_ROUTES)(
    "POST %s rejects query parameters that contradict the body",
    async (path) => {
      const res = await post(path, { assetCode: "XLM" }, "?asset_code=USDC&memo_type=text");

      const body = expectValidation400(res);
      // Zod reports every unknown key in one issue, naming each of them.
      expect(body.error.details.map((d: any) => d.field)).toContain("asset_code");
      expect(body.message).toMatch(/memo_type/);
      expectNoSideEffects();
    }
  );

  it.each(DEPOSIT_ROUTES)("POST %s rejects a malformed lang parameter", async (path) => {
    const res = await post(path, { assetCode: "XLM" }, "?lang=e");

    const body = expectValidation400(res);
    expect(body.error.details[0].field).toBe("lang");
    expectNoSideEffects();
  });
});

describe("sep24InitQuerySchema", () => {
  it("accepts no parameters at all", () => {
    expect(sep24InitQuerySchema.parse({})).toEqual({});
  });

  it("accepts a bounded lang parameter", () => {
    expect(sep24InitQuerySchema.parse({ lang: "en" })).toEqual({ lang: "en" });
    expect(sep24InitQuerySchema.parse({ lang: "pt-BR" })).toEqual({ lang: "pt-BR" });
  });

  it("rejects a lang that is too short or too long", () => {
    expect(sep24InitQuerySchema.safeParse({ lang: "e" }).success).toBe(false);
    expect(sep24InitQuerySchema.safeParse({ lang: "x".repeat(11) }).success).toBe(false);
  });

  it("rejects any other key, including an array or object value", () => {
    expect(sep24InitQuerySchema.safeParse({ asset_code: "XLM" }).success).toBe(false);
    expect(sep24InitQuerySchema.safeParse({ foo: ["a"] }).success).toBe(false);
    expect(sep24InitQuerySchema.safeParse({ foo: { bar: 1 } }).success).toBe(false);
    expect(sep24InitQuerySchema.safeParse({ lang: ["en"] }).success).toBe(false);
  });
});

describe("SEP-24 initiation — OpenAPI annotations", () => {
  /** Every JSON Schema keyword present in a tree, however deeply nested. */
  function keywords(node: unknown, found = new Set<string>()): Set<string> {
    if (Array.isArray(node)) {
      for (const entry of node) keywords(entry, found);
      return found;
    }
    if (!node || typeof node !== "object") return found;
    for (const [keyword, value] of Object.entries(node as Record<string, unknown>)) {
      found.add(keyword);
      keywords(value, found);
    }
    return found;
  }

  it("documents the body without the keywords that would let Fastify reject it", async () => {
    const res = await app.inject({ method: "GET", url: "/docs/json" });
    const paths = res.json().paths ?? {};

    for (const route of ["/anchors/deposit", "/anchors/withdraw", "/api/sep24/deposit", "/api/sep24/withdraw"]) {
      const body = paths[route]?.post?.requestBody?.content?.["application/json"]?.schema;
      expect(body, `missing documented body for ${route}`).toBeTruthy();
      // Unknown keys stay the handler's business, so ajv must not strip or
      // reject them before Zod can name the offending field.
      expect(body.additionalProperties).toBe(true);
      expect(body.required).toEqual([]);
      const found = keywords(body);
      for (const rule of ["pattern", "minLength", "maxLength", "maxProperties", "minProperties"]) {
        expect(found.has(rule), `${rule} on ${route} would let Fastify reject before Zod`).toBe(false);
      }
    }
  });

  it("still documents the SEP-24 fields and the query parameters", async () => {
    const res = await app.inject({ method: "GET", url: "/docs/json" });
    const paths = res.json().paths ?? {};
    const deposit = paths["/api/sep24/deposit"]?.post;

    const properties = Object.keys(
      deposit.requestBody.content["application/json"].schema.properties
    );
    expect(properties).toEqual(
      expect.arrayContaining([
        "assetCode",
        "assetIssuer",
        "amount",
        "account",
        "to",
        "memo",
        "memoType",
        "refundAddress",
        "refundMemo",
        "refundMemoType",
      ])
    );
    expect(deposit.parameters.map((p: any) => p.name)).toContain("lang");
  });

  it("keeps the same documented shape for the withdrawal body", () => {
    const documented = openApiBody(sep24WithdrawRequestSchema, { enforce: false });

    expect((documented.properties as Record<string, any>).amount).toEqual({ type: "string" });
    expect(documented.required).toEqual([]);
  });
});
