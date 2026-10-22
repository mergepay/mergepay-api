/**
 * Request timeout — answers a request that overruns its budget with 408.
 *
 * A handler that never settles keeps its connection, its request object, and
 * its worker's attention for as long as the socket lives. Nothing else in the
 * stack bounds that: the rate limiter counts requests rather than punishing
 * duration, `bodyLimit` only bounds the bytes already received, and the
 * per-upstream timeouts in `src/services/timeout.ts` cover outbound calls a
 * handler happens to make — not a handler that hangs somewhere else. This
 * plugin closes that gap: every request is given `REQUEST_TIMEOUT_MS` to
 * finish, and one that outlives its budget is answered with a standard 408 and
 * the same JSON error envelope every other rejection uses.
 *
 * The timer is armed on `onRequest`, so it covers the whole pipeline — auth,
 * validation, handler, upstream calls, database work — rather than only the
 * handler body. It is disarmed on the raw response's `finish`/`close`, so the
 * common case costs one timer allocation and nothing more.
 *
 * Sending the 408 through `reply.code(408).send(...)` rather than writing to
 * `reply.raw` keeps the response inside Fastify's normal lifecycle: `onSend`
 * hooks, the error serializer, and the audit/response logging hooks all run
 * exactly as they do for any other status code. A handler that is still
 * running when the timer fires will later try to send its own reply; Fastify
 * sees the response has already ended and logs-and-drops that second send, so
 * the timeout never becomes a double-send crash.
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { getCorrelationId } from "../lib/correlation";
import { formatErrorResponse } from "../utils/error-response";

/** Machine-readable code carried by a 408 response. */
export const REQUEST_TIMEOUT_CODE = "REQUEST_TIMEOUT";

/** Options accepted by {@link requestTimeoutPlugin}. */
export interface RequestTimeoutOptions {
  /** Milliseconds a request may run before it is answered with 408. */
  timeoutMs: number;
}

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Set when the request outlived its timeout and was answered with 408.
     * Lets later hooks and the central error handler distinguish a timeout
     * from the handler's own eventual result.
     */
    timedOut?: boolean;
  }
}

const requestTimeoutPlugin: FastifyPluginAsync<RequestTimeoutOptions> = async (
  app: FastifyInstance,
  options
) => {
  const timeoutMs = options.timeoutMs;

  app.addHook("onRequest", async (request, reply) => {
    const timer = setTimeout(() => {
      // The response may already be on the wire — a handler that streamed, a
      // client that disconnected, or a race with the handler's own send. In
      // every one of those cases the 408 is too late and must be dropped.
      if (reply.sent || reply.raw.headersSent) return;

      request.timedOut = true;
      const correlationId = getCorrelationId(request.id);

      request.log.warn(
        {
          requestId: request.id,
          correlationId,
          method: request.method,
          url: request.url,
          timeoutMs,
        },
        "request timed out"
      );

      reply.header("x-request-id", request.id);
      reply.header("x-correlation-id", correlationId);
      reply
        .code(408)
        .send(
          formatErrorResponse(
            REQUEST_TIMEOUT_CODE,
            `Request exceeded the ${timeoutMs}ms time limit`,
            correlationId
          )
        );
    }, timeoutMs);

    // The timer must not keep the process alive on its own: shutdown waits for
    // in-flight work, and an armed timeout is not in-flight work.
    if (typeof timer.unref === "function") {
      timer.unref();
    }

    const disarm = () => clearTimeout(timer);
    // `finish` is the normal completion; `close` also covers an aborted client
    // or a destroyed socket, where `finish` never fires.
    reply.raw.once("finish", disarm);
    reply.raw.once("close", disarm);
  });
};

export default fp(requestTimeoutPlugin, {
  fastify: ">=4",
  name: "request-timeout",
});
