/**
 * Containment for a multipart parser defect that would otherwise be a denial of
 * service.
 *
 * ## The defect
 *
 * When a multipart body ends mid-part — a truncated upload, a client that hangs
 * up, a hand-crafted request that simply omits the closing boundary — dicer
 * (via @fastify/busboy 3.2.0) reports it twice. The first report rejects the
 * read the route is awaiting, and the route answers it correctly with a 4xx.
 * The second is emitted a tick later, directly on dicer's own internal part
 * stream:
 *
 *     self._part.emit('error', new Error(type + ' terminated early due to ...'))
 *
 * That object is never handed to @fastify/multipart's `onFile`, so no
 * application code holds a reference to it and no listener can be attached to
 * it. In Node, an `error` event on an EventEmitter with no listener is rethrown
 * as an uncaught exception — so a malformed upload, which the API otherwise
 * handles perfectly, terminates the process.
 *
 * That makes a one-line request a way to take the API down, which is exactly
 * the class of problem the request-limit work exists to close.
 *
 * ## The containment
 *
 * A process-level `uncaughtException` handler that swallows *only* this error
 * and rethrows everything else by restoring the default behaviour. It is
 * deliberately narrow: matched on the parser's exact message shape, so an
 * unrelated bug still crashes loudly rather than being hidden.
 *
 * The affected request has already been answered by the time this runs, so
 * nothing is left hanging. Nothing is logged at error level and the message is
 * never echoed — it can quote the malformed body.
 *
 * Remove this once @fastify/busboy emits the second error on a stream the
 * application can reach, or stops emitting it at all.
 */

/**
 * The parser's own wording for a body that ended mid-part. Matched on both
 * halves so an unrelated error carrying one of these words is not swallowed.
 */
function isTruncatedMultipartError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message;
  return (
    message.includes("terminated early") &&
    message.includes("unexpected end of multipart data")
  );
}

let installed = false;

/**
 * Install the guard. Idempotent, so building more than one app instance — as
 * the test suite does — does not stack handlers.
 */
export function installMultipartGuard(): void {
  if (installed) return;
  installed = true;

  process.on("uncaughtException", (error, origin) => {
    if (isTruncatedMultipartError(error)) {
      // Already answered as a 4xx by the upload route. Dropping the duplicate
      // is the whole point; re-raising it would crash the process.
      return;
    }

    // Anything else must keep crashing the process. Registering *any*
    // uncaughtException listener suppresses Node's default handler, so the
    // default has to be reproduced explicitly — otherwise this guard would
    // silently convert every unrelated crash into a hang. Throwing from here
    // would not do it: the exception is swallowed by the emit loop.
    if (process.listenerCount("uncaughtException") === 1) {
      console.error(
        `Uncaught exception (${origin}):`,
        error instanceof Error ? (error.stack ?? error.message) : error
      );
      process.exit(1);
    }
  });
}

/** Exposed for tests: the predicate, without the process-level side effect. */
export const __testing = { isTruncatedMultipartError };
