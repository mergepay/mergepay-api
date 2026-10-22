/**
 * Issue #915 — Zod request-validation middleware for the SEP-24 anchor
 * deposit and withdrawal endpoints.
 *
 * Two layers are covered:
 *
 *  1. `validateRequest` (src/middleware/validate-request.ts) in isolation,
 *     against a bare Fastify instance — the parsing order, the write-back of
 *     transformed values, that parts not named are left untouched, and that a
 *     failure propagates the raw `ZodError` rather than a wrapped one.
 *  2. Its wiring onto the four SEP-24 initiation routes (the `/anchors/*`
 *     aliases and the `/api/sep24/*` ones) — a valid request reaches the anchor
 *     flow, an invalid one is answered with the standard `400 VALIDATION_ERROR`
 *     envelope carrying `details` and `issues`, and nothing upstream or
 *     persistent is touched on the rejection path.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify from "fastify";
import { z, ZodError } from "zod";
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
    anchorSession: model(),
    withdrawal: model(),
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
import { validateRequest } from "../src/middleware/validate-request";
import {
  validateSep24Deposit,
  validateSep24Withdraw,
} from "../src/schemas/sep24";
import {
  sep24DepositRequestSchema,
  sep24InitQuerySchema,
  sep24WithdrawRequestSchema,
} from "../src/validations/sep24";

const prisma = h.prisma;

// ─── Layer 1: the middleware factory ────────────────────────────────────────

describe("validateRequest — parsing behaviour", () => {
  /** Boot a throwaway app with one route guarded by `validateRequest`. */
  async function appWith(schemas: Parameters<typeof validateRequest>[0]) {
    const app = Fastify();
    app.post("/t/:id", { preHandler: [validateRequest(schemas)] }, (req) => ({
      body: req.body,
      query: req.query,
      params: req.params,
    }));
    await app.ready();
    return app;
  }

  it("parses and returns the body", async () => {
    const app = await appWith({
      body: z.object({ name: z.string().min(1) }).strict(),
    });

    const res = await app.inject({
      method: "POST",
      url: "/t/1",
      payload: { name: "ok" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().body).toEqual({ name: "ok" });
  });

  it("writes the transformed value back onto the request", async () => {
    // The schemas the SEP-24 routes use transform as well as check — an asset
    // code is upper-cased on parse — so the handler must read the normalised
    // value, not the raw one the client sent.
    const app = await appWith({
      body: z
        .object({ assetCode: z.string().transform((v) => v.toUpperCase()) })
        .strict(),
    });

    const res = await app.inject({
      method: "POST",
      url: "/t/1",
      payload: { assetCode: "usdc" },
    });

    expect(res.json().body.assetCode).toBe("USDC");
  });

  it("parses params, query, and body together", async () => {
    const app = await appWith({
      params: z.object({ id: z.string().min(1) }).strict(),
      query: z.object({ lang: z.string().min(2).max(10).optional() }).strict(),
      body: z.object({ name: z.string() }).strict(),
    });

    const res = await app.inject({
      method: "POST",
      url: "/t/abc?lang=en",
      payload: { name: "ok" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      params: { id: "abc" },
      query: { lang: "en" },
      body: { name: "ok" },
    });
  });

  it("leaves a part it was not asked to validate untouched", async () => {
    const app = await appWith({ body: z.object({ name: z.string() }).strict() });

    const res = await app.inject({
      method: "POST",
      url: "/t/1?anything=1",
      payload: { name: "ok" },
    });

    // No query schema was named, so the unknown query parameter is not judged.
    expect(res.statusCode).toBe(200);
    expect(res.json().query).toEqual({ anything: "1" });
  });

  it("throws the raw ZodError, not a wrapped one", async () => {
    const app = Fastify();
    app.setErrorHandler((err, _req, reply) => {
      // If the middleware wrapped the failure, this assertion fails: the
      // central error handler needs the original ZodError to render `issues`.
      expect(err).toBeInstanceOf(ZodError);
      return reply.code(400).send({ name: err.constructor.name });
    });
    app.post(
      "/t",
      { preHandler: [validateRequest({ body: z.object({ n: z.number() }) })] },
      () => ({ ok: true })
    );
    await app.ready();

    const res = await app.inject({ method: "POST", url: "/t", payload: { n: "x" } });

    expect(res.statusCode).toBe(400);
    expect(res.json().name).toBe("ZodError");
  });

  it("rejects an unexpected body key when the schema is strict", async () => {
    const app = Fastify();
    // A bare Fastify app has no central error handler, so render the thrown
    // ZodError here to observe the rejection rather than a bare 500.
    app.setErrorHandler((err, _req, reply) =>
      reply.code(400).send({ code: (err as ZodError).errors[0]?.code })
    );
    app.post(
      "/t",
      { preHandler: [validateRequest({ body: z.object({ name: z.string() }).strict() })] },
      () => ({ ok: true })
    );
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/t",
      payload: { name: "ok", extra: true },
    });

    // The handler is never reached: the hook rejected before it ran.
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("unrecognized_keys");
  });

  it("is a Fastify preHandler hook (a function taking the request)", () => {
    expect(typeof validateRequest({ body: z.object({}) })).toBe("function");
    expect(validateRequest({ body: z.object({}) })).toHaveLength(1);
  });
});

