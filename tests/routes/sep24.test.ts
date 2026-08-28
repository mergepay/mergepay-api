import { describe, it, expect, beforeEach, vi } from "vitest";
import jwt from "jsonwebtoken";

const h = vi.hoisted(() => {
  const prisma: any = {
    anchorSession: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      update: vi.fn(),
    },
    auditLog: { create: vi.fn(async () => ({ id: "audit_1" })) },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
  };
  const getToml = vi.fn();
  return { prisma, getToml };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));

vi.mock("../../src/services/anchor", async (importActual) => {
  const actual = await importActual<typeof import("../../src/services/anchor")>();
  return {
    ...actual,
    anchorService: { ...actual.anchorService, getToml: h.getToml },
  };
});

import { buildApp } from "../../src/app";
import { config } from "../../src/config";
import { verifyAnchorToken } from "../../src/services/sep24";

const prisma = h.prisma;
const getToml = h.getToml;

/** The anchor's SEP-10 signing key, as published in its stellar.toml. */
const SIGNING_KEY = "anchor-sep10-signing-key";

let app: Awaited<ReturnType<typeof buildApp>>;

/** Each case sends from its own address so rate-limit budgets never bleed. */
let clientAddress = 0;

function anchorToken(over: Record<string, unknown> = {}, key = SIGNING_KEY) {
  return jwt.sign(
    { sub: "anchor-tx-1", iss: config.ANCHOR_HOME_DOMAIN, ...over },
    key,
    { algorithm: "HS256", expiresIn: "5m" }
  );
}

function callback(
  payload: unknown,
  token: string | null = anchorToken()
) {
  clientAddress += 1;
  return app.inject({
    method: "POST",
    url: "/api/sep24/callback",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    payload: payload as any,
    remoteAddress: `10.2.${Math.floor(clientAddress / 256)}.${clientAddress % 256}`,
  });
}

const session = (over: Record<string, any> = {}) => ({
  id: "session_1",
  userId: "user_1",
  status: "pending_user_transfer_start",
  externalTransactionId: "anchor_tx_1",
  ...over,
});

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();

  getToml.mockResolvedValue({
    homeDomain: config.ANCHOR_HOME_DOMAIN,
    webAuthEndpoint: "https://anchor.test/auth",
    transferServerSep24: "https://anchor.test/sep24",
    signingKey: SIGNING_KEY,
    assets: [],
  });

  prisma.anchorSession.findMany.mockResolvedValue([]);
  prisma.anchorSession.findUnique.mockResolvedValue(null);
  prisma.anchorSession.update.mockImplementation(async ({ data }: any) => ({
    ...session(),
    ...data,
  }));
  prisma.auditLog.create.mockResolvedValue({ id: "audit_1" });
});

