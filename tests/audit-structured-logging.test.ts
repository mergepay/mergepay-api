/**
 * Structured audit logging for state-changing operations.
 *
 * Covers the dedicated Pino audit-event utility (src/lib/audit-logger.ts):
 *
 *  1. Standardized schema — actor / action / target / timestamp on every line,
 *     plus groupId, outcome, and metadata.
 *  2. Sensitive-data exclusion — private keys, tokens, signed XDRs are
 *     redacted (and never appear verbatim anywhere in the output).
 *  3. Best-effort delivery — a logging failure never throws into the request
 *     path, and audit()/auditTx() still persist the durable row.
 *  4. Route integration — POST /groups emits a structured audit event with the
 *     standardized fields during a real mutation flow.
 *
 * The durable Prisma behavior of audit()/auditTx() itself is covered by
 * tests/audit-logging.test.ts, tests/audit-events.test.ts and
 * tests/expense-action-audit.test.ts; here the assertions are about the
 * *structured log lines* those writes mirror.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import pino from "pino";
import { Keypair } from "@stellar/stellar-sdk";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(async () => ({ id: "audit_1" })),
    createMany: vi.fn(async () => ({})),
    findUnique: vi.fn(async () => null),
    findFirst: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
    update: vi.fn(async () => ({})),
    updateMany: vi.fn(async () => ({ count: 0 })),
    upsert: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
    deleteMany: vi.fn(async () => ({ count: 0 })),
    count: vi.fn(async () => 0),
  });
  const prisma: any = {
    user: model(),
    group: model(),
    groupMember: model(),
    expense: model(),
    expenseShare: model(),
    settlement: model(),
    treasuryTransaction: model(),
    invite: model(),
    invitation: model(),
    anchorSession: model(),
    auditLog: model(),
    statusHistory: model(),
    idempotencyKey: model(),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $disconnect: vi.fn(),
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

import { buildApp } from "../src/app";
import { signToken } from "../src/plugins/auth";
import {
  emitAuditEvent,
  sanitizeAuditMetadata,
  AUDIT_REDACTED,
  AUDIT_REDACTED_KEYS,
  setAuditEventLogger,
} from "../src/lib/audit-logger";
import { audit, auditTx } from "../src/services/audit";
import type pinoTypes from "pino";

const prisma = h.prisma;

/** Capture the structured lines emitted to a destination stream. */
function captureLogger(): { logger: pinoTypes.Logger; lines: () => any[] } {
  const lines: any[] = [];
  const logger = pino(
    { level: "info" },
    {
      write(chunk: string) {
        try {
          lines.push(JSON.parse(chunk));
        } catch {
          // ignore non-JSON chunks
        }
      },
    } as any
  );
  return { logger, lines: () => lines };
}

/** Only audit-event lines (the schema under test), not unrelated output. */
function auditLines(all: any[]): any[] {
  return all.filter((line) => line.event === "audit");
}