// ─── Layer 2: the SEP-24 route wiring ───────────────────────────────────────

let app: Awaited<ReturnType<typeof buildApp>>;
let userSeq = 0;

/**
 * A fresh identity per request: the `anchorInit` budget is keyed by the caller's
 * SEP-10 public key, so sharing one would let a test spend the next test's
 * quota and answer 429 where a 400 is expected.
 */
function authHeader(): Record<string, string> {
  return {
    authorization: `Bearer ${signToken({
      id: `user_${(userSeq += 1)}`,
      stellarPublicKey: Keypair.random().publicKey(),
    })}`,
    "content-type": "application/json",
  };
}

const DEPOSIT_ROUTES = ["/api/v1/anchors/deposit", "/api/v1/sep24/deposit"] as const;
const WITHDRAW_ROUTES = ["/api/v1/anchors/withdraw", "/api/v1/sep24/withdraw"] as const;

function post(path: string, payload: unknown, query = "") {
  return app.inject({
    method: "POST",
    url: `${path}${query}`,
    headers: authHeader(),
    payload: payload as any,
  });
}

/** Assert the standard validation envelope, and that it names `field`. */
function expectValidationEnvelope(res: { statusCode: number; json: () => any }, field: string) {
  expect(res.statusCode).toBe(400);
  const body = res.json();

  expect(body.error.code).toBe("VALIDATION_ERROR");
  expect(body.code).toBe("VALIDATION_ERROR");
  expect(typeof body.error.message).toBe("string");
  expect(typeof body.error.requestId).toBe("string");
  expect(Number.isNaN(Date.parse(body.error.timestamp))).toBe(false);

  expect(Array.isArray(body.error.details)).toBe(true);
  expect(body.error.details.length).toBeGreaterThan(0);
  expect(Array.isArray(body.error.issues)).toBe(true);
  expect(body.error.issues.length).toBeGreaterThan(0);

  const named =
    body.error.details.some((d: any) => d.field === field) ||
    body.error.issues.some((i: any) => i.path.join(".") === field);
  expect(named, `expected the rejection to name "${field}"`).toBe(true);

  return body;
}

/** Nothing upstream or persistent may be touched on the rejection path. */
function expectNoSideEffects() {
  expect(anchorService.getToml).not.toHaveBeenCalled();
  expect(anchorService.getChallenge).not.toHaveBeenCalled();
  expect(anchorService.startInteractive).not.toHaveBeenCalled();
  expect(prisma.anchorSession.create).not.toHaveBeenCalled();
  expect(prisma.auditLog.create).not.toHaveBeenCalled();
}

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();

  vi.mocked(anchorService.getToml).mockResolvedValue({
    homeDomain: config.ANCHOR_HOME_DOMAIN,
    webAuthEndpoint: "https://testanchor.stellar.org/auth",
    transferServerSep24: "https://testanchor.stellar.org/sep24",
    signingKey: Keypair.random().publicKey(),
    assets: [],
  } as any);
  vi.mocked(anchorService.getChallenge).mockResolvedValue({
    transaction: "challenge-xdr",
  } as any);
  prisma.anchorSession.create.mockImplementation(async ({ data }: any) => ({
    id: `session_${data.kind}_${Math.random().toString(16).slice(2, 8)}`,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    interactiveUrl: null,
    externalTransactionId: null,
    ...data,
  }));
  prisma.auditLog.create.mockResolvedValue({ id: "audit_1" });
});

