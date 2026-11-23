/**
 * Request correlation ID middleware (issue #1077).
 *
 * One canonical place resolves the ID Fastify puts on every request, echoes it
 * back to the client, and binds it to the request-scoped logger. Handlers and
 * downstream services can then log `correlationId` without re-deriving it, and
 * a client-supplied `X-Request-ID` survives the round trip so logs from several
 * services can be joined.
 *
 * The value is generated in `Fastify({ genReqId })` (see src/app.ts) and merely
 * normalized here, so an app that builds Fastify without that option still gets
 * a bounded, log-safe ID. Malformed or oversized client headers are replaced
 * rather than echoed — see src/lib/correlation.ts.
 */
import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import {
  generateCorrelationId,
  getCorrelationId,
} from "../lib/correlation";

/** Header a client sends to correlate its own request with the API's logs. */
export const REQUEST_ID_HEADER = "x-request-id";
/** Header carrying the same ID for clients that use tracing terminology. */
export const CORRELATION_ID_HEADER = "x-correlation-id";

/**
 * Resolve the ID to use for a request from its headers. `X-Request-ID` wins,
 * `X-Correlation-ID` is the fallback, and a server-owned ID is generated when
 * neither is usable.
 */
export function resolveIncomingRequestId(
  headers: FastifyRequest["headers"]
): string {
  const requestId = headers[REQUEST_ID_HEADER];
  const correlationId = headers[CORRELATION_ID_HEADER];
  const preferred =
    typeof requestId === "string" && requestId.trim()
      ? requestId
      : typeof correlationId === "string" && correlationId.trim()
        ? correlationId
        : generateCorrelationId();

  return getCorrelationId(preferred);
}

/** Correlation ID attached to a request, regenerating one if it is missing. */
export function correlationIdFor(request: FastifyRequest): string {
  return getCorrelationId(request.id || resolveIncomingRequestId(request.headers));
}

const requestIdPlugin: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", async (request, reply) => {
    const correlationId = correlationIdFor(request);
    // Fastify's `genReqId` normally set this already; assigning the normalized
    // value keeps request.id, the response headers, and the logger in lockstep
    // even for apps that did not configure generation at construction time.
    request.id = correlationId;
    reply.header(REQUEST_ID_HEADER, correlationId);
    reply.header(CORRELATION_ID_HEADER, correlationId);
    request.log = request.log.child({
      reqId: correlationId,
      correlationId,
    });
    request.log.info({ requestId: correlationId, correlationId }, "request received");
  });

  app.addHook("onResponse", async (request, reply) => {
    const correlationId = correlationIdFor(request);
    request.log = request.log.child({
      reqId: correlationId,
      correlationId,
    });
    request.log.info(
      {
        requestId: correlationId,
        correlationId,
        statusCode: reply.statusCode,
        method: request.method,
        route: request.routeOptions.url,
      },
      "request completed"
    );
  });
};

export default fp(requestIdPlugin, {
  fastify: ">=4",
  name: "request-id",
});
