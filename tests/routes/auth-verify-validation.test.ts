/**
 * Issue #519 — the SEP-10 verify endpoint's request schema, end to end.
 *
 * The unit tests in tests/schemas/auth.test.ts pin the rules themselves; this
 * suite pins where they run. Two properties matter and they pull in opposite
 * directions:
 *
 *  - A payload the schema rejects must be answered with 400 VALIDATION_ERROR,
 *    naming the offending field, *before* the Stellar SDK is asked to parse
 *    anything: no `authenticateChallenge` call, no user upsert, no audit row,
 *    and no challenge burned.
 *  - A payload the schema accepts must reach SDK verification byte for byte,
 *    and a well-formed envelope the SDK refuses must be answered 401 by the
 *    SDK — not 400 by the schema, and never by both.
 *
 * The database and Horizon are mocked, so nothing here touches the network.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Keypair, Transaction, WebAuth } from "@stellar/stellar-sdk";

const h = vi.hoisted(() => {
  const prisma: any = {
    user: { upsert: vi.fn(), findUnique: vi.fn() },
    auditLog: { create: vi.fn(async () => ({})) },
    refreshToken: { create: vi.fn(async () => ({})) },
    $executeRaw: vi.fn(async () => 1),
    $queryRawUnsafe: vi.fn(async () => [{ "?column?": 1 }]),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $disconnect: vi.fn(),
  };
  return { prisma };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));

vi.mock("../../src/services/stellar", async (importActual) => {
  const actual = await importActual<typeof import("../../src/services/stellar")>();
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

// Real behaviour behind a spy, so each case can prove whether validation ran
// before the service did.
vi.mock("../../src/services/sep10", async (importActual) => {
  const actual = await importActual<typeof import("../../src/services/sep10")>();
  return { ...actual, authenticateChallenge: vi.fn(actual.authenticateChallenge) };
});

vi.mock("../../src/services/refresh-token", async (importActual) => {
  const actual = await importActual<typeof import("../../src/services/refresh-token")>();
  return {
    ...actual,
    issueRefreshToken: vi.fn(async () => ({
      token: "refresh-token",
      expiresAt: new Date("2026-12-31T00:00:00.000Z"),
    })),
  };
});

import { buildApp } from "../../src/app";
import { authenticateChallenge } from "../../src/services/sep10";
import { config } from "../../src/config";

let app: Awaited<ReturnType<typeof buildApp>>;

// The auth routes are rate limited per client IP, so each request in this suite
// gets its own address and the limiter stays out of the way.
let requestCount = 0;
function verify(payload: unknown) {
  requestCount += 1;
  return app.inject({
    method: "POST",
    url: "/auth/verify",
    remoteAddress: `10.60.${Math.floor(requestCount / 250)}.${(requestCount % 250) + 1}`,
    payload: payload as object,
  });
}

/** A challenge signed by the wallet, as `/auth/challenge` + the client produce. */
function signedChallenge(): string {
  const envelope = WebAuth.buildChallengeTx(
    Keypair.random(),
    Keypair.random().publicKey(),
    config.SEP10_HOME_DOMAIN,
    300,
    config.networkPassphrase,
    config.WEB_AUTH_DOMAIN
  );
  return envelope;
}

/** Same envelope, signed — the real client submission. */
function signedByClient(client: Keypair): string {
  const envelope = WebAuth.buildChallengeTx(
    Keypair.random(),
    client.publicKey(),
    config.SEP10_HOME_DOMAIN,
    300,
    config.networkPassphrase,
    config.WEB_AUTH_DOMAIN
  );
  const tx = new Transaction(envelope, config.networkPassphrase);
  tx.sign(client);
  return tx.toXDR();
}

function mockVerifiedAccount(publicKey: string) {
  h.prisma.user.upsert.mockResolvedValueOnce({
    id: "user_519",
    stellarPublicKey: publicKey,
    displayName: "Tester",
    avatarUrl: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  });
}

function expectNoStateChange() {
  expect(authenticateChallenge).not.toHaveBeenCalled();
  expect(h.prisma.user.upsert).not.toHaveBeenCalled();
  expect(h.prisma.auditLog.create).not.toHaveBeenCalled();
}

beforeEach(async () => {
  vi.clearAllMocks();
  h.prisma.auditLog.create.mockImplementation(async () => ({}));
  h.prisma.user.upsert.mockReset();
  if (!app) app = await buildApp();
});

