/**
 * Issue #660 — the `logAction(...)` Prisma repository helper for audit logging.
 *
 * `src/services/audit.ts` owns the durable `audit_logs` writes. `logAction`
 * is the issue-shaped entry point: it names the actor, action type, target
 * resource, and metadata, and maps them onto the persisted columns
 * (`user_id`, `action`, `entity_type`/`entity_id`, `metadata`) inside the
 * caller's chosen transaction (or its own, when no transaction is supplied).
 *
 * These tests pin that mapping, the metadata sanitization, the best-effort
 * versus transactional failure contract, and the structured Pino mirror so a
 * refactor of any of them is a visible contract change.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  prisma: {
    auditLog: { create: vi.fn() },
  },
  emitAuditEvent: vi.fn(),
}));

vi.mock("../../src/db", () => ({ prisma: h.prisma }));

// Keep the real sanitizer, replace only the stream emitter so the test
// observes the mirror without writing Pino lines to stdout.
vi.mock("../../src/lib/audit-logger", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/audit-logger")>();
  return { ...actual, emitAuditEvent: h.emitAuditEvent };
});

import {
  logAction,
  logActionTx,
  type LogActionParams,
} from "../../src/services/audit";
import { AUDIT_REDACTED } from "../../src/lib/audit-logger";

const prisma = h.prisma;

/** A minimal fake Prisma transaction client; only `auditLog.create` is used. */
function fakeTx() {
  return { auditLog: { create: vi.fn(async () => ({ id: "audit_tx" })) } };
}

const groupCreate: LogActionParams = {
  actorId: "user_1",
  groupId: "group_1",
  actorType: "user",
  action: "group.create",
  resourceType: "group",
  resourceId: "group_1",
  outcome: "success",
  metadata: { name: "Trip to Lisbon" },
};

beforeEach(() => {
  vi.clearAllMocks();
  prisma.auditLog.create.mockResolvedValue({ id: "audit_1" });
});

describe("logAction — durable audit-log repository helper (#660)", () => {
  it("persists actor, action, resource, and metadata to audit_logs", async () => {
    await logAction(groupCreate);

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const { data } = prisma.auditLog.create.mock.calls[0][0];
    expect(data).toMatchObject({
      userId: "user_1",
      groupId: "group_1",
      action: "group.create",
      entityType: "group",
      entityId: "group_1",
    });
    // Outcome and actor type ride in metadata, as the writer has always done.
    expect(data.metadata).toMatchObject({
      name: "Trip to Lisbon",
      outcome: "success",
      actorType: "user",
    });
  });

  it("defaults actor and group to null for system/worker actions", async () => {
    await logAction({
      actorType: "system",
      action: "worker.task.dead_letter",
      resourceType: "worker_task",
      resourceId: "cleanupChallenges",
    });

    const { data } = prisma.auditLog.create.mock.calls[0][0];
    expect(data.userId).toBeNull();
    expect(data.groupId).toBeNull();
  });

  it("records a public actor key but redacts secret material in metadata", async () => {
    await logAction({
      actorId: "user_1",
      actorPublicKey: "GABC...PUBLIC",
      groupId: "group_1",
      action: "treasury.tx_proposal.created",
      resourceType: "treasury_tx_proposal",
      resourceId: "proposal_1",
      metadata: {
        description: "March rent",
        privateKey: "S-SECRET-KEY",
        token: "bearer-token",
        signedXdr: "AAAA-signed-envelope",
      },
    });

    const { data } = prisma.auditLog.create.mock.calls[0][0];
    expect(data.metadata.actorPublicKey).toBe("GABC...PUBLIC");
    expect(data.metadata.description).toBe("March rent");
    expect(data.metadata.privateKey).toBe(AUDIT_REDACTED);
    expect(data.metadata.token).toBe(AUDIT_REDACTED);
    expect(data.metadata.signedXdr).toBe(AUDIT_REDACTED);
  });

  it("mirrors each write to the structured audit-event logger", async () => {
    await logAction(groupCreate);

    expect(h.emitAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "group.create",
        userId: "user_1",
        groupId: "group_1",
        entityType: "group",
        entityId: "group_1",
        outcome: "success",
      })
    );
  });

  it("is best-effort: a failing audit store never fails the audited operation", async () => {
    prisma.auditLog.create.mockRejectedValueOnce(new Error("database down"));

    await expect(logAction(groupCreate)).resolves.toBeUndefined();

    // The loss is still surfaced to operators as a failure audit event.
    expect(h.emitAuditEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        outcome: "failure",
        metadata: expect.objectContaining({ audit_write_failed: true }),
      })
    );
  });
});

describe("logActionTx — atomic audit writes inside a transaction (#660)", () => {
  it("writes through the caller's transaction client, not the global one", async () => {
    const tx = fakeTx();

    await logActionTx(tx, {
      ...groupCreate,
      action: "group.join",
      metadata: { inviteId: "invite_1" },
    });

    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();

    const { data } = tx.auditLog.create.mock.calls[0][0];
    expect(data).toMatchObject({
      userId: "user_1",
      groupId: "group_1",
      action: "group.join",
      entityType: "group",
      entityId: "group_1",
    });
  });

  it("propagates a write failure so the surrounding transaction rolls back", async () => {
    const tx = fakeTx();
    tx.auditLog.create.mockRejectedValueOnce(new Error("audit write failed"));

    await expect(logActionTx(tx, groupCreate)).rejects.toThrow(
      "audit write failed"
    );
  });
});