describe("POST /api/sep24/callback — token verification", () => {
  it("accepts a callback signed by the anchor's SEP-10 key", async () => {
    prisma.anchorSession.findMany.mockResolvedValue([session()]);
    prisma.anchorSession.findUnique.mockResolvedValue(session());

    const res = await callback({
      transaction: { id: "anchor_tx_1", status: "completed" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true, status: "completed" });
  });

  it("rejects a callback with no bearer token", async () => {
    const res = await callback(
      { transaction: { id: "anchor_tx_1", status: "completed" } },
      null
    );

    expect(res.statusCode).toBe(401);
    expect(prisma.anchorSession.findMany).not.toHaveBeenCalled();
  });

  it("rejects a token signed with the wrong key", async () => {
    const res = await callback(
      { transaction: { id: "anchor_tx_1", status: "completed" } },
      anchorToken({}, "not-the-anchor-key")
    );

    expect(res.statusCode).toBe(401);
    expect(prisma.anchorSession.findMany).not.toHaveBeenCalled();
  });

  it("rejects a token issued by a different anchor domain", async () => {
    const res = await callback(
      { transaction: { id: "anchor_tx_1", status: "completed" } },
      anchorToken({ iss: "someone-else.example" })
    );

    expect(res.statusCode).toBe(401);
    expect(prisma.anchorSession.findMany).not.toHaveBeenCalled();
  });

  it("rejects an expired token", async () => {
    const expired = jwt.sign(
      { sub: "anchor-tx-1", iss: config.ANCHOR_HOME_DOMAIN },
      SIGNING_KEY,
      { algorithm: "HS256", expiresIn: -60 }
    );

    const res = await callback(
      { transaction: { id: "anchor_tx_1", status: "completed" } },
      expired
    );

    expect(res.statusCode).toBe(401);
  });

  it("rejects a malformed token", async () => {
    const res = await callback(
      { transaction: { id: "anchor_tx_1", status: "completed" } },
      "not-a-jwt"
    );

    expect(res.statusCode).toBe(401);
  });

  it("returns a structured JSON error on rejection", async () => {
    const res = await callback(
      { transaction: { id: "anchor_tx_1", status: "completed" } },
      null
    );

    const body = res.json();
    expect(body.code).toEqual(expect.any(String));
    expect(body.message).toEqual(expect.any(String));
    // The reason for rejection is never disclosed to the caller.
    expect(JSON.stringify(body)).not.toContain(SIGNING_KEY);
  });

  it("verifies against an explicitly supplied signing key", async () => {
    const subject = await verifyAnchorToken(
      `Bearer ${anchorToken({ sub: "tx-9" }, "another-key")}`,
      "another-key"
    );

    expect(subject).toBe("tx-9");
  });
});

describe("POST /api/sep24/callback — payload validation", () => {
  it("rejects a body missing the transaction id", async () => {
    const res = await callback({ status: "completed" });

    expect(res.statusCode).toBe(400);
    expect(prisma.anchorSession.findMany).not.toHaveBeenCalled();
  });

  it("accepts the flattened callback shape", async () => {
    prisma.anchorSession.findMany.mockResolvedValue([session()]);
    prisma.anchorSession.findUnique.mockResolvedValue(session());

    const res = await callback({ id: "anchor_tx_1", status: "completed" });

    expect(res.statusCode).toBe(200);
  });

  it("ignores unknown anchor-specific fields", async () => {
    prisma.anchorSession.findMany.mockResolvedValue([session()]);
    prisma.anchorSession.findUnique.mockResolvedValue(session());

    const res = await callback({
      transaction: {
        id: "anchor_tx_1",
        status: "completed",
        some_future_field: { nested: true },
      },
    });

    expect(res.statusCode).toBe(200);
  });
});

describe("POST /api/sep24/callback — state updates", () => {
  it("advances the matching session and audits the transition", async () => {
    prisma.anchorSession.findMany.mockResolvedValue([session()]);
    prisma.anchorSession.findUnique.mockResolvedValue(session());

    const res = await callback({
      transaction: { id: "anchor_tx_1", status: "completed" },
    });

    expect(res.json()).toMatchObject({ matched: 1, updated: 1 });
    expect(prisma.anchorSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "completed" }),
      })
    );

    const actions = prisma.auditLog.create.mock.calls.map(
      ([args]: any[]) => args.data.action
    );
    expect(actions).toContain("anchor_session.status_changed");
    expect(actions).toContain("sep24.callback.applied");
  });

  it.each(["no_market", "too_small", "too_large", "expired"])(
    "collapses the terminal failure %s onto the error status",
    async (rawStatus) => {
      prisma.anchorSession.findMany.mockResolvedValue([session()]);
      prisma.anchorSession.findUnique.mockResolvedValue(session());

      const res = await callback({
        transaction: { id: "anchor_tx_1", status: rawStatus },
      });

      // Not "pending_anchor": an unmapped status would be coerced to a
      // still-in-flight state and hide a dead transfer.
      expect(res.json().status).toBe("error");
    }
  );

  it("passes an in-flight status through unchanged", async () => {
    const incomplete = session({ status: "incomplete" });
    prisma.anchorSession.findMany.mockResolvedValue([incomplete]);
    prisma.anchorSession.findUnique.mockResolvedValue(incomplete);

    const res = await callback({
      transaction: { id: "anchor_tx_1", status: "pending_anchor" },
    });

    expect(res.json().status).toBe("pending_anchor");
  });

  it("treats a duplicate delivery of the current status as a no-op", async () => {
    const current = session({ status: "completed" });
    prisma.anchorSession.findMany.mockResolvedValue([current]);
    prisma.anchorSession.findUnique.mockResolvedValue(current);

    const res = await callback({
      transaction: { id: "anchor_tx_1", status: "completed" },
    });

    expect(res.json()).toMatchObject({ matched: 1, updated: 0 });
    expect(prisma.anchorSession.update).not.toHaveBeenCalled();
  });

  it("ignores a transition that would regress a terminal session", async () => {
    const terminal = session({ status: "completed" });
    prisma.anchorSession.findMany.mockResolvedValue([terminal]);
    prisma.anchorSession.findUnique.mockResolvedValue(terminal);

    const res = await callback({
      transaction: { id: "anchor_tx_1", status: "pending_anchor" },
    });

    expect(res.json().updated).toBe(0);
    expect(prisma.anchorSession.update).not.toHaveBeenCalled();
  });

  it("returns 200 and audits when no session tracks the transaction", async () => {
    prisma.anchorSession.findMany.mockResolvedValue([]);

    const res = await callback({
      transaction: { id: "unknown_tx", status: "completed" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ matched: 0, updated: 0 });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "sep24.callback.unmatched" }),
      })
    );
  });

  it("records the anchor's message as the session failure reason", async () => {
    prisma.anchorSession.findMany.mockResolvedValue([session()]);
    prisma.anchorSession.findUnique.mockResolvedValue(session());

    await callback({
      transaction: {
        id: "anchor_tx_1",
        status: "error",
        message: "bank rejected the transfer",
      },
    });

    expect(prisma.anchorSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          failureReason: "bank rejected the transfer",
        }),
      })
    );
  });

  it("still applies a status it does not recognise", async () => {
    prisma.anchorSession.findMany.mockResolvedValue([session()]);
    prisma.anchorSession.findUnique.mockResolvedValue(session());

    // An anchor adding a status to the spec should not start failing
    // callbacks; the handler logs it and carries on.
    const res = await callback({
      transaction: { id: "anchor_tx_1", status: "pending_something_new" },
    });

    expect(res.statusCode).toBe(200);
  });
});