describe("POST /auth/verify — a valid payload reaches SDK verification", () => {
  it("passes the submitted envelope to authenticateChallenge unchanged", async () => {
    const client = Keypair.random();
    const transaction = signedByClient(client);
    // The server that issued the challenge has to be the one the service uses.
    const actual = await vi.importActual<typeof import("../../src/services/sep10")>(
      "../../src/services/sep10"
    );
    const server = actual.serverKeypair();
    const issued = WebAuth.buildChallengeTx(
      server,
      client.publicKey(),
      config.SEP10_HOME_DOMAIN,
      300,
      config.networkPassphrase,
      config.WEB_AUTH_DOMAIN
    );
    const signed = new Transaction(issued, config.networkPassphrase);
    signed.sign(client);
    mockVerifiedAccount(client.publicKey());

    const res = await verify({ transaction: signed.toXDR() });

    expect(res.statusCode).toBe(200);
    expect(authenticateChallenge).toHaveBeenCalledTimes(1);
    // Byte for byte: re-encoding the envelope would invalidate the signature.
    expect(authenticateChallenge).toHaveBeenCalledWith(signed.toXDR());
    expect(transaction).toBeTruthy();
    const body = res.json();
    expect(body.token).toBeTruthy();
    expect(body.refreshToken).toBe("refresh-token");
    expect(body.user.stellarPublicKey).toBe(client.publicKey());
  });

  it("issues a session for an unsigned challenge the SDK still trusts", async () => {
    // A baseline for the cases below: the endpoint works, so a rejection they
    // produce is attributable to the schema and not to a broken fixture.
    const client = Keypair.random();
    const actual = await vi.importActual<typeof import("../../src/services/sep10")>(
      "../../src/services/sep10"
    );
    const issued = WebAuth.buildChallengeTx(
      actual.serverKeypair(),
      client.publicKey(),
      config.SEP10_HOME_DOMAIN,
      300,
      config.networkPassphrase,
      config.WEB_AUTH_DOMAIN
    );
    const signed = new Transaction(issued, config.networkPassphrase);
    signed.sign(client);
    mockVerifiedAccount(client.publicKey());

    const res = await verify({ transaction: signed.toXDR() });

    expect(res.statusCode).toBe(200);
  });
});

