import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGracefulShutdown } from "../src/lib/graceful-shutdown";

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("createGracefulShutdown", () => {
  let logger: ReturnType<typeof makeLogger>;
  let exit: ReturnType<typeof vi.fn>;
  let currentTime: number;

  beforeEach(() => {
    vi.useFakeTimers();
    logger = makeLogger();
    exit = vi.fn();
    currentTime = 1000;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("drains, logs the signal and duration, then exits 0", async () => {
    let finish!: () => void;
    const closed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const close = vi.fn(async () => {
      await closed;
    });
    const controller = createGracefulShutdown({
      logger,
      timeoutMs: 5000,
      close,
      exit,
      now: () => currentTime,
      registerSignals: false,
    });

    controller.handleSignal("SIGTERM");
    expect(controller.isShuttingDown()).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith("SIGTERM");
    expect(exit).not.toHaveBeenCalled();

    currentTime += 25;
    finish();
    await controller.shutdown();

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(close).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: "SIGTERM",
        outcome: "shutdown_complete",
        drainDurationMs: 25,
      }),
      "shutdown complete"
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("force-exits when the drain outruns the hard timeout", async () => {
    const close = vi.fn(() => new Promise<void>(() => {}));
    const controller = createGracefulShutdown({
      logger,
      timeoutMs: 1000,
      close,
      exit,
      now: () => currentTime,
      registerSignals: false,
    });

    controller.handleSignal("SIGTERM");
    currentTime += 1000;
    await vi.advanceTimersByTimeAsync(1000);

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: "SIGTERM",
        outcome: "shutdown_forced",
        reason: "timeout",
        timeoutMs: 1000,
        drainDurationMs: 1000,
      }),
      "shutdown forced"
    );
    expect(vi.getTimerCount()).toBe(0);

    controller.dispose();
  });

  it("force-exits immediately on a repeated signal without stacking handlers", () => {
    const close = vi.fn(() => new Promise<void>(() => {}));
    const controller = createGracefulShutdown({
      logger,
      timeoutMs: 10000,
      close,
      exit,
      now: () => currentTime,
      registerSignals: false,
    });

    controller.handleSignal("SIGTERM");
    currentTime += 100;
    controller.handleSignal("SIGTERM");
    controller.handleSignal("SIGINT");

    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: "SIGTERM",
        outcome: "shutdown_forced",
        reason: "repeated_signal",
        drainDurationMs: 100,
      }),
      "shutdown forced"
    );
    expect(vi.getTimerCount()).toBe(0);

    controller.dispose();
  });

  it("registers once per signal and removes its listeners on dispose and completion", async () => {
    const sigintBefore = process.listenerCount("SIGINT");
    const sigtermBefore = process.listenerCount("SIGTERM");

    const pending = createGracefulShutdown({
      logger,
      timeoutMs: 5000,
      close: async () => {},
      exit,
      now: () => currentTime,
    });
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore + 1);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore + 1);
    pending.dispose();
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);

    const completed = createGracefulShutdown({
      logger,
      timeoutMs: 5000,
      close: async () => {},
      exit,
      now: () => currentTime,
    });
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore + 1);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore + 1);
    await completed.shutdown("SIGINT");
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
    expect(vi.getTimerCount()).toBe(0);
  });
});
