import { describe, expect, it, vi } from "vitest";
import { connectWithRetry, isRetryableConnectError } from "../src/lib/db-connect";

const policy = { maxAttempts: 4, initialDelayMs: 100, maxDelayMs: 1_000, jitterRatio: 0 };

function prismaError(errorCode: string, message = "connect failed") {
  return Object.assign(new Error(message), { errorCode });
}

function setup(...results: Array<Error | null>) {
  const client = { $connect: vi.fn() };
  for (const r of results) {
    if (r) client.$connect.mockRejectedValueOnce(r);
    else client.$connect.mockResolvedValueOnce(undefined);
  }
  const sleep = vi.fn(async () => {});
  const logger = { warn: vi.fn(), info: vi.fn() };
  return { client, sleep, logger };
}

describe("connectWithRetry", () => {
  it("connects on the first attempt without sleeping", async () => {
    const { client, sleep, logger } = setup(null);

    await connectWithRetry(client, { policy, sleep, logger });

    expect(client.$connect).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith({ attempt: 1 }, "database connected");
  });

  it("retries an unreachable database with exponential backoff", async () => {
    const down = prismaError("P1001", "Can't reach database server");
    const { client, sleep, logger } = setup(down, down, null);

    await connectWithRetry(client, { policy, sleep, logger });

    expect(client.$connect).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200]);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("caps the delay at maxDelayMs", async () => {
    const down = new Error("ECONNREFUSED");
    const { client, sleep } = setup(down, down, down, null);

    await connectWithRetry(client, {
      policy: { ...policy, initialDelayMs: 400, maxDelayMs: 1_000 },
      sleep,
    });

    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([400, 800, 1_000]);
  });

  it("gives up after maxAttempts and rethrows the last error", async () => {
    const down = prismaError("P1001");
    const { client, sleep, logger } = setup(down, down, down, down);

    await expect(connectWithRetry(client, { policy, sleep, logger })).rejects.toBe(down);

    expect(client.$connect).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenLastCalledWith(
      expect.objectContaining({ attempt: 4, retryable: true }),
      "database connection failed; giving up"
    );
  });

  it("does not retry an authentication failure", async () => {
    const auth = prismaError("P1000", "Authentication failed");
    const { client, sleep } = setup(auth);

    await expect(connectWithRetry(client, { policy, sleep })).rejects.toBe(auth);

    expect(client.$connect).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("never logs the connection string", async () => {
    const down = new Error(
      "Can't reach database server at postgresql://admin:hunter2@db.internal:5432/mergepay"
    );
    const { client, sleep, logger } = setup(down, null);

    await connectWithRetry(client, { policy, sleep, logger });

    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("hunter2");
  });
});

describe("isRetryableConnectError", () => {
  it.each([
    ["P1001", true],
    ["P1002", true],
    ["P1000", false],
    ["P1010", false],
    ["P1012", false],
  ])("%s → %s", (code, expected) => {
    expect(isRetryableConnectError(prismaError(code))).toBe(expected);
  });

  it("retries errors without a Prisma code", () => {
    expect(isRetryableConnectError(new Error("ECONNREFUSED"))).toBe(true);
  });
});
