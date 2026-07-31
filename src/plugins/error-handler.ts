import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { ZodError } from "zod";
import { AppError } from "../lib/errors";

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
        message,
        requestId,
        details,
      });
    }

    if (err instanceof AppError) {
      const body: Record<string, unknown> = {
        code: err.code,
        message: err.message,
        requestId,
      };
      if (err.details !== undefined) {
        body.details = err.details;
      }
      return reply.code(err.status).send(body);
    }

    if ((err as any).statusCode === 429) {
      return reply.code(429).send({
        code: "RATE_LIMITED",
        message: "Too many requests, slow down.",
        requestId,
      };
      if (retryAfter) {
        body.retryAfter = retryAfter;
      }
      return reply.code(429).send(body);
    }

    if ((err as any).statusCode && (err as any).statusCode < 500) {
      const status: number = (err as any).statusCode;
      return reply.code(status).send({
        code: "BAD_REQUEST",
        message: err.message,
        requestId,
      });
    }

    app.log.error({ err, requestId }, "Unhandled error");
    return reply.code(500).send({
      code: "INTERNAL_ERROR",
      message: "Something went wrong.",
      requestId,
    });
  });
});