describe("SEP-24 middleware is exported and wired", () => {
  it("exports the two middleware hooks as functions", () => {
    expect(typeof validateSep24Deposit).toBe("function");
    expect(typeof validateSep24Withdraw).toBe("function");
  });
});

describe.each(DEPOSIT_ROUTES)("POST %s — deposit validation", (path) => {
  it("accepts a valid deposit and initiates the anchor flow", async () => {
    const res = await post(path, {
      assetCode: "usdc",
      amount: "5.25",
      account: Keypair.random().publicKey(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.session).toBeTruthy();
    expect(body.challenge).toBeTruthy();
    // The middleware's parse normalises the code before the session is created.
    expect(body.session.assetCode).toBe("USDC");
    expect(anchorService.getChallenge).toHaveBeenCalled();
  });

  it("rejects a missing assetCode with the standard envelope", async () => {
    expectValidationEnvelope(await post(path, {}), "assetCode");
    expectNoSideEffects();
  });

  it("rejects a negative amount with the standard envelope", async () => {
    expectValidationEnvelope(
      await post(path, { assetCode: "USDC", amount: "-10.5" }),
      "amount"
    );
    expectNoSideEffects();
  });

  it("rejects an ill-formed Stellar account with the standard envelope", async () => {
    expectValidationEnvelope(
      await post(path, { assetCode: "USDC", account: "NOT_A_STELLAR_KEY" }),
      "account"
    );
    expectNoSideEffects();
  });

  it("rejects an unknown body field by name rather than dropping it", async () => {
    const body = expectValidationEnvelope(
      await post(path, { assetCode: "USDC", unrecognisedKey: "value" }),
      "unrecognisedKey"
    );
    expect(
      body.error.details.some((d: any) => d.code === "unrecognized_keys")
    ).toBe(true);
    expectNoSideEffects();
  });

  it("rejects an unexpected query parameter by name", async () => {
    expectValidationEnvelope(
      await post(path, { assetCode: "USDC" }, "?asset_code=USDC"),
      "asset_code"
    );
    expectNoSideEffects();
  });
});

describe.each(WITHDRAW_ROUTES)("POST %s — withdrawal validation", (path) => {
  it("accepts a valid withdrawal and initiates the anchor flow", async () => {
    const res = await post(path, {
      assetCode: "XLM",
      amount: "25.0000000",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().session).toBeTruthy();
    expect(res.json().challenge).toBeTruthy();
    expect(anchorService.getChallenge).toHaveBeenCalled();
  });

  it("rejects a missing amount with the standard envelope", async () => {
    expectValidationEnvelope(await post(path, { assetCode: "XLM" }), "amount");
    expectNoSideEffects();
  });

  it("rejects a zero amount with the standard envelope", async () => {
    expectValidationEnvelope(
      await post(path, { assetCode: "XLM", amount: "0" }),
      "amount"
    );
    expectNoSideEffects();
  });

  it("rejects a memo supplied without its memoType", async () => {
    expectValidationEnvelope(
      await post(path, { assetCode: "USDC", amount: "5", memo: "hello" }),
      "memoType"
    );
    expectNoSideEffects();
  });

  it("rejects an issuer on the native asset", async () => {
    expectValidationEnvelope(
      await post(path, {
        assetCode: "XLM",
        amount: "5",
        assetIssuer: Keypair.random().publicKey(),
      }),
      "assetIssuer"
    );
    expectNoSideEffects();
  });
});

describe("the middleware is the only validator", () => {
  it("does not depend on a route-level JSON schema to reject the body", () => {
    // The routes annotate their bodies with `openApiBody(schema, { enforce:
    // false })`, so Fastify's own ajv pass strips the rules and the Zod hook is
    // what actually rejects. Asserted structurally here so a future change that
    // re-enables enforcement is caught.
    const deposit = sep24DepositRequestSchema.safeParse({ assetCode: "USDC" });
    const withdraw = sep24WithdrawRequestSchema.safeParse({ assetCode: "XLM" });
    expect(deposit.success).toBe(true);
    expect(withdraw.success).toBe(false);

    // The init query schema tolerates `lang` and nothing else.
    expect(sep24InitQuerySchema.safeParse({}).success).toBe(true);
    expect(sep24InitQuerySchema.safeParse({ lang: "en" }).success).toBe(true);
    expect(sep24InitQuerySchema.safeParse({ nope: "1" }).success).toBe(false);
  });
});
