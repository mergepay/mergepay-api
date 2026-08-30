import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";

const h = vi.hoisted(() => {
  const prisma: any = {
    anchorSession: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
    $disconnect: vi.fn(),
  };
  return { prisma };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));

import { buildApp } from "../../src/app";
import { config } from "../../src/config";
import {
  SEP24_SIGNATURE_HEADER,
  SEP24_TIMESTAMP_HEADER,
  resetAnchorSecretCache,
  signSep24Payload,
  verifySep24Signature,
} from "../../src/services/sep24";

const prisma = h.prisma;

const SECRET = config.ANCHOR_WEBHOOK_SECRET;

let app: Awaited<ReturnType<typeof buildApp>>;

/**
 * Build a request the way an anchor does: sign the exact bytes that will be
 * transmitted, then send those same bytes. Signing a re-serialized object
 * would hide the very bug the raw-body handling exists to prevent.
 */
function signedRequest(
  payload: unknown,
  over: { secret?: string; headers?: Record<string, string> } = {}
) {
  const rawBody = JSON.stringify(payload);
  const signature = signSep24Payload(rawBody, over.secret ?? SECRET);
  return {
    payload: rawBody,
    headers: {
      "content-type": "application/json",
      [SEP24_SIGNATURE_HEADER]: signature,
      ...(over.headers ?? {}),
    },
  };
}

/**
 * The route is rate limited per client IP, which is the behaviour under test
 * elsewhere — not here. Each case sends from its own address so one test's
 * budget can never bleed into the next.
 */
let clientAddress = 0;

