import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The idempotency table is modelled with real per-key rows and a real unique
 * constraint rather than a stub that always resolves. Concurrency is the whole
 * point of the feature: a double that cannot reject a duplicate insert would
 * pass every test here while the production behaviour it stands in for —
 * "only one of two racing retries executes" — went untested.
 */
const h = vi.hoisted(() => {
  class UniqueConstraintError extends Error {
    code = "P2002";
    clientVersion = "test";
    constructor() {
      super("Unique constraint failed");
      this.name = "PrismaClientKnownRequestError";
    }
  }

  const keyOf = (where: any) => {
    const composite = where.userId_scope_key ?? where;
    return `${composite.userId}|${composite.scope}|${composite.key}`;
  };

  const rows = new Map<string, any>();

  const idempotencyKey = {
    findUnique: vi.fn(async ({ where }: any) => rows.get(keyOf(where)) ?? null),
    create: vi.fn(async ({ data }: any) => {
      const id = keyOf(data);
      if (rows.has(id)) throw new UniqueConstraintError();
      const row = { ...data, createdAt: new Date(), updatedAt: new Date() };
      rows.set(id, row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const id = keyOf(where);
      const existing = rows.get(id);
      if (!existing) throw new Error("record not found");
      const row = { ...existing, ...data, updatedAt: new Date() };
      rows.set(id, row);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const id = `${where.userId}|${where.scope}|${where.key}`;
      const existing = rows.get(id);
      if (!existing) return { count: 0 };
      if (where.requestHash && existing.requestHash !== where.requestHash) {
        return { count: 0 };
      }
      // Mirror the OR clause: only failed or aged-out reservations re-claim.
      const staleBefore = where.OR?.find(
        (clause: any) => clause.status === "in_progress"
      )?.updatedAt?.lt;
      const claimable =
        existing.status === "failed" ||
        (existing.status === "in_progress" &&
          staleBefore instanceof Date &&
          existing.updatedAt < staleBefore);
      if (!claimable) return { count: 0 };

      rows.set(id, { ...existing, ...data, updatedAt: new Date() });
      return { count: 1 };
    }),
    deleteMany: vi.fn(async () => ({ count: 0 })),
  };

  const prisma: any = {
    idempotencyKey,
    settlement: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      updateMany: vi.fn(),
    },
    groupMember: { findUnique: vi.fn() },
    statusHistory: { create: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
    $disconnect: vi.fn(),
  };

  return { prisma, rows, UniqueConstraintError };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

vi.mock("@prisma/client", async (importActual) => {
  const actual = await importActual<any>();
  return {
    ...actual,
    Prisma: {
      ...actual.Prisma,
      PrismaClientKnownRequestError: h.UniqueConstraintError,
    },
  };
});

vi.mock("../src/services/settlement-xdr", () => ({
  validateSettlementXdr: vi.fn(),
}));

vi.mock("../src/services/status-history", () => ({
  recordStatusTransitionInTransaction: vi.fn(async () => undefined),
}));

import { buildApp } from "../src/app";
import { signToken } from "../src/plugins/auth";
import { validateSettlementXdr } from "../src/services/settlement-xdr";
import { IDEMPOTENCY_HEADER } from "../src/plugins/idempotency";

const prisma = h.prisma;
const rows = h.rows;

const USER_ID = "user_1";
const GROUP_ID = "group_1";

function authHeader() {
  const token = signToken({
    id: USER_ID,
    stellarPublicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  });
  return { authorization: `Bearer ${token}` };
}

const user = (id: string) => ({
  id,
  stellarPublicKey: `G${id.toUpperCase().padEnd(55, "A")}`,
  displayName: id,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
});

const settlement = (over: Record<string, any> = {}) => ({
  id: "settlement_1",
  shortCode: "ABC123",
  groupId: GROUP_ID,
  fromUserId: USER_ID,
  toUserId: "user_2",
  amount: "10.0000000",
  assetCode: "USDC",
  assetIssuer: null,
  status: "pending",
  transactionXdr: null,
  stellarTxHash: null,
  memo: "ABC123",
  retryCount: 0,
  failureReason: null,
  expiresAt: null,
  submittedAt: null,
  confirmedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  from: user(USER_ID),
  to: user("user_2"),
  statusHistory: [],
  ...over,
});

let app: Awaited<ReturnType<typeof buildApp>>;

/** Each test gets its own client address so rate-limit budgets never bleed. */
let clientAddress = 0;

function execute(
  body: unknown,
  headers: Record<string, string> = {}
) {
  clientAddress += 1;
  return app.inject({
    method: "POST",
    url: "/api/settlements/execute",
    headers: { ...authHeader(), ...headers },
    payload: body as any,
    remoteAddress: `10.1.${Math.floor(clientAddress / 256)}.${clientAddress % 256}`,
  });
}

/** A settlement that moves pending → submitted on the first execution. */
function stageSubmittableSettlement() {
  let current = settlement();
  prisma.settlement.findUnique.mockImplementation(async () => current);
  prisma.settlement.findUniqueOrThrow.mockImplementation(async () => current);
  prisma.settlement.updateMany.mockImplementation(async ({ where, data }: any) => {
    if (!where.status.in.includes(current.status)) return { count: 0 };
    current = { ...current, ...data };
    return { count: 1 };
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  rows.clear();
  if (!app) app = await buildApp();

  (validateSettlementXdr as any).mockReturnValue(undefined);
  prisma.groupMember.findUnique.mockResolvedValue({
    groupId: GROUP_ID,
    userId: USER_ID,
    role: "member",
  });
  prisma.auditLog.create.mockResolvedValue({ id: "audit_1" });
  stageSubmittableSettlement();
});

const body = { settlementId: "settlement_1", signedXdr: "AAAA-signed-envelope" };

describe("POST /api/settlements/execute — key handling", () => {
  it("rejects a request with no X-Idempotency-Key", async () => {
    const response = await execute(body);

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("MISSING_IDEMPOTENCY_KEY");
    expect(prisma.settlement.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a malformed key before reserving anything", async () => {
    const response = await execute(body, {
      [IDEMPOTENCY_HEADER]: "not a valid key!",
    });

    expect(response.statusCode).toBe(400);
    expect(prisma.idempotencyKey.create).not.toHaveBeenCalled();
  });

  it("executes once and reserves the key", async () => {
    const response = await execute(body, { [IDEMPOTENCY_HEADER]: "key-1" });

    expect(response.statusCode).toBe(202);
    expect(response.json().settlement.status).toBe("submitted");
    expect(prisma.settlement.updateMany).toHaveBeenCalledTimes(1);

    const [row] = [...rows.values()];
    expect(row).toMatchObject({
      scope: "settlement.execute",
      key: "key-1",
      status: "completed",
      statusCode: 202,
    });
  });
});

describe("POST /api/settlements/execute — replay", () => {
  it("replays the cached status and payload on a retry", async () => {
    const first = await execute(body, { [IDEMPOTENCY_HEADER]: "key-1" });
    expect(first.statusCode).toBe(202);

    prisma.settlement.updateMany.mockClear();

    const second = await execute(body, { [IDEMPOTENCY_HEADER]: "key-1" });

    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual(first.json());
    expect(second.headers["idempotent-replay"]).toBe("true");
    // The whole point: no second build, no second submission.
    expect(prisma.settlement.updateMany).not.toHaveBeenCalled();
  });

  it("replays the original status code rather than a fresh one", async () => {
    // First call accepts the submission and answers 202.
    const first = await execute(body, { [IDEMPOTENCY_HEADER]: "key-1" });
    expect(first.statusCode).toBe(202);

    // The settlement is now "submitted", so a fresh execution would answer
    // 200. A retry must still see 202 — the status the first attempt sent.
    const second = await execute(body, { [IDEMPOTENCY_HEADER]: "key-1" });

    expect(second.statusCode).toBe(202);
  });

  it("does not mark a replayed response as freshly executed", async () => {
    await execute(body, { [IDEMPOTENCY_HEADER]: "key-1" });
    const updateCalls = prisma.idempotencyKey.update.mock.calls.length;

    await execute(body, { [IDEMPOTENCY_HEADER]: "key-1" });

    // A replay must not re-record: it did not produce a new response.
    expect(prisma.idempotencyKey.update.mock.calls.length).toBe(updateCalls);
  });

  it("keys are scoped per user, so another caller cannot replay a response", async () => {
    await execute(body, { [IDEMPOTENCY_HEADER]: "key-1" });

    const otherToken = signToken({
      id: "user_9",
      stellarPublicKey: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    });
    prisma.groupMember.findUnique.mockResolvedValue(null);

    const response = await execute(body, {
      authorization: `Bearer ${otherToken}`,
      [IDEMPOTENCY_HEADER]: "key-1",
    });

    // Rejected on membership, never by replaying the first user's response.
    expect(response.statusCode).not.toBe(202);
    expect(response.headers["idempotent-replay"]).toBeUndefined();
  });
});

describe("POST /api/settlements/execute — payload binding", () => {
  it("rejects the same key sent with a different payload", async () => {
    await execute(body, { [IDEMPOTENCY_HEADER]: "key-1" });

    const response = await execute(
      { ...body, signedXdr: "AAAA-a-different-envelope" },
      { [IDEMPOTENCY_HEADER]: "key-1" }
    );

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("treats a reordered but equivalent body as the same request", async () => {
    const first = await execute(body, { [IDEMPOTENCY_HEADER]: "key-1" });

    const second = await execute(
      { signedXdr: body.signedXdr, settlementId: body.settlementId },
      { [IDEMPOTENCY_HEADER]: "key-1" }
    );

    expect(second.statusCode).toBe(first.statusCode);
    expect(second.headers["idempotent-replay"]).toBe("true");
  });

  it("lets a different key execute the same payload independently", async () => {
    await execute(body, { [IDEMPOTENCY_HEADER]: "key-1" });

    const response = await execute(body, { [IDEMPOTENCY_HEADER]: "key-2" });

    // Already submitted, so the route reports the current state rather than
    // re-submitting — the settlement's own guard, independent of the key.
    expect(response.statusCode).toBe(200);
    expect(response.json().settlement.status).toBe("submitted");
  });
});

describe("POST /api/settlements/execute — concurrency", () => {
  it("runs exactly one execution for two simultaneous duplicate requests", async () => {
    // Hold the transaction open until both requests have passed reservation,
    // so the second is guaranteed to arrive while the first is in_progress.
    let release: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    let entered = 0;
    prisma.$transaction.mockImplementation(async (fn: any) => {
      entered += 1;
      if (entered === 1) await gate;
      return fn(prisma);
    });

    const first = execute(body, { [IDEMPOTENCY_HEADER]: "race-key" });
    // Yield so the first request reaches the gate before the second starts.
    await new Promise((resolve) => setImmediate(resolve));
    const second = execute(body, { [IDEMPOTENCY_HEADER]: "race-key" });

    const secondResponse = await second;
    release!();
    const firstResponse = await first;

    expect(firstResponse.statusCode).toBe(202);
    expect(secondResponse.statusCode).toBe(409);
    expect(secondResponse.json().code).toBe("IDEMPOTENCY_IN_PROGRESS");
    expect(entered).toBe(1);
    expect(prisma.settlement.updateMany).toHaveBeenCalledTimes(1);
  });

  it("returns 409 while a reservation is still in progress", async () => {
    rows.set(`${USER_ID}|settlement.execute|key-1`, {
      userId: USER_ID,
      scope: "settlement.execute",
      key: "key-1",
      // Matches the hash the plugin computes for this body.
      requestHash: await hashOf(body),
      status: "in_progress",
      statusCode: null,
      responseJson: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const response = await execute(body, { [IDEMPOTENCY_HEADER]: "key-1" });

    expect(response.statusCode).toBe(409);
    expect(prisma.settlement.updateMany).not.toHaveBeenCalled();
  });

  it("re-claims a reservation abandoned by a crashed process", async () => {
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    rows.set(`${USER_ID}|settlement.execute|key-1`, {
      userId: USER_ID,
      scope: "settlement.execute",
      key: "key-1",
      requestHash: await hashOf(body),
      status: "in_progress",
      statusCode: null,
      responseJson: null,
      createdAt: stale,
      updatedAt: stale,
    });

    const response = await execute(body, { [IDEMPOTENCY_HEADER]: "key-1" });

    expect(response.statusCode).toBe(202);
    expect(prisma.settlement.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/settlements/execute — failure handling", () => {
  it("marks the key failed so the client may retry it", async () => {
    prisma.settlement.findUnique.mockResolvedValue(null);

    const failed = await execute(body, { [IDEMPOTENCY_HEADER]: "key-1" });
    expect(failed.statusCode).toBe(404);

    const row = rows.get(`${USER_ID}|settlement.execute|key-1`);
    expect(row.status).toBe("failed");
    expect(row.responseJson).toBeNull();

    // The same key now runs again rather than replaying the 404.
    stageSubmittableSettlement();
    const retried = await execute(body, { [IDEMPOTENCY_HEADER]: "key-1" });
    expect(retried.statusCode).toBe(202);
  });

  it("does not reserve an execution whose envelope fails validation", async () => {
    (validateSettlementXdr as any).mockImplementation(() => {
      throw new Error("XDR does not match the authorized settlement");
    });

    const response = await execute(body, { [IDEMPOTENCY_HEADER]: "key-1" });

    expect(response.statusCode).toBe(500);
    expect(prisma.settlement.updateMany).not.toHaveBeenCalled();

    const row = rows.get(`${USER_ID}|settlement.execute|key-1`);
    expect(row.status).toBe("failed");
  });

  it("refuses execution by anyone other than the payer", async () => {
    prisma.settlement.findUnique.mockResolvedValue(
      settlement({ fromUserId: "user_2" })
    );

    const response = await execute(body, { [IDEMPOTENCY_HEADER]: "key-1" });

    expect(response.statusCode).toBe(403);
    expect(prisma.settlement.updateMany).not.toHaveBeenCalled();
  });

  it("reports the current state instead of re-submitting a completed settlement", async () => {
    const done = settlement({ status: "completed" });
    prisma.settlement.findUnique.mockResolvedValue(done);
    prisma.settlement.findUniqueOrThrow.mockResolvedValue(done);

    const response = await execute(body, { [IDEMPOTENCY_HEADER]: "key-1" });

    expect(response.statusCode).toBe(200);
    expect(response.json().settlement.status).toBe("completed");
    expect(prisma.settlement.updateMany).not.toHaveBeenCalled();
  });
});

describe("idempotency reservations expire", () => {
  it("stores an expiry so reservations do not accumulate forever", async () => {
    const before = Date.now();
    await execute(body, { [IDEMPOTENCY_HEADER]: "key-1" });

    const row = rows.get(`${USER_ID}|settlement.execute|key-1`);
    const ttl = row.expiresAt.getTime() - before;

    expect(ttl).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000);
  });
});

/** The plugin's own hash, so tests bind keys the way the route does. */
async function hashOf(payload: unknown): Promise<string> {
  const { hashRequestBody } = await import("../src/plugins/idempotency");
  return hashRequestBody("settlement.execute", payload);
}
