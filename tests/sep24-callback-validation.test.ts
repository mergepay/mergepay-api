/**
 * SEP-24 deposit and withdrawal callback validation (Issue #527).
 *
 * Every callback surface — the JWT-authenticated `POST /api/sep24/callback`,
 * the HMAC-authenticated `POST /api/webhooks/sep24`, and the
 * shared-secret `POST /anchors/webhook` — validates its payload with the one
 * canonical schema in src/schemas/sep24.ts, and rejects a malformed payload
 * with the project's structured 400 VALIDATION_ERROR *before* any database
 * work happens.
 *
 * The deliberate contract differences each way around the schema are covered
 * too: authentication always runs before validation (an unauthenticated
 * caller learns nothing about the payload contract), and unknown fields are
 * passed through rather than rejected (anchors add fields freely).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import jwt from "jsonwebtoken";

const h = vi.hoisted(() => {
  const model = () => ({
    findUnique: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
    update: vi.fn(),
    create: vi.fn(async () => ({ id: "row_1" })),
  });
  const prisma: any = {
    anchorSession: model(),
    withdrawal: model(),
    auditLog: model(),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $disconnect: vi.fn(),
  };
  const getToml = vi.fn();
  return { prisma, getToml };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

vi.mock("../src/services/anchor", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/anchor")>();
  return {
    ...actual,
    anchorService: { ...actual.anchorService, getToml: h.getToml },
  };
});

import { buildApp } from "../src/app";
import { config } from "../src/config";
import { sep24CallbackSchema as canonicalCallbackSchema } from "../src/schemas/sep24";
import { sep24CallbackSchema as hmacCallbackSchema } from "../src/services/sep24";
import { sep24CallbackSchema as jwtCallbackSchema } from "../src/services/sep24-anchor-token";
import {
  SEP24_SIGNATURE_HEADER,
  signSep24Payload,
} from "../src/services/sep24";

const prisma = h.prisma;
const SIGNING_KEY = "anchor-sep10-signing-key";

let app: Awaited<ReturnType<typeof buildApp>>;

/** Each case sends from its own address so rate-limit budgets never bleed. */
let clientAddress = 0;
function nextIp(): string {
  clientAddress += 1;
  return `10.7.${Math.floor(clientAddress / 256)}.${clientAddress % 256}`;
}

function anchorToken(over: Record<string, unknown> = {}) {
  return jwt.sign(
    { sub: "anchor-tx-1", iss: config.ANCHOR_HOME_DOMAIN, ...over },
    SIGNING_KEY,
    { algorithm: "HS256", expiresIn: "5m" }
  );
}

/** POST /api/sep24/callback — bearer token authenticated. */
function postJwtCallback(payload: unknown, token: string | null = anchorToken()) {
  return app.inject({
    method: "POST",
    url: "/api/sep24/callback",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    payload: payload as any,
    remoteAddress: nextIp(),
  });
}

/** POST /api/webhooks/sep24 — HMAC signature over the exact bytes. */
function postHmacCallback(payload: unknown, over: { secret?: string } = {}) {
  const rawBody = JSON.stringify(payload);
  const signature = signSep24Payload(
    rawBody,
    over.secret ?? config.ANCHOR_WEBHOOK_SECRET
  );
  return app.inject({
    method: "POST",
    url: "/api/webhooks/sep24",
    headers: {
      "content-type": "application/json",
      [SEP24_SIGNATURE_HEADER]: signature,
    },
    payload: rawBody,
    remoteAddress: nextIp(),
  });
}

/** POST /anchors/webhook — pre-shared header secret. */
function postAnchorWebhook(payload: unknown, secret = config.ANCHOR_WEBHOOK_SECRET) {
  return app.inject({
    method: "POST",
    url: "/anchors/webhook",
    headers: { "x-webhook-secret": secret },
    payload: payload as any,
    remoteAddress: nextIp(),
  });
}

function expectValidationError(res: { statusCode: number; json: () => any }) {
  expect(res.statusCode).toBe(400);
  const body = res.json();
  expect(body.code).toBe("VALIDATION_ERROR");
  expect(body.error).toBe("VALIDATION_ERROR");
  expect(typeof body.message).toBe("string");
  expect(Array.isArray(body.details)).toBe(true);
  expect(body.details.length).toBeGreaterThan(0);
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
  prisma.anchorSession.findMany.mockResolvedValue([]);
  prisma.anchorSession.findUnique.mockResolvedValue(null);
  prisma.withdrawal.findUnique.mockResolvedValue(null);
  prisma.auditLog.create.mockResolvedValue({ id: "audit_1" });
});