function post(request: { payload: string; headers: Record<string, string> }) {
  clientAddress += 1;
  return app.inject({
    method: "POST",
    url: "/api/webhooks/sep24",
    headers: request.headers,
    payload: request.payload,
    remoteAddress: `10.0.${Math.floor(clientAddress / 256)}.${clientAddress % 256}`,
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
  resetAnchorSecretCache();
  if (!app) app = await buildApp();

  prisma.anchorSession.findMany.mockResolvedValue([]);
  prisma.anchorSession.findUnique.mockResolvedValue(null);
  prisma.anchorSession.update.mockImplementation(async ({ data }: any) => ({
    ...session(),
    ...data,
  }));
  prisma.auditLog.create.mockResolvedValue({ id: "audit_1" });
});

afterEach(() => {
  resetAnchorSecretCache();
});

describe("POST /api/webhooks/sep24 — signature verification", () => {
  it("accepts a payload signed with the configured secret", async () => {
    prisma.anchorSession.findMany.mockResolvedValue([session()]);
    prisma.anchorSession.findUnique.mockResolvedValue(session());

    const response = await post(
      signedRequest({ transaction: { id: "anchor_tx_1", status: "completed" } })
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ received: true, status: "completed" });
  });

  it("rejects a payload with no signature header", async () => {
    const response = await post({
      payload: JSON.stringify({ id: "anchor_tx_1", status: "completed" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(401);
    expect(prisma.anchorSession.findMany).not.toHaveBeenCalled();
  });

  it("rejects a signature computed with the wrong secret", async () => {
    const response = await post(
      signedRequest(
        { transaction: { id: "anchor_tx_1", status: "completed" } },
        { secret: "not-the-configured-secret" }
      )
    );

    expect(response.statusCode).toBe(401);
    expect(prisma.anchorSession.findMany).not.toHaveBeenCalled();
  });

  it("rejects a malformed (non-hex) signature without touching the database", async () => {
    const response = await post({
      payload: JSON.stringify({ id: "anchor_tx_1", status: "completed" }),
      headers: {
        "content-type": "application/json",
        [SEP24_SIGNATURE_HEADER]: "not-a-signature",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(prisma.anchorSession.findMany).not.toHaveBeenCalled();
  });

  it("rejects a valid signature over a body that was then modified", async () => {
    const signed = signedRequest({
      transaction: { id: "anchor_tx_1", status: "pending_anchor" },
    });

    // Same signature, different bytes — exactly what a tampering proxy does.
    const response = await post({
      payload: JSON.stringify({
        transaction: { id: "anchor_tx_1", status: "completed" },
      }),
      headers: signed.headers,
    });

    expect(response.statusCode).toBe(401);
    expect(prisma.anchorSession.findMany).not.toHaveBeenCalled();
  });

  it("accepts the sha256= prefixed signature encoding", async () => {
    prisma.anchorSession.findMany.mockResolvedValue([session()]);
    prisma.anchorSession.findUnique.mockResolvedValue(session());

    const rawBody = JSON.stringify({ id: "anchor_tx_1", status: "completed" });
    const response = await post({
      payload: rawBody,
      headers: {
        "content-type": "application/json",
        [SEP24_SIGNATURE_HEADER]: `sha256=${signSep24Payload(rawBody, SECRET)}`,
      },
    });

    expect(response.statusCode).toBe(200);
  });

  it("rejects a correctly signed payload whose timestamp is outside tolerance", async () => {
    const stale = Date.now() - config.SEP24_WEBHOOK_TOLERANCE_MS - 60_000;
    const response = await post(
      signedRequest(
        { transaction: { id: "anchor_tx_1", status: "completed" } },
        { headers: { [SEP24_TIMESTAMP_HEADER]: String(stale) } }
      )
    );

    expect(response.statusCode).toBe(401);
    expect(prisma.anchorSession.findMany).not.toHaveBeenCalled();
  });

  it("accepts a fresh timestamp expressed in seconds", async () => {
    prisma.anchorSession.findMany.mockResolvedValue([session()]);
    prisma.anchorSession.findUnique.mockResolvedValue(session());

    const response = await post(
      signedRequest(
        { transaction: { id: "anchor_tx_1", status: "completed" } },
        {
          headers: {
            [SEP24_TIMESTAMP_HEADER]: String(Math.floor(Date.now() / 1000)),
          },
        }
      )
    );

    expect(response.statusCode).toBe(200);
  });
});

describe("POST /api/webhooks/sep24 — payload validation", () => {
  it("rejects a signed body that is not valid JSON", async () => {
    const rawBody = "{not json";
    const response = await post({
      payload: rawBody,
      headers: {
        "content-type": "application/json",
        [SEP24_SIGNATURE_HEADER]: signSep24Payload(rawBody, SECRET),
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("rejects a signed body missing the transaction id", async () => {
    const response = await post(signedRequest({ status: "completed" }));

    expect(response.statusCode).toBe(400);
    expect(prisma.anchorSession.findMany).not.toHaveBeenCalled();
  });

  it("accepts the flattened (non-enveloped) callback shape", async () => {
    prisma.anchorSession.findMany.mockResolvedValue([session()]);
    prisma.anchorSession.findUnique.mockResolvedValue(session());

    const response = await post(
      signedRequest({ id: "anchor_tx_1", status: "completed" })
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "completed" });
  });

  it("ignores unknown anchor-specific fields", async () => {
    prisma.anchorSession.findMany.mockResolvedValue([session()]);
    prisma.anchorSession.findUnique.mockResolvedValue(session());

    const response = await post(
      signedRequest({
        transaction: {
          id: "anchor_tx_1",
          status: "completed",
          some_future_anchor_field: { nested: true },
        },
      })
    );

    expect(response.statusCode).toBe(200);
  });
});

describe("POST /api/webhooks/sep24 — state updates", () => {
  it("advances the matching session and audits the transition", async () => {
    prisma.anchorSession.findMany.mockResolvedValue([session()]);
    prisma.anchorSession.findUnique.mockResolvedValue(session());

    const response = await post(
      signedRequest({ transaction: { id: "anchor_tx_1", status: "completed" } })
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ matched: 1, updated: 1 });

    expect(prisma.anchorSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "session_1" },
        data: expect.objectContaining({ status: "completed" }),
      })
    );

    const actions = prisma.auditLog.create.mock.calls.map(
      ([args]: any[]) => args.data.action
    );
    expect(actions).toContain("anchor_session.status_changed");
    expect(actions).toContain("sep24.webhook.applied");
  });

  it("treats a duplicate delivery of the current status as a no-op", async () => {
    const current = session({ status: "completed" });
    prisma.anchorSession.findMany.mockResolvedValue([current]);
    prisma.anchorSession.findUnique.mockResolvedValue(current);

    const response = await post(
      signedRequest({ transaction: { id: "anchor_tx_1", status: "completed" } })
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ matched: 1, updated: 0 });
    expect(prisma.anchorSession.update).not.toHaveBeenCalled();
  });

  it("ignores a transition that would regress a terminal session", async () => {
    const terminal = session({ status: "completed" });
    prisma.anchorSession.findMany.mockResolvedValue([terminal]);
    prisma.anchorSession.findUnique.mockResolvedValue(terminal);

    const response = await post(
      signedRequest({
        transaction: { id: "anchor_tx_1", status: "pending_user_transfer_start" },
      })
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ updated: 0 });
    expect(prisma.anchorSession.update).not.toHaveBeenCalled();
  });

  it("applies the update to every session tracking the transaction", async () => {
    const first = session({ id: "session_1" });
    const second = session({ id: "session_2" });
    prisma.anchorSession.findMany.mockResolvedValue([first, second]);
    prisma.anchorSession.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === "session_1" ? first : second
    );

    const response = await post(
      signedRequest({ transaction: { id: "anchor_tx_1", status: "completed" } })
    );

    expect(response.json()).toMatchObject({ matched: 2, updated: 2 });
    expect(prisma.anchorSession.update).toHaveBeenCalledTimes(2);
  });

  it("returns 200 and audits when no session tracks the transaction", async () => {
    prisma.anchorSession.findMany.mockResolvedValue([]);

    const response = await post(
      signedRequest({ transaction: { id: "unknown_tx", status: "completed" } })
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ matched: 0, updated: 0 });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "sep24.webhook.unmatched" }),
      })
    );
  });

  it.each(["no_market", "too_small", "too_large", "expired"])(
    "collapses the terminal anchor failure %s onto the error status",
    async (rawStatus) => {
      prisma.anchorSession.findMany.mockResolvedValue([session()]);
      prisma.anchorSession.findUnique.mockResolvedValue(session());

      const response = await post(
        signedRequest({ transaction: { id: "anchor_tx_1", status: rawStatus } })
      );

      expect(response.statusCode).toBe(200);
      // Not "pending_anchor": an unmapped status would be coerced to a
      // still-in-flight state and hide a dead transfer.
      expect(response.json().status).toBe("error");
      expect(prisma.anchorSession.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "error" }),
        })
      );
    }
  );

  it("passes an in-flight anchor status through unchanged", async () => {
    const incomplete = session({ status: "incomplete" });
    prisma.anchorSession.findMany.mockResolvedValue([incomplete]);
    prisma.anchorSession.findUnique.mockResolvedValue(incomplete);

    const response = await post(
      signedRequest({
        transaction: { id: "anchor_tx_1", status: "pending_user_transfer_start" },
      })
    );

    expect(response.json().status).toBe("pending_user_transfer_start");
  });

  it("persists the anchor's message as the session failure reason", async () => {
    prisma.anchorSession.findMany.mockResolvedValue([session()]);
    prisma.anchorSession.findUnique.mockResolvedValue(session());

    await post(
      signedRequest({
        transaction: {
          id: "anchor_tx_1",
          status: "error",
          message: "bank rejected the transfer",
        },
      })
    );

    expect(prisma.anchorSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          failureReason: "bank rejected the transfer",
        }),
      })
    );
  });
});

