export type ShutdownSignal = NodeJS.Signals;

export interface ShutdownLogger {
  info(fields: Record<string, unknown>, message?: string): void;
  warn(fields: Record<string, unknown>, message?: string): void;
  error(fields: Record<string, unknown>, message?: string): void;
}

export interface GracefulShutdownOptions {
  logger: ShutdownLogger;
  timeoutMs: number;
  close: (signal: ShutdownSignal) => Promise<void> | void;
  exit?: (code: number) => void;
  now?: () => number;
  signals?: readonly ShutdownSignal[];
  registerSignals?: boolean;
  logFields?: Record<string, unknown>;
}

export interface ShutdownController {
  shutdown(signal?: ShutdownSignal): Promise<void>;
  handleSignal(signal: ShutdownSignal): void;
  dispose(): void;
  isShuttingDown(): boolean;
}

const DEFAULT_SIGNALS: readonly ShutdownSignal[] = ["SIGINT", "SIGTERM"];

export function createGracefulShutdown(options: GracefulShutdownOptions): ShutdownController {
  const {
    logger,
    timeoutMs,
    close,
    exit = (code: number) => process.exit(code),
    now = () => Date.now(),
    signals = DEFAULT_SIGNALS,
    registerSignals = true,
    logFields = {},
  } = options;

  let started = false;
  let startedAt = 0;
  let completion: Promise<void> | undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let forced = false;

  const listeners = new Map<ShutdownSignal, () => void>();

  const dispose = (): void => {
    for (const [signal, listener] of listeners) {
      process.removeListener(signal, listener);
    }
    listeners.clear();
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    }
  };

  const drainDurationMs = (): number => now() - startedAt;

  const forceExit = (signal: ShutdownSignal, reason: "timeout" | "repeated_signal"): void => {
    if (forced) return;
    forced = true;
    dispose();
    logger.error(
      {
        ...logFields,
        signal,
        timeoutMs,
        outcome: "shutdown_forced",
        reason,
        drainDurationMs: drainDurationMs(),
      },
      "shutdown forced"
    );
    exit(1);
  };

  const shutdown = (signal: ShutdownSignal = "SIGINT"): Promise<void> => {
    if (started) return completion ?? Promise.resolve();
    started = true;
    startedAt = now();

    completion = (async () => {
      logger.info(
        { ...logFields, signal, timeoutMs, outcome: "shutdown_started" },
        "shutting down"
      );
      timeoutHandle = setTimeout(() => forceExit(signal, "timeout"), timeoutMs);
      try {
        await close(signal);
      } catch (error) {
        if (!forced) {
          dispose();
          logger.error(
            {
              ...logFields,
              signal,
              err: error,
              outcome: "shutdown_failed",
              drainDurationMs: drainDurationMs(),
            },
            "shutdown failed"
          );
          exit(1);
        }
        return;
      }
      if (!forced) {
        dispose();
        logger.info(
          {
            ...logFields,
            signal,
            timeoutMs,
            outcome: "shutdown_complete",
            drainDurationMs: drainDurationMs(),
          },
          "shutdown complete"
        );
        exit(0);
      }
    })();

    return completion;
  };

  const handleSignal = (signal: ShutdownSignal): void => {
    if (!started) {
      void shutdown(signal);
      return;
    }
    forceExit(signal, "repeated_signal");
  };

  if (registerSignals) {
    for (const signal of signals) {
      const listener = () => handleSignal(signal);
      process.on(signal, listener);
      listeners.set(signal, listener);
    }
  }

  return {
    shutdown,
    handleSignal,
    dispose,
    isShuttingDown: () => started,
  };
}