describe("sanitizeAuditMetadata", () => {
  it("redacts sensitive keys at the top level", () => {
    const out = sanitizeAuditMetadata({
      amount: "50",
      privateKey: "SABC...",
      token: "eyJhbGci...",
      signedXdr: "AAAA...",
    }) as Record<string, unknown>;
    expect(out.amount).toBe("50");
    expect(out.privateKey).toBe(AUDIT_REDACTED);
    expect(out.token).toBe(AUDIT_REDACTED);
    expect(out.signedXdr).toBe(AUDIT_REDACTED);
  });

  it("redacts case-insensitively", () => {
    const out = sanitizeAuditMetadata({
      PrivateKey: "SABC...",
      SECRET: "hunter2",
      TransactionXDR: "AAAA...",
    }) as Record<string, unknown>;
    expect(Object.values(out)).toEqual([
      AUDIT_REDACTED,
      AUDIT_REDACTED,
      AUDIT_REDACTED,
    ]);
  });

  it("redacts inside nested objects and arrays", () => {
    const out = sanitizeAuditMetadata({
      nested: { deep: { authorization: "Bearer abc" } },
      list: [{ secret: "s" }, { ok: 1 }],
    }) as any;
    expect(out.nested.deep.authorization).toBe(AUDIT_REDACTED);
    expect(out.list[0].secret).toBe(AUDIT_REDACTED);
    expect(out.list[1]).toEqual({ ok: 1 });
  });

  it("keeps the field shape, replacing values with [REDACTED]", () => {
    const out = sanitizeAuditMetadata({ sessionToken: "t", memo: "hello" }) as any;
    expect(out.sessionToken).toBe(AUDIT_REDACTED);
    expect(out.memo).toBe("hello");
    expect(Object.keys(out)).toEqual(["sessionToken", "memo"]);
  });

  it("leaves safe scalars, dates, and nulls untouched", () => {
    const when = new Date("2026-01-01T00:00:00.000Z");
    const out = sanitizeAuditMetadata({
      amount: "10.0000000",
      when,
      note: null,
      count: 3,
    }) as any;
    expect(out.amount).toBe("10.0000000");
    expect(out.when).toBe(when);
    expect(out.note).toBeNull();
    expect(out.count).toBe(3);
  });

  it("covers every key material to a financial system must never log", () => {
    for (const key of [
      "privatekey",
      "secretkey",
      "signedxdr",
      "transactionxdr",
      "xdr",
      "token",
      "jwt",
      "authorization",
      "cookie",
      "password",
      "secret",
      "seed",
      "mnemonic",
      "accesstoken",
      "refreshtoken",
    ]) {
      expect(AUDIT_REDACTED_KEYS.has(key), `missing key: ${key}`).toBe(true);
    }
  });

  it("never leaks a sensitive value even when nested under an unknown wrapper key", () => {
    // Redaction is by key name; values under unknown keys pass through — so
    // callers must only pass safe values. This asserts the contract that
    // sensitive keys are always replaced with [REDACTED] in output.
    const out = sanitizeAuditMetadata({
      privateKey: "SAAA-DANGER",
      metadata: { privateKey: "SAAA-DANGER-2" },
    });
    expect(JSON.stringify(out)).not.toContain("SAAA-DANGER");
  });
});

describe("emitAuditEvent — standardized schema", () => {
  afterEach(() => setAuditEventLogger(null));

  it("emits actor, action, target, and timestamp on every line", () => {
    const { logger, lines } = captureLogger();
    setAuditEventLogger(logger);

    emitAuditEvent({
      action: "group.create",
      actorType: "user",
      userId: "user_1",
      entityType: "group",
      entityId: "group_1",
      groupId: "group_1",
      outcome: "success",
      metadata: { name: "Test" },
    });

    const [line] = auditLines(lines());
    expect(line).toBeDefined();
    expect(line.event).toBe("audit");
    expect(line.action).toBe("group.create");
    expect(line.actor).toEqual({ type: "user", id: "user_1" });
    expect(line.target).toEqual({ type: "group", id: "group_1" });
    expect(typeof line.timestamp).toBe("string");
    expect(Number.isNaN(Date.parse(line.timestamp))).toBe(false);
    expect(line.groupId).toBe("group_1");
    expect(line.outcome).toBe("success");
    expect(line.metadata).toEqual({ name: "Test" });
    // Pino's own epoch-ms time is present too.
    expect(typeof line.time).toBe("number");
  });

  it("defaults actorType to 'user' when a userId is given, 'system' otherwise", () => {
    const { logger, lines } = captureLogger();
    setAuditEventLogger(logger);

    emitAuditEvent({
      action: "settlement.confirmed",
      userId: "user_1",
      entityType: "settlement",
      entityId: "s_1",
    });
    emitAuditEvent({
      action: "settlement.reconciled",
      entityType: "settlement",
      entityId: "s_2",
    });

    const events = auditLines(lines());
    expect(events[0].actor).toEqual({ type: "user", id: "user_1" });
    expect(events[1].actor).toEqual({ type: "system" });
  });

  it("redacts sensitive metadata before writing the line", () => {
    const { logger, lines } = captureLogger();
    setAuditEventLogger(logger);

    emitAuditEvent({
      action: "treasury.deposit.create",
      userId: "user_1",
      entityType: "treasury_transaction",
      entityId: "ttx_1",
      metadata: { amount: "25", signedXdr: "AAAA-TOP-SECRET", token: "jwt-value" },
    });

    const [line] = auditLines(lines());
    expect(line.metadata.signedXdr).toBe(AUDIT_REDACTED);
    expect(line.metadata.token).toBe(AUDIT_REDACTED);
    expect(line.metadata.amount).toBe("25");
    expect(JSON.stringify(line)).not.toContain("AAAA-TOP-SECRET");
    expect(JSON.stringify(line)).not.toContain("jwt-value");
  });

  it("swallows logger failures so auditing never breaks the audited operation", () => {
    const throwing = pino(
      { level: "info" },
      {
        write() {
          throw new Error("sink exploded");
        },
      } as any
    );
    setAuditEventLogger(throwing);

    expect(() =>
      emitAuditEvent({
        action: "group.member_remove",
        entityType: "group",
        entityId: "group_1",
      })
    ).not.toThrow();
  });
});

