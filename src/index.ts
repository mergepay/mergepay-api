import { buildApp } from "./app";
import { config } from "./config";
import { ZodError } from "zod";
import { AppError } from "./lib/errors";

async function main() {
  const app = await buildApp();

  // Global error handler - must be registered after all plugins/routes
  app.setErrorHandler((error, request, reply) => {
    const requestId = (request.id as string) || "";

    // Handle Zod validation errors
    if (error instanceof ZodError) {
      const details = error.errors.map((e) => ({
        path: e.path.join("."),
        message: e.message,
      }));
      return reply.status(400).send({
        error: "VALIDATION_ERROR",
        message: "Validation failed",
        statusCode: 400,
        details,
        requestId,
      });
    }

    // Handle AppError (our custom errors)
    if (error instanceof AppError) {
      const response: Record<string, any> = {
        error: error.code,
        message: error.message,
        statusCode: error.statusCode,
        requestId,
      };
      if (error.details !== undefined) {
        response.details = error.details;
      }
      return reply.status(error.statusCode).send(response);
    }

    // Handle Fastify validation errors (e.g., from route validation schema)
    if (error.validation) {
      return reply.status(400).send({
        error: "VALIDATION_ERROR",
        message: error.message || "Validation failed",
        statusCode: 400,
        details: error.validation,
        requestId,
      });
    }

    // Preserve status codes and codes for other known errors (e.g., Fastify http-errors, not-found)
    const statusCode =
      typeof (error as any).statusCode === "number"
        ? (error as any).statusCode
        : 500;

    // Map common status codes to standard error codes
    const statusToCode: Record<number, string> = {
      400: "BAD_REQUEST",
      401: "UNAUTHORIZED",
      403: "FORBIDDEN",
      404: "NOT_FOUND",
      409: "CONFLICT",
      422: "UNPROCESSABLE_ENTITY",
      429: "TOO_MANY_REQUESTS",
    };

    if (statusCode && statusCode !== 500) {
      const message = error.message || "Request error";
      const code =
        (error as any).code ||
        statusToCode[statusCode] ||
        "REQUEST_ERROR";
      return reply.status(statusCode).send({
        error: code,
        message,
        statusCode,
        requestId,
      });
    }

    // Default: unknown/internal errors
    const isDev = config.NODE_ENV === "development";
    const message = isDev ? error.message : "Internal server error";

    // Log the original error for debugging
    request.log.error({ err: error, requestId }, "Unhandled error");

    const response: Record<string, any> = {
      error: "INTERNAL_ERROR",
      message,
      statusCode: 500,
      requestId,
    };

    if (isDev && error.stack) {
      response.stack = error.stack;
    }

    return reply.status(500).send(response);
  });

  try {
    await app.listen({ port: config.PORT, host: "0.0.0.0" });
    app.log.info(`Server listening on http://0.0.0.0:${config.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
