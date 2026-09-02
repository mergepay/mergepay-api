import { describe, it, expect, vi } from "vitest";
import { createShutdownCoordinator } from "../src/lib/shutdown";

describe("createShutdownCoordinator", () => {
  it("runs the cleanup once when begin is called more than once", async () => {
    const cleanup = vi.fn(async () => undefined);
    const coordinator = createShutdownCoordinator({ name: "test", timeoutMs: 1000 });

    coordinator.begin("SIGTERM", cleanup);
    coordinator.begin("SIGINT", cleanup); // repeated signal — must not re-run cleanup

    await coordinator.done;
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("resolves done and calls onComplete after a successful cleanup", async () => {
    const onComplete = vi.fn();
    const cleanup = vi.fn(async () => undefined);
    const coordinator = createShutdownCoordinator({
      name: "test",
      timeoutMs: 1000,
      onComplete,
    });

    coordinator.begin("SIGTERM", cleanup);

    await coordinator.done;
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("resolves done before the deadline when cleanup is fast", async () => {
    const onTimeout = vi.fn();
    const coordinator = createShutdownCoordinator({
      name: "test",
      timeoutMs: 1000,
      onTimeout,
    });

    coordinator.begin("SIGTERM", async () => undefined);
    await coordinator.done;
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("force-times-out a cleanup that never finishes and calls onTimeout", async () => {
    const onTimeout = vi.fn();
    const coordinator = createShutdownCoordinator({
      name: "test",
      timeoutMs: 20,
      onTimeout,
    });

    // Simulates a stuck dependency: the cleanup promise never settles.
    coordinator.begin("SIGTERM", () => new Promise<void>(() => undefined));

    await coordinator.done;
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("treats a throwing cleanup as a failure and calls onTimeout", async () => {
    const onTimeout = vi.fn();
    const onComplete = vi.fn();
    const coordinator = createShutdownCoordinator({
      name: "test",
      timeoutMs: 1000,
      onTimeout,
      onComplete,
    });

    coordinator.begin("SIGTERM", async () => {
      throw new Error("prisma disconnect hung");
    });

    await coordinator.done;
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("logs the process name and signal in each phase", async () => {
    const logger: any = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const coordinator = createShutdownCoordinator({
      name: "test",
      logger,
      timeoutMs: 1000,
    });

    coordinator.begin("SIGTERM", async () => undefined);
    await coordinator.done;

    const infoCalls = logger.info.mock.calls.map((c: any[]) => c[0]);
    expect(infoCalls).toContainEqual(
      expect.objectContaining({ signal: "SIGTERM", phase: "start" })
    );
    expect(infoCalls).toContainEqual(
      expect.objectContaining({ signal: "SIGTERM", phase: "complete" })
    );
  });
});
