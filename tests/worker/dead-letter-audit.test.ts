/**
 * Issue #1184 — durable dead-letter record for worker jobs.
 *
 * `executeWorkerJobWithRetry` always logs an exhausted job at critical
 * severity, but that line is streamed and rotated away. When a caller opts in
 * with `auditDeadLetter`, the failure must also leave a queryable
 * `worker.task.dead_letter` audit row so an operator can tell which job the
 * worker gave up on and why.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  create: vi.fn(async (args: unknown) => args),
}));

vi.mock("../../src/db", () => ({
  prisma: { auditLog: { create: h.create } },
}));

import { executeWorkerJobWithRetry } from "../../src/worker/job-retry-handler";
import { AppError } from "../../src/errors";

function permanentFailure(): AppError {
  return new AppError(400, "INVALID_INTENT", "Invalid settlement intent");
}

describe("worker dead-letter audit (#1184)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists a worker.task.dead_letter row when auditDeadLetter is enabled", async () => {
    const result = await executeWorkerJobWithRetry(
      async () => {
        throw permanentFailure();
      },
      {
        taskName: "process_settlement",
        jobType: "settlement",
        jobId: "settlement_1",
        auditDeadLetter: true,
        sleep: async () => {},
      }
    );

    expect(result.success).toBe(false);
    expect(result.deadLettered).toBe(true);
    expect(h.create).toHaveBeenCalledTimes(1);

    const data = h.create.mock.calls[0][0] as {
      data: { action: string; entityType: string; entityId: string; metadata: string };
    };
    expect(data.data.action).toBe("worker.task.dead_letter");
    expect(data.data.entityType).toBe("worker_task");
    expect(data.data.entityId).toBe("settlement_1");
    const metadata = JSON.stringify(data.data.metadata);
    expect(metadata).toContain("Invalid settlement intent");
    expect(metadata).toContain("permanent");
  });

  it("writes nothing when the option is not set", async () => {
    await executeWorkerJobWithRetry(
      async () => {
        throw permanentFailure();
      },
      { taskName: "process_settlement", sleep: async () => {} }
    );

    expect(h.create).not.toHaveBeenCalled();
  });
});
