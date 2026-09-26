import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { ZodError } from "zod";
import { AppError } from "../lib/errors";
import { formatErrorResponse } from "../utils/error-response";
import { toRequestLimitError } from "../lib/request-limits";
import { toPrismaError } from "../lib/prisma-error";
import { ProviderError } from "../lib/provider-error";
import { TimeoutError, TransportError, toProviderError } from "../services/timeout";

function isHorizonError(error: unknown): error is Error & {
  response?: { status?: number };
  status?: number;
  statusCode?: number;
  operation?: string;
  code?: string;
} {
  if (!error || typeof error !== "object") return false;
  const candidate = error as Record<string, unknown>;
  const responseStatus = typeof candidate.response === "object" && candidate.response
    ? (candidate.response as { status?: number }).status
    : undefined;
  const status = typeof candidate.status === "number" ? candidate.status : undefined;
  const code = typeof candidate.code === "string" ? candidate.code : undefined;
  const operation = typeof candidate.operation === "string" ? candidate.operation : undefined;
  const name = typeof candidate.name === "string" ? candidate.name : undefined;

  return (
    typeof responseStatus === "number" ||
    typeof status === "number" ||
    typeof code === "string" ||
    typeof operation === "string" ||
    name === "TimeoutError" ||
    name === "TransportError" ||
    name === "BadRequestError" ||
    name === "NotFoundError"
  );
}

