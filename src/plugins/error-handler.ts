import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { ZodError } from "zod";
import { AppError } from "../lib/errors";
import { toRequestLimitError } from "../lib/request-limits";

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
      const first = err.errors[0];
      const field = first?.path.join(".");
      const message = field ? `${field}: ${first.message}` : first?.message ?? "Validation failed";

      return reply.code(400).send({
        code: "VALIDATION_ERROR",
        error: "VALIDATION_ERROR",
        message,
        requestId,
        details,
      });
    }

    if (err instanceof AppError) {
      const body: Record<string, unknown> = {
        code: err.code,
        error: err.code,
        message: err.message,
        requestId,
      };
      if (err.details !== undefined) {
        body.details = err.details;
      }
      return reply.code(err.status).send(body);
    }

    // Size and shape limits rejected by Fastify or @fastify/multipart before a
    // handler ever ran. Without this they fall through to the generic 4xx
    // branch below, which echoes the framework's own wording and leaves clients
    // no stable code to branch on. See src/lib/request-limits.ts.
    const limitError = toRequestLimitError(err);
    if (limitError) {
      return reply.code(limitError.status).send({
        code: limitError.code,
        error: limitError.code,
        message: limitError.message,
        requestId,
      });
    }

    const upstreamStatus =
      (err as Record<string, unknown>).response && typeof (err as any).response === "object"
        ? (err as any).response.status
        : (err as any).statusCode ?? (err as any).status;

    if (isHorizonError(err) && typeof upstreamStatus === "number") {
      const operation = (err as any).operation ?? "Horizon request";
      req.log.warn(
        {
          requestId,
          operation,
          statusCode: upstreamStatus,
          errorCode: (err as any).code ?? "UPSTREAM_ERROR",
          err,
        },
        "Horizon upstream failure"
      );

      if (upstreamStatus === 429) {
        return reply.code(429).send({
          code: "RATE_LIMITED",
          error: "RATE_LIMITED",
          message: "Horizon is rate limiting requests. Please retry shortly.",
          requestId,
        });
      }

      if (upstreamStatus >= 500 || upstreamStatus === 408) {
        return reply.code(502).send({
          code: "UPSTREAM_ERROR",
          error: "UPSTREAM_ERROR",
          message: `${operation} is temporarily unavailable. Please retry shortly.`,
          requestId,
        });
      }

      return reply.code(502).send({
        code: "UPSTREAM_ERROR",
        error: "UPSTREAM_ERROR",
        message: `${operation} failed while contacting the Stellar network.`,
        requestId,
      });
    }

    if ((err as any).statusCode === 429) {
      return reply.code(429).send({
        code: "RATE_LIMITED",
        error: "RATE_LIMITED",
        message: "Too many requests, slow down.",
        requestId,
      });
    }

    if ((err as any).statusCode && (err as any).statusCode < 500) {
      const status: number = (err as any).statusCode;
      return reply.code(status).send({
        code: "BAD_REQUEST",
        error: "BAD_REQUEST",
        message: err.message,
        requestId,
      });
    }

    app.log.error({ err, requestId }, "Unhandled error");
    return reply.code(500).send({
      code: "INTERNAL_ERROR",
      error: "INTERNAL_ERROR",
      message: "Something went wrong.",
      requestId,
    });
  });
});
