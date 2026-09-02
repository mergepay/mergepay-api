import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { ZodError } from "zod";
import { AppError } from "../lib/errors";
import { toRequestLimitError } from "../lib/request-limits";

/**
 * The one error envelope every failure — validation, authorization, rate
 * limiting, upstream, unexpected — is serialized into:
 *
 *   {
 *     code: string,        // stable machine-readable code (e.g. "NOT_FOUND") — canonical
 *     error: string,       // deprecated alias of `code`, kept for older clients
 *     message: string,     // human-readable description
 *     requestId: string,   // correlation id for tracing
 *     details?: unknown,   // optional structured detail (e.g. Zod issues)
 *   }
 *
 * The HTTP status is conveyed by the response status only — never duplicated
 * in the body — and the body never contains stack traces, SQL, credentials,
 * signed XDRs, or upstream response text. Those go to the server log, keyed
 * by `requestId`.
 */
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
      return reply.code(400).send({
        code: "VALIDATION_ERROR",
        error: "VALIDATION_ERROR",
        message: "Validation failed",
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

    if ((err as any).statusCode === 429) {
      return reply.code(429).send({
        code: "RATE_LIMITED",
        error: "RATE_LIMITED",
        message: "Too many requests, slow down.",
        requestId,
      });
    }

    // Fastify's payload-size guard (FST_ERR_CTP_BODY_TOO_LARGE) gets its own
    // stable code instead of the generic BAD_REQUEST, so a client can tell a
    // size rejection from a validation failure.
    if ((err as any).statusCode === 413) {
      return reply.code(413).send({
        code: "PAYLOAD_TOO_LARGE",
        error: "PAYLOAD_TOO_LARGE",
        message: "Request body exceeds the allowed size limit",
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