export default fp(async function errorHandlerPlugin(app: FastifyInstance) {
  app.setErrorHandler((err: Error, req: FastifyRequest, reply: FastifyReply) => {
    const requestId = req.id as string;

    if (err instanceof ZodError) {
      const details = err.errors.map((e) => ({
        field: e.path.join("."),
        message: e.message,
        code: e.code,
      }));
      const issues = err.errors.map((e) => ({
        path: e.path,
        message: e.message,
        code: e.code,
      }));
      const first = err.errors[0];
      const field = first?.path.join(".");
      const message = field ? `${field}: ${first.message}` : first?.message ?? "Validation failed";

      return reply.code(400).send(
        formatErrorResponse("VALIDATION_ERROR", message, requestId, details, issues)
      );
    }

    // A request that failed Fastify's own JSON-schema validation (from a
    // route's `schema` / OpenAPI body-schema annotation) is a validation
    // error like any other, so it returns the same VALIDATION_ERROR contract
    // the Zod-based handlers use. Failing that — falling into the generic 4xx
    // branch below — would let two identical mistakes on two routes surface
    // with two different codes.
    if ((err as any).code === "FST_ERR_VALIDATION") {
      const details = Array.isArray((err as any).validation)
        ? (err as any).validation.map((v: any) => ({
            field: (v?.instancePath ?? "").replace(/^\//, "") || undefined,
            message: v?.message ?? "Validation failed",
          }))
        : undefined;
      return reply.code(400).send(
        formatErrorResponse("VALIDATION_ERROR", "Validation failed", requestId, details)
      );
    }

    // A body Fastify could not parse at all (malformed JSON) or an empty body
    // sent where JSON was required. Surfaced here so it carries the same
    // envelope as every other error instead of falling into the generic 4xx
    // branch, which echoes the parser's own message — text that can quote the
    // malformed input back to the client. Fixed 400 text, no parse details.
    //
    // Malformed JSON arrives as the SyntaxError thrown by JSON.parse with
    // statusCode 400 set by Fastify's content-type parser — a shape nothing
    // else in this pipeline produces, and one stable across parser message
    // formats (which change between V8 releases and are deliberately not
    // matched here).
    if (
      (err as any).code === "FST_ERR_CTP_EMPTY_JSON_BODY" ||
      (err instanceof SyntaxError && (err as any).statusCode === 400)
    ) {
      return reply.code(400).send(
        formatErrorResponse("VALIDATION_ERROR", "Request body must be valid JSON.", requestId)
      );
    }

    if (err instanceof AppError) {
      if (err instanceof ProviderError && err.retryAfterSeconds !== undefined) {
        reply.header("Retry-After", String(err.retryAfterSeconds));
      }
      return reply.code(err.status).send(
        formatErrorResponse(err.code, err.message, requestId, err.details)
      );
    }

    // A timeout or transport failure that escaped a handler still means the
    // upstream is unavailable, not that this process has a bug — answer 502
    // with the safe envelope rather than the generic 500, and never echo the
    // upstream's own error text.
    if (err instanceof TimeoutError || err instanceof TransportError) {
      const converted = toProviderError(err, {
        provider: "upstream",
        operation: "route",
        fallbackMessage: "The upstream service is unavailable",
      });
      return reply.code(converted.status).send(
        formatErrorResponse(converted.code, converted.message, requestId)
      );
    }

    // Size and shape limits rejected by Fastify or @fastify/multipart before a
    // handler ever ran. Without this they fall through to the generic 4xx
    // branch below, which echoes the framework's own wording and leaves clients
    // no stable code to branch on. See src/lib/request-limits.ts.
    const limitError = toRequestLimitError(err);
    if (limitError) {
      return reply.code(limitError.status).send(
        formatErrorResponse(limitError.code, limitError.message, requestId)
      );
    }

    // A statement the database rejected: a unique constraint, a dangling
    // foreign key, a missing required field, or a database this process cannot
    // reach. These used to reach the generic 500 below, which told the caller
    // that its own bad request (or a duplicate submission) was a bug in this
    // process. See src/lib/prisma-error.ts.
    const prismaError = toPrismaError(err);
    if (prismaError) {
      // The response carries the fixed, client-safe message; the log keeps the
      // original error so an operator still sees the constraint and the driver's
      // text. A duplicate submission is a client mistake rather than an
      // incident, so it is logged below warn; an unreachable database, a
      // deadlock, or a failed statement is not.
      const level =
        prismaError.retryable || prismaError.status >= 500 ? "warn" : "debug";
      req.log[level](
        {
          err,
          requestId,
          errorCode: prismaError.code,
          prismaCode: prismaError.prismaCode,
          // Postgres constraint names are internal, so they are logged rather
          // than sent in the response body.
          constraint: prismaError.constraint,
        },
        "Database error"
      );
      return reply.code(prismaError.status).send(
        formatErrorResponse(prismaError.code, prismaError.message, requestId, prismaError.details)
      );
    }

    const upstreamStatus =
      (err as unknown as Record<string, unknown>).response && typeof (err as any).response === "object"
        ? (err as any).response.status
        : (err as any).statusCode ?? (err as any).status;

    if (isHorizonError(err) && typeof upstreamStatus === "number") {
      const operation = (err as any).operation ?? "Horizon request";
      // Log upstream incidents at WARN without including full upstream
      // error objects to avoid leaking potentially sensitive payloads.
      req.log.warn(
        {
          requestId,
          operation,
          statusCode: upstreamStatus,
          errorCode: (err as any).code ?? "UPSTREAM_ERROR",
          message: (err as any).message,
        },
        "Horizon upstream failure"
      );

      if (upstreamStatus === 429) {
        const converted = toProviderError(err, {
          provider: "horizon",
          operation,
          fallbackMessage: "Horizon is rate limiting requests. Please retry shortly.",
        });
        if (converted instanceof ProviderError && converted.retryAfterSeconds !== undefined) {
          reply.header("Retry-After", String(converted.retryAfterSeconds));
        }
        return reply.code(converted.status).send(
          formatErrorResponse(converted.code, converted.message, requestId, converted.details)
        );
      }

      if (upstreamStatus >= 500 || upstreamStatus === 408) {
        return reply.code(502).send(
          formatErrorResponse("UPSTREAM_ERROR", `${operation} is temporarily unavailable. Please retry shortly.`, requestId)
        );
      }

      return reply.code(502).send(
        formatErrorResponse("UPSTREAM_ERROR", `${operation} failed while contacting the Stellar network.`, requestId)
      );
    }

    if ((err as any).statusCode === 429) {
      return reply.code(429).send(
        formatErrorResponse("RATE_LIMITED", "Too many requests, slow down.", requestId)
      );
    }

    if ((err as any).statusCode && (err as any).statusCode < 500) {
      const status: number = (err as any).statusCode;
      return reply.code(status).send(
        formatErrorResponse("BAD_REQUEST", err.message, requestId)
      );
    }

    app.log.error({ err, requestId }, "Unhandled error");
    return reply.code(500).send(
      formatErrorResponse("INTERNAL_ERROR", "Something went wrong.", requestId)
    );
  });
});
