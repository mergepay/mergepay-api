/**
 * Shared graceful-shutdown coordination for the API and worker processes.
 *
 * Both entry points (`src/index.ts`, `src/worker/index.ts`) need the same
 * three guarantees, so the coordination lives here rather than being
 * reimplemented per process:
 *
 *   - **Idempotent.** Only the first signal runs the cleanup. A deployment
 *     sending SIGTERM and then SIGINT (or a user pressing Ctrl-C twice) must
 *     not trigger duplicate cleanup.
 *   - **Bounded.** Cleanup gets a deadline (`timeoutMs`). If a dependency
 *     stays stuck — a hanging Horizon call, a Prisma query that never
 *     returns — the process is force-exited instead of lingering forever.
 *   - **Observable.** Every phase (start, complete, error, timeout) is logged
 *     with the process name and signal, so operators can tell *what* shut
 *     down and *how*. No secrets are ever logged here.
 *
 * The caller supplies `onComplete`/`onTimeout` (typically `process.exit(0)`
 * and `process.exit(1)`), so tests can exercise the coordinator without
 * exiting the test runner.
 */
import pino from "pino";

/**
 * The small slice of a logger the coordinator needs. Typed structurally so
 * both a pino logger (worker) and Fastify's logger (API) can be passed.
 */
export interface ShutdownLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface ShutdownCoordinatorOptions {
  /** Identifies this process in shutdown logs (e.g. "api", "worker"). */
  name: string;
  /** Logger for shutdown-phase lines; defaults to a dedicated pino logger. */
  logger?: ShutdownLogger;
  /** Upper bound (ms) for cleanup; the process is force-exited after this. */
  timeoutMs: number;
  /** Called after cleanup completes within the deadline (e.g. exit(0)). */
  onComplete?: () => void;
  /** Called when the deadline passes or cleanup throws (e.g. exit(1)). */
  onTimeout?: () => void;
}

export interface ShutdownCoordinator {
  /**
   * Begin graceful shutdown. Safe to call more than once — only the first
   * call runs the cleanup; repeated signals are logged and ignored.
   */
  begin(signal: string, cleanup: () => Promise<void>): void;
  /** Resolves when the first cleanup attempt finishes, by completion or deadline. */
  readonly done: Promise<void>;
}

export function createShutdownCoordinator(
  options: ShutdownCoordinatorOptions
): ShutdownCoordinator {
  const log: ShutdownLogger =
    options.logger ?? (pino({ name: `shutdown:${options.name}` }) as unknown as ShutdownLogger);
  let started = false;
  let outcomeCalled = false;
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const callOutcome = (fn: (() => void) | undefined): void => {
    if (fn && !outcomeCalled) {
      outcomeCalled = true;
      fn();
    }
  };

  return {
    done,
    begin(signal, cleanup) {
      if (started) {
        log.warn(
          { signal, phase: "duplicate" },
          `${options.name} shutdown already in progress; ignoring repeated signal`
        );
        return;
      }
      started = true;

      const deadline = setTimeout(() => {
        log.error(
          { signal, phase: "timeout", timeoutMs: options.timeoutMs },
          `${options.name} shutdown exceeded its ${options.timeoutMs}ms deadline; force-exiting`
        );
        callOutcome(options.onTimeout);
        resolveDone();
      }, options.timeoutMs);

      log.info({ signal, phase: "start" }, `${options.name} shutting down`);

      void (async () => {
        try {
          await cleanup();
          clearTimeout(deadline);
          log.info({ signal, phase: "complete" }, `${options.name} shutdown complete`);
          callOutcome(options.onComplete);
        } catch (error) {
          clearTimeout(deadline);
          log.error(
            { signal, phase: "error", err: error },
            `${options.name} shutdown cleanup failed`
          );
          callOutcome(options.onTimeout);
        } finally {
          resolveDone();
        }
      })();
    },
  };
}
