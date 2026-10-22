/**
 * Issue #676 — actor attribution for background-job audit records.
 *
 * The audit trail answers "who changed this". Until now the answer for a
 * worker's change was wrong: no production caller passed `actorType`, so the
 * logger inferred it from `userId` — and a worker that records the row owner
 * in `userId` (a settlement's payer, a proposal's creator, a treasury row's
 * user) produced an event saying *that user* performed it. `src/worker/`'s own
 * `source: "worker"` metadata was the only hint, and it is free-form: nothing
 * filters on it.
 *
 * The contract pinned here:
 *
 *   1. `actor.type` names the principal that acted. A user id appears in it
 *      only when the actor really is that user; the row's owner stays in the
 *      durable `userId` column and in metadata.
 *   2. A transition service that can be driven from either side derives the
 *      actor from the transition's own `source`, so the request path and the
 *      worker cannot drift apart.
 *   3. Every audit write inside the worker process names its actor explicitly
 *      — enforced by scanning the sources, so a new sweep cannot reintroduce
 *      the ambiguity.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(async () => ({ id: "audit_1" })),
    createMany: vi.fn(async () => ({})),
    findUnique: vi.fn(async () => null),
    findUniqueOrThrow: vi.fn(async () => ({})),
    findFirst: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
    update: vi.fn(async () => ({})),
    updateMany: vi.fn(async () => ({ count: 1 })),
    upsert: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
    deleteMany: vi.fn(async () => ({ count: 0 })),
    count: vi.fn(async () => 0),
  });
  const prisma: any = {
    settlement: model(),
    expenseShare: model(),
    anchorSession: model(),
    withdrawal: model(),
    treasuryProposal: model(),
    statusHistory: model(),
    auditLog: model(),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $disconnect: vi.fn(),
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

import {
  emitAuditEvent,
  setAuditEventLogger,
} from "../src/lib/audit-logger";
import { applySettlementTransition } from "../src/services/settlement-machine";
import { applyAnchorSessionTransition } from "../src/services/anchor-status";
import { applyWithdrawalTransition } from "../src/services/withdrawal-status";
import { expireStaleProposals } from "../src/worker/cleanupProposals";

const prisma = h.prisma;

/** Capture the structured lines emitted to a destination stream. */
function captureLogger(): { logger: pino.Logger; lines: () => any[] } {
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

/** The audit-event lines emitted since the capture started. */
function auditLines(all: any[]): any[] {
  return all.filter((line) => line.event === "audit");
}

/** The `data` object of the single audit row written. */
function auditRowData(): any {
  expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  return prisma.auditLog.create.mock.calls[0][0].data;
}

const fakeSettlement = (over: Record<string, any> = {}) => ({
  id: "settle_1",
  groupId: "group_1",
  fromUserId: "payer_1",
  toUserId: "payee_1",
  status: "verifying",
  retryCount: 0,
  expenseShareId: null,
  ...over,
});

const fakeSession = (over: Record<string, any> = {}) => ({
  id: "session_1",
  userId: "user_1",
  groupId: "group_1",
  status: "pending_anchor",
  ...over,
});

const fakeWithdrawal = (over: Record<string, any> = {}) => ({
  id: "wd_1",
  userId: "user_1",
  groupId: "group_1",
  status: "pending",
  ...over,
});

let capture: { logger: pino.Logger; lines: () => any[] };

beforeEach(() => {
  vi.clearAllMocks();
  capture = captureLogger();
  setAuditEventLogger(capture.logger);
});

afterEach(() => {
  // Back to the lazily-created default destination so no other suite inherits
  // this one's stream.
  setAuditEventLogger(null);
});

describe("emitAuditEvent — actor names the principal that acted (#676)", () => {
  it("keeps a worker's actor free of the record owner's id", () => {
    emitAuditEvent({
      action: "settlement.status_changed",
      actorType: "worker",
      userId: "payer_1",
      entityType: "settlement",
      entityId: "settle_1",
    });

    // The user did not do this, so `actor.id` must not name them — that is the
    // whole difference between "who changed it" and "whose record it is".
    expect(auditLines(capture.lines())[0].actor).toEqual({ type: "worker" });
  });

  it("keeps attributing a user's own action to them", () => {
    emitAuditEvent({
      action: "group.create",
      actorType: "user",
      userId: "user_1",
      entityType: "group",
      entityId: "group_1",
    });

    expect(auditLines(capture.lines())[0].actor).toEqual({
      type: "user",
      id: "user_1",
    });
  });

  it("still infers the actor from the user id when no type is given", () => {
    emitAuditEvent({
      action: "expense.create",
      userId: "user_1",
      entityType: "expense",
      entityId: "exp_1",
    });

    expect(auditLines(capture.lines())[0].actor).toEqual({
      type: "user",
      id: "user_1",
    });
  });
});

describe("settlement transitions derive the actor from their source (#676)", () => {
  beforeEach(() => {
    // The machine re-reads the row before and writes-then-reads after.
    prisma.settlement.findUnique.mockResolvedValue(fakeSettlement());
    prisma.settlement.findUniqueOrThrow.mockResolvedValue(
      fakeSettlement({ status: "confirmed" })
    );
    prisma.settlement.updateMany.mockResolvedValue({ count: 1 });
  });

  it("attributes a worker's confirmation to the worker, not the payer", async () => {
    await applySettlementTransition({
      settlementId: "settle_1",
      nextStatus: "confirmed",
      source: "worker",
    });

    const data = auditRowData();
    // The durable row still links the settlement's owner, so per-user queries
    // keep working; only the *actor* changes.
    expect(data.userId).toBe("payer_1");
    expect(data.metadata.actorType).toBe("worker");

    const line = auditLines(capture.lines())[0];
    expect(line.action).toBe("settlement.status_changed");
    expect(line.actor).toEqual({ type: "worker" });
    expect(line.target).toEqual({ type: "settlement", id: "settle_1" });
  });

  it("attributes a user's own submission to that user", async () => {
    prisma.settlement.findUnique.mockResolvedValue(
      fakeSettlement({ status: "pending" })
    );
    prisma.settlement.findUniqueOrThrow.mockResolvedValue(
      fakeSettlement({ status: "submitted" })
    );

    await applySettlementTransition({
      settlementId: "settle_1",
      nextStatus: "submitted",
      source: "user",
    });

    expect(auditRowData().metadata.actorType).toBe("user");
    expect(auditLines(capture.lines())[0].actor).toEqual({
      type: "user",
      id: "payer_1",
    });
  });
});

describe("anchor and withdrawal transitions derive the actor (#676)", () => {
  beforeEach(() => {
    prisma.anchorSession.findUnique.mockResolvedValue(fakeSession());
    prisma.withdrawal.findUnique.mockResolvedValue(fakeWithdrawal());
  });

  it("attributes a worker poll to the worker", async () => {
    await applyAnchorSessionTransition({
      sessionId: "session_1",
      nextStatus: "completed",
      source: "poll",
    });

    expect(auditRowData().metadata.actorType).toBe("worker");
    expect(auditLines(capture.lines())[0].actor).toEqual({ type: "worker" });
  });

  it("attributes an anchor webhook to the system, not the session owner", async () => {
    await applyAnchorSessionTransition({
      sessionId: "session_1",
      nextStatus: "completed",
      source: "webhook",
    });

    expect(auditRowData().metadata.actorType).toBe("system");
    expect(auditLines(capture.lines())[0].actor).toEqual({ type: "system" });
  });

  it("attributes the interactive flow's own updates to the user", async () => {
    prisma.anchorSession.findUnique.mockResolvedValue(
      fakeSession({ status: "pending_user" })
    );

    await applyAnchorSessionTransition({
      sessionId: "session_1",
      nextStatus: "pending_anchor",
      source: "user",
    });

    expect(auditRowData().metadata.actorType).toBe("user");
    expect(auditLines(capture.lines())[0].actor).toEqual({
      type: "user",
      id: "user_1",
    });
  });

  it("attributes a withdrawal the worker observed to the worker", async () => {
    await applyWithdrawalTransition({
      withdrawalId: "wd_1",
      nextStatus: "processing",
      source: "poll",
    });

    expect(auditRowData().metadata.actorType).toBe("worker");
    expect(auditLines(capture.lines())[0].actor).toEqual({ type: "worker" });
  });
});

describe("treasury proposal expiry sweep (#676)", () => {
  it("names the worker as the actor and keeps the creator on the row", async () => {
    prisma.treasuryProposal.findMany.mockResolvedValue([
      {
        id: "prop_1",
        groupId: "group_1",
        creatorId: "creator_1",
        createdAt: new Date("2025-01-01T00:00:00.000Z"),
      },
    ]);
    prisma.treasuryProposal.updateMany.mockResolvedValue({ count: 1 });

    const { expired } = await expireStaleProposals({ now: new Date("2026-06-01T00:00:00.000Z") });

    expect(expired).toBe(1);
    const data = auditRowData();
    expect(data.userId).toBe("creator_1");
    expect(data.metadata.actorType).toBe("worker");
    // The creator never expired their own proposal; the sweep did.
    expect(auditLines(capture.lines())[0].actor).toEqual({ type: "worker" });
  });
});

describe("worker audit writes name their actor (#667/#676)", () => {
  /**
   * Files the worker process audits through. Everything under `src/worker` is
   * worker-only by construction; the named services are the shared ones it
   * reaches (verified by their importers), and each of those takes a `source`
   * it can derive the actor from.
   */
  function workerAuditSources(): { file: string; source: string }[] {
    const root = path.resolve(__dirname, "../src");
    const files: string[] = [];

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) files.push(full);
      }
    };
    walk(path.join(root, "worker"));

    files.push(
      path.join(root, "services/settlement-machine.ts"),
      path.join(root, "services/anchor-status.ts"),
      path.join(root, "services/withdrawal-status.ts"),
      path.join(root, "services/settlement-reconciliation.ts"),
      path.join(root, "services/treasuryService.ts")
    );

    return files.map((file) => ({
      file: path.relative(root, file),
      source: readFileSync(file, "utf8"),
    }));
  }

  /**
   * The argument object text of every durable audit write in a file —
   * `audit(...)`, `auditTx(...)`, `logAction(...)`, or `logActionTx(...)`.
   * The canonical `logAction*` helpers (src/services/audit.ts, issue #660)
   * persist the same rows as `audit`/`auditTx`, so the inventory counts them
   * too: a file that switches helpers is still held to naming its actor.
   */
  function auditCallArgs(source: string): string[] {
    const out: string[] = [];
    const re = /\b(?:audit|logAction)(?:Tx)?\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      const open = source.indexOf("{", match.index + match[0].length);
      if (open === -1) continue;
      // Brace-match to the end of the params object literal.
      let depth = 0;
      let i = open;
      for (; i < source.length; i += 1) {
        if (source[i] === "{") depth += 1;
        else if (source[i] === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      out.push(source.slice(open, i + 1));
    }
    return out;
  }

  /**
   * The inventory: file → how many audit writes it makes. A new worker audit
   * write has to be added here, and joining the table means passing the check
   * below — which is what keeps a future sweep from quietly re-creating the
   * ambiguity this issue is about.
   */
  const AUDIT_WRITES_BY_FILE: Record<string, number> = {
    "worker/cleanupProposals.ts": 1,
    "worker/index.ts": 3,
    "worker/reconciliation.ts": 1,
    "worker/tasks/tx-status-sync.ts": 1,
    "services/settlement-machine.ts": 1,
    "services/anchor-status.ts": 1,
    "services/withdrawal-status.ts": 1,
    "services/settlement-reconciliation.ts": 4,
    "services/treasuryService.ts": 1,
  };

  it("matches the audited-write inventory exactly", () => {
    const found: Record<string, number> = {};
    for (const { file, source } of workerAuditSources()) {
      const count = auditCallArgs(source).length;
      if (count > 0) found[file] = count;
    }
    expect(found).toEqual(AUDIT_WRITES_BY_FILE);
  });

  it("names an actor at every write in the inventory", () => {
    const offenders: string[] = [];
    for (const { file, source } of workerAuditSources()) {
      for (const args of auditCallArgs(source)) {
        if (!/\bactorType\s*:/.test(args)) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