describe("canonical callback schema (src/schemas/sep24.ts)", () => {
  it("is the single schema re-exported by both callback services", () => {
    expect(hmacCallbackSchema).toBe(canonicalCallbackSchema);
    expect(jwtCallbackSchema).toBe(canonicalCallbackSchema);
  });

  it("accepts a wrapped deposit callback and normalizes it", () => {
    const result = canonicalCallbackSchema.safeParse({
      transaction: {
        id: "anchor_tx_1",
        status: "completed",
        kind: "deposit",
        amount_in: "100.0000000",
        amount_out: "99.5000000",
        amount_fee: "0.5000000",
        stellar_transaction_id: "stellar_hash_1",
        message: "all good",
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({
      externalTransactionId: "anchor_tx_1",
      rawStatus: "completed",
      message: "all good",
      stellarTransactionId: "stellar_hash_1",
      amountIn: "100.0000000",
      amountOut: "99.5000000",
      amountFee: "0.5000000",
    });
  });

  it("accepts a flattened withdrawal callback", () => {
    const result = canonicalCallbackSchema.safeParse({
      id: "wd_tx_9",
      status: "pending_external",
      kind: "withdrawal",
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.externalTransactionId).toBe("wd_tx_9");
    expect(result.data.rawStatus).toBe("pending_external");
  });

  it("falls back to a top-level message when the transaction has none", () => {
    const result = canonicalCallbackSchema.safeParse({
      id: "anchor_tx_1",
      status: "error",
      message: "bank rejected the transfer",
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.message).toBe("bank rejected the transfer");
  });

  it("requires a transaction id and a status", () => {
    expect(canonicalCallbackSchema.safeParse({}).success).toBe(false);
    expect(canonicalCallbackSchema.safeParse({ status: "completed" }).success).toBe(false);
    expect(canonicalCallbackSchema.safeParse({ id: "anchor_tx_1" }).success).toBe(false);
    expect(
      canonicalCallbackSchema.safeParse({ transaction: { status: "completed" } }).success
    ).toBe(false);
    expect(
      canonicalCallbackSchema.safeParse({ transaction: { id: "anchor_tx_1" } }).success
    ).toBe(false);
  });

  it("rejects malformed ids, statuses, and message payloads", () => {
    // Wrong types where a string is required.
    expect(canonicalCallbackSchema.safeParse({ id: 123, status: "completed" }).success).toBe(false);
    expect(canonicalCallbackSchema.safeParse({ id: "tx_1", status: 7 }).success).toBe(false);
    // Empty and over-long values (the limits a real transaction id has).
    expect(canonicalCallbackSchema.safeParse({ id: "", status: "completed" }).success).toBe(false);
    expect(canonicalCallbackSchema.safeParse({ id: "a".repeat(256), status: "completed" }).success).toBe(false);
    expect(canonicalCallbackSchema.safeParse({ id: "tx_1", status: "s".repeat(65) }).success).toBe(false);
    // A transaction envelope that is not an object at all.
    expect(canonicalCallbackSchema.safeParse({ transaction: "not-an-object" }).success).toBe(false);
    // A message we would later persist must be a string.
    expect(canonicalCallbackSchema.safeParse({ id: "tx_1", status: "error", message: 42 }).success).toBe(false);
  });

  it("passes unknown anchor-specific fields through instead of rejecting", () => {
    const result = canonicalCallbackSchema.safeParse({
      id: "anchor_tx_1",
      status: "completed",
      anchor_specific_field: { nested: true },
      transaction: {
        id: "anchor_tx_1",
        status: "completed",
        some_future_field: "ignored",
      },
    });

    expect(result.success).toBe(true);
  });
});

describe("POST /api/sep24/callback — payload validation", () => {
  it("accepts a valid deposit callback", async () => {
    const res = await postJwtCallback({
      transaction: { id: "anchor_tx_1", status: "completed", kind: "deposit" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true, status: "completed" });
  });

  it("accepts a valid withdrawal callback", async () => {
    const res = await postJwtCallback({ id: "wd_tx_1", status: "pending_user" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true, status: "pending_user" });
  });

  it("returns a structured 400 for a body missing the transaction id", async () => {
    const res = await postJwtCallback({ status: "completed" });

    expectValidationError(res);
    expect(prisma.anchorSession.findMany).not.toHaveBeenCalled();
  });

  it("returns a structured 400 for a body missing the status", async () => {
    const res = await postJwtCallback({ id: "anchor_tx_1" });

    expectValidationError(res);
    expect(prisma.anchorSession.findMany).not.toHaveBeenCalled();
  });

  it("returns a structured 400 for an empty body", async () => {
    const res = await postJwtCallback({});

    expectValidationError(res);
    expect(prisma.anchorSession.findMany).not.toHaveBeenCalled();
  });

  it("returns a structured 400 for a malformed transaction id", async () => {
    // An object where a string id belongs: it can neither be coerced by the
    // framework's schema pass nor accepted by Zod, so the request is rejected
    // before any database work.
    const res = await postJwtCallback({ id: { nested: true }, status: "completed" });

    expectValidationError(res);
    expect(prisma.anchorSession.findMany).not.toHaveBeenCalled();
  });

  it("ignores unknown fields on an otherwise valid callback", async () => {
    const res = await postJwtCallback({
      transaction: { id: "anchor_tx_1", status: "completed", future_field: 1 },
      also_unknown: "ok",
    });

    expect(res.statusCode).toBe(200);
  });

  it("still requires a token before any payload is examined", async () => {
    const res = await postJwtCallback({ status: "completed" }, null);

    expect(res.statusCode).toBe(401);
    expect(prisma.anchorSession.findMany).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/sep24 — payload validation", () => {
  it("accepts a valid, correctly signed callback", async () => {
    const res = await postHmacCallback({
      transaction: { id: "anchor_tx_1", status: "completed" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true, status: "completed" });
  });

  it("returns a structured 400 for a signed callback missing the status", async () => {
    const res = await postHmacCallback({ id: "anchor_tx_1" });

    expectValidationError(res);
    expect(prisma.anchorSession.findMany).not.toHaveBeenCalled();
  });

  it("returns a structured 400 for a signed callback with a malformed id", async () => {
    const res = await postHmacCallback({ id: { nested: true }, status: "completed" });

    expectValidationError(res);
    expect(prisma.anchorSession.findMany).not.toHaveBeenCalled();
  });

  it("still requires a valid signature before any payload is examined", async () => {
    const res = await postHmacCallback(
      { status: "completed" },
      { secret: "not-the-configured-secret" }
    );

    expect(res.statusCode).toBe(401);
    expect(prisma.anchorSession.findMany).not.toHaveBeenCalled();
  });
});

describe("POST /anchors/webhook — payload validation", () => {
  it("accepts a valid callback signed with the shared secret", async () => {
    const res = await postAnchorWebhook({
      transaction: { id: "ext_1", status: "completed" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("returns a structured 400 when the transaction id is missing", async () => {
    const res = await postAnchorWebhook({ status: "completed" });

    expectValidationError(res);
    expect(prisma.anchorSession.findMany).not.toHaveBeenCalled();
    expect(prisma.withdrawal.findUnique).not.toHaveBeenCalled();
  });

  it("returns a structured 400 when the status is missing", async () => {
    const res = await postAnchorWebhook({ transaction: { id: "ext_1" } });

    expectValidationError(res);
    expect(prisma.anchorSession.findMany).not.toHaveBeenCalled();
  });

  it("returns a structured 400 for a malformed transaction id", async () => {
    const res = await postAnchorWebhook({ id: "", status: "completed" });

    expectValidationError(res);
    expect(prisma.anchorSession.findMany).not.toHaveBeenCalled();
  });

  it("keeps the opaque 200 for a bad secret even when the payload is malformed", async () => {
    const res = await postAnchorWebhook({ status: "completed" }, "wrong-secret");

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(prisma.anchorSession.findMany).not.toHaveBeenCalled();
  });

  it("passes unknown anchor-specific fields through instead of rejecting", async () => {
    const res = await postAnchorWebhook({
      id: "ext_1",
      status: "completed",
      anchor_specific_field: { nested: true },
    });

    expect(res.statusCode).toBe(200);
  });
});