describe("audit() / auditTx() structured telemetry", () => {
  afterEach(() => setAuditEventLogger(null));

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.auditLog.create.mockResolvedValue({ id: "audit_1" });
  });

  it("audit() persists the durable row and emits one structured line", async () => {
    const { logger, lines } = captureLogger();
    setAuditEventLogger(logger);

    await audit({
      userId: "user_1",
      groupId: "group_1",
      action: "expense.create",
      entityType: "expense",
      entityId: "exp_1",
      metadata: { amount: "50", assetCode: "XLM" },
    });

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const rows = auditLines(lines());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: "audit",
      action: "expense.create",
      actor: { type: "user", id: "user_1" },
      target: { type: "expense", id: "exp_1" },
      groupId: "group_1",
      outcome: "success",
    });
  });

  it("auditTx() emits the same structured line for transactional writes", async () => {
    const { logger, lines } = captureLogger();
    setAuditEventLogger(logger);

    await auditTx(prisma as any, {
      userId: "user_2",
      groupId: "group_1",
      action: "settlement.confirm",
      entityType: "settlement",
      entityId: "s_1",
      metadata: { status: "submitted" },
    });

    const rows = auditLines(lines());
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("settlement.confirm");
    expect(rows[0].actor).toEqual({ type: "user", id: "user_2" });
    expect(rows[0].target).toEqual({ type: "settlement", id: "s_1" });
  });

  it("emits a failure-outcome line when the durable write fails", async () => {
    const { logger, lines } = captureLogger();
    setAuditEventLogger(logger);
    prisma.auditLog.create.mockRejectedValueOnce(new Error("db down"));

    await expect(
      audit({
        userId: "user_1",
        action: "group.join",
        entityType: "group",
        entityId: "group_1",
      })
    ).resolves.toBeUndefined();

    const rows = auditLines(lines());
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("failure");
    expect(rows[0].metadata).toMatchObject({
      audit_write_failed: true,
      reason: "db down",
    });
  });

  it("keeps sensitive metadata out of the durable row as well", async () => {
    await audit({
      userId: "user_1",
      action: "treasury.proposal.signed",
      entityType: "treasury_proposal",
      entityId: "prop_1",
      metadata: { privateKey: "SABC", threshold: 2 },
    });

    const data = prisma.auditLog.create.mock.calls[0][0].data;
    expect(data.metadata.privateKey).toBe(AUDIT_REDACTED);
    expect(data.metadata.threshold).toBe(2);
  });
});

describe("route integration — POST /groups emits a structured audit event", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  const admin = {
    id: "user_admin",
    stellarPublicKey: Keypair.random().publicKey(),
    displayName: "Admin",
    avatarUrl: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  function authHeader() {
    const token = signToken({
      id: admin.id,
      stellarPublicKey: admin.stellarPublicKey,
    });
    return { authorization: `Bearer ${token}` };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    if (!app) app = await buildApp();
  });

  afterEach(() => setAuditEventLogger(null));

  it("creates the group, writes the audit row, and emits one standardized line", async () => {
    prisma.group.create.mockResolvedValueOnce({
      id: "group_new",
      name: "Test",
      createdByUserId: admin.id,
      createdAt: new Date(),
    });

    const { logger, lines } = captureLogger();
    setAuditEventLogger(logger);

    const res = await app.inject({
      method: "POST",
      url: "/groups",
      headers: authHeader(),
      payload: { name: "Test" },
    });

    expect(res.statusCode).toBe(200);

    // Durable record — actor, action, target resource.
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: admin.id,
          action: "group.create",
          entityType: "group",
          entityId: "group_new",
        }),
      })
    );

    // Structured telemetry — same standardized fields.
    const rows = auditLines(lines());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: "audit",
      action: "group.create",
      actor: { type: "user", id: admin.id },
      target: { type: "group", id: "group_new" },
      groupId: "group_new",
      outcome: "success",
      metadata: { name: "Test" },
    });
    expect(typeof rows[0].timestamp).toBe("string");
  });

  it("emits no audit event when the mutation is rejected", async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    const { logger, lines } = captureLogger();
    setAuditEventLogger(logger);

    await app.inject({
      method: "POST",
      url: "/groups",
      headers: authHeader(),
      payload: { name: "" },
    });

    expect(auditLines(lines())).toHaveLength(0);
  });
});