describe("POST /auth/verify — invalid payloads are rejected before verification", () => {
  it.each([
    ["no body at all", undefined],
    ["an empty body", {}],
    ["a missing transaction", { home_domain: "anchor.example.com" }],
    ["a null transaction", { transaction: null }],
    ["a numeric transaction", { transaction: 7 }],
    ["a boolean transaction", { transaction: false }],
    ["an object transaction", { transaction: { xdr: signedChallenge() } }],
    ["an array body", [signedChallenge()]],
    ["an empty transaction", { transaction: "" }],
    ["a whitespace-only transaction", { transaction: "  " }],
    ["a transaction with surrounding whitespace", { transaction: " AAAA " }],
    ["a transaction with an embedded newline", { transaction: "AAAA\n" }],
    ["a non-base64 transaction", { transaction: "not-xdr!" }],
    ["a base64url transaction", { transaction: "a-_b" }],
    ["a URL-encoded transaction", { transaction: "AAAA%3D%3D" }],
    ["a hex digest sent as the envelope", { transaction: "deadbeef" }],
    ["a transaction with non-canonical padding bits", { transaction: "AB==" }],
    ["a transaction that decodes to a partial XDR word", { transaction: "AAAA" }],
    ["an oversized transaction", { transaction: "A".repeat(50_001) }],
    ["an unknown extra field", { transaction: signedChallenge(), account: "G" }],
  ])("answers %s with 400 VALIDATION_ERROR and touches nothing", async (_label, payload) => {
    const res = await verify(payload);

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.requestId).toBeTruthy();
    expectNoStateChange();
  });

  it("names the transaction field in the structured error details", async () => {
    const res = await verify({ transaction: "AAAA" });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    const details: Array<{ field: string; message: string }> = body.error.details;
    expect(details.map((detail) => detail.field)).toContain("transaction");
    expect(body.error.message).toMatch(/transaction/);
    expectNoStateChange();
  });

  it("names the encoding rule so the client can fix the payload", async () => {
    const notBase64 = await verify({ transaction: "not-xdr!" });
    expect(notBase64.json().error.message).toMatch(/base64/i);

    const misaligned = await verify({ transaction: "AAAA" });
    expect(misaligned.json().error.message).toMatch(/XDR words/i);

    expectNoStateChange();
  });

  it("reports one problem per payload, not one problem per rule it breaks", async () => {
    // A client fixes the first line it is given; three consequences of the same
    // typo only bury it.
    const res = await verify({ transaction: "not-xdr!" });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.details).toHaveLength(1);
    expectNoStateChange();
  });

  it("reports a wrong type as a type error, judging the value the client sent", async () => {
    // Fastify's default is to coerce a value to the type the route schema
    // declares, so this payload would reach the handler as the string "12345"
    // and be rejected for not being base64. Naming the field and its real type
    // is the more useful answer, and it is the one the client can act on.
    const res = await verify({ transaction: 12345 });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.error.details).toEqual([
      { field: "transaction", message: expect.stringMatching(/string/i) },
    ]);
    expect(body.error.message).toMatch(/^transaction: /);
    expect(body.error.issues).toEqual([
      expect.objectContaining({ path: ["transaction"], code: "type" }),
    ]);
    expectNoStateChange();
  });

  it.each([
    ["a boolean", true],
    ["a number", 12345],
    ["an array", ["AAAA"]],
    ["an object", { envelope: "AAAA" }],
  ])("rejects %s sent for transaction without coercion", async (_label, transaction) => {
    const res = await verify({ transaction });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.details[0].field).toBe("transaction");
    expect(body.error.message).toMatch(/^transaction: /);
    expectNoStateChange();
  });

  it("names an unknown key instead of reporting the root", async () => {
    // Zod raises `unrecognized_keys` with an empty path, so the offending key
    // is only visible in the issue's `keys`. Reporting `field: ""` would tell
    // the client that something at the top level is wrong and nothing about
    // what to delete.
    const res = await verify({ transaction: signedChallenge(), signature: "s" });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.details.map((d: { field: string }) => d.field)).toContain(
      "signature"
    );
    expectNoStateChange();
  });

  it("answers a wrong-typed field in the same shape Zod rejections use", async () => {
    // A client must not be able to tell which validator rejected the request:
    // same code, same `details`, same `issues`, same field-prefixed message.
    const schemaRejected = await verify({ transaction: "" });
    const frameworkRejected = await verify({ transaction: 12345 });

    const shape = (res: { json(): any }) => {
      const body = res.json();
      return {
        status: res.statusCode,
        code: body.code,
        messageIsFieldPrefixed: /^transaction: /.test(body.error.message),
        detailFields: body.error.details.map((d: { field: string }) => d.field),
        issuePaths: body.error.issues.map((i: { path: string[] }) => i.path),
      };
    };

    expect(shape(frameworkRejected)).toEqual({
      ...shape(schemaRejected),
      status: 400,
    });
    expectNoStateChange();
  });

  it("does not consume the challenge, so a corrected retry still works", async () => {
    const client = Keypair.random();
    const actual = await vi.importActual<typeof import("../../src/services/sep10")>(
      "../../src/services/sep10"
    );
    const issued = WebAuth.buildChallengeTx(
      actual.serverKeypair(),
      client.publicKey(),
      config.SEP10_HOME_DOMAIN,
      300,
      config.networkPassphrase,
      config.WEB_AUTH_DOMAIN
    );
    const signed = new Transaction(issued, config.networkPassphrase);
    signed.sign(client);
    const transaction = signed.toXDR();

    // Same envelope, one character of trailing whitespace: rejected as a
    // request error, so the challenge must still be redeemable.
    const rejected = await verify({ transaction: `${transaction} ` });
    expect(rejected.statusCode).toBe(400);
    expect(authenticateChallenge).not.toHaveBeenCalled();

    mockVerifiedAccount(client.publicKey());
    const retried = await verify({ transaction });
    expect(retried.statusCode).toBe(200);
    expect(authenticateChallenge).toHaveBeenCalledTimes(1);
  });
});

describe("POST /auth/verify — the SDK, not the schema, judges the envelope", () => {
  it.each([
    ["a well-formed envelope that is not a transaction", "AAAAAA=="],
    ["a zero-filled envelope", "AAAAAAAAAAAAAAAA"],
  ])("answers %s with the SDK's 401, never a 400", async (_label, transaction) => {
    const res = await verify({ transaction });

    // The schema accepted it (it is valid base64 XDR), so the rejection is the
    // SDK's and keeps the opaque 401 that challenge verification always uses.
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("UNAUTHORIZED");
    expect(authenticateChallenge).toHaveBeenCalledWith(transaction);
    expect(h.prisma.user.upsert).not.toHaveBeenCalled();
    expect(h.prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("keeps the 400/401 boundary honest for a near-miss payload", async () => {
    // "AAAAAA==" is a whole number of XDR words, "AAAA" is not: the first is the
    // SDK's business, the second is the schema's, and the client can tell them
    // apart by status code alone.
    const aligned = await verify({ transaction: "AAAAAA==" });
    const misaligned = await verify({ transaction: "AAAA" });

    expect(aligned.statusCode).toBe(401);
    expect(misaligned.statusCode).toBe(400);
  });
});