describe("verifySep24Signature", () => {
  it("reports the reason a callback was rejected without exposing it", () => {
    const rawBody = JSON.stringify({ id: "x", status: "completed" });

    expect(verifySep24Signature({ rawBody, headers: {} })).toEqual({
      valid: false,
      reason: "missing_signature",
    });

    expect(
      verifySep24Signature({
        rawBody,
        headers: { [SEP24_SIGNATURE_HEADER]: "zz" },
      })
    ).toEqual({ valid: false, reason: "malformed_signature" });

    expect(
      verifySep24Signature({
        rawBody,
        headers: { [SEP24_SIGNATURE_HEADER]: "a".repeat(64) },
      })
    ).toEqual({ valid: false, reason: "invalid_signature" });
  });

  it("verifies against an explicitly supplied per-anchor secret", () => {
    const rawBody = JSON.stringify({ id: "x", status: "completed" });
    const secret = "another-anchor-secret";

    const result = verifySep24Signature({
      rawBody,
      headers: {
        [SEP24_SIGNATURE_HEADER]: signSep24Payload(rawBody, secret),
      },
      secret,
    });

    expect(result).toEqual({ valid: true });
  });

  it("verifies a Buffer body identically to its string form", () => {
    const rawBody = JSON.stringify({ id: "x", status: "completed" });
    const signature = signSep24Payload(rawBody, SECRET);

    expect(
      verifySep24Signature({
        rawBody: Buffer.from(rawBody, "utf8"),
        headers: { [SEP24_SIGNATURE_HEADER]: signature },
      })
    ).toEqual({ valid: true });
  });

  it("computes the documented HMAC-SHA256 construction", () => {
    const rawBody = '{"id":"x"}';
    const expected = crypto
      .createHmac("sha256", SECRET)
      .update(rawBody)
      .digest("hex");

    expect(signSep24Payload(rawBody, SECRET)).toBe(expected);
  });
});
