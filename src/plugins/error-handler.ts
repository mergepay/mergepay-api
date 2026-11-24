import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { ZodError } from "zod";
import { AppError, BearerAuthError, ErrorCode } from "../lib/errors";
import { formatErrorResponse, type FormattedErrorResponse } from "../utils/error-response";
import { toRequestLimitError } from "../lib/request-limits";
import { toPrismaError } from "../lib/prisma-error";
import { ProviderError } from "../lib/provider-error";
import { resolveHorizonFailure } from "../middleware/horizon-error";
import { TimeoutError, TransportError, toProviderError } from "../services/timeout";

type RecordValue = Record<string, unknown>;

export interface ErrorLogPlan {
  level: "debug" | "warn" | "error";
  message: string;
  fields: Record<string, unknown>;
  includeError?: boolean;
}

export interface ResolvedError {
  status: number;
  code: string;
  message: string;
  details?: unknown;
  issues?: unknown;
  headers?: Record<string, string>;
  retryAfter?: number;
  log?: ErrorLogPlan;
}

const PROVIDER_ERROR_NAMES = new Set([
  "ResponseError",
  "BadRequestError",
  "NotFoundError",
  "TimeoutError",
  "TransportError",
]);

const GENERIC_STATUS_CODES: Record<number, string> = {
  400: ErrorCode.BAD_REQUEST,
  401: ErrorCode.UNAUTHORIZED,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  409: ErrorCode.CONFLICT,
  429: ErrorCode.RATE_LIMITED,
};

const GENERIC_STATUS_MESSAGES: Record<number, string> = {
  400: "Bad request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not found",
  409: "Conflict",
  429: "Too many requests, slow down.",
};

function asRecord(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" ? (value as RecordValue) : null;
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function safeToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_.:-]{1,120}$/.test(trimmed) ? trimmed : undefined;
}

/**
 * The field a Zod issue is about, as a dotted path.
 *
 * An unrecognized key is the one issue Zod raises with an empty path — the key
 * is the problem, and it lives in `keys`. Reporting it as `field: ""` tells a
 * client only that something at the root is wrong, when the whole point of
 * rejecting unknown keys is that the client learn which one to delete.
 */
function zodIssueField(issue: ZodError["issues"][number] | undefined): string {
  if (!issue) return "";
  if (issue.code === "unrecognized_keys") return issue.keys?.[0] ?? "";
  return issue.path.join(".");
}

function zodIssuePath(issue: ZodError["issues"][number] | undefined): string {
  if (!issue) return "";
  if (issue.code === "unrecognized_keys") return issue.keys?.[0] ?? "";
  return issue.path.map(String).join(".");
}

function zodResolution(err: ZodError): ResolvedError {
  const details = err.issues.map((e) => ({
    field: zodIssueField(e),
    path: zodIssuePath(e),
    message: e.message,
    code: e.code,
  }));
  const issues = err.issues.map((e) => ({
    path: e.path.map(String),
    message: e.message,
    code: e.code,
  }));
  const first = err.issues[0];
  const field = zodIssuePath(first);
  const message = field ? `${field}: ${first.message}` : first?.message ?? "Validation failed";
  return { status: 400, code: ErrorCode.VALIDATION_ERROR, message, details, issues };
}

/**
 * Fastify's own JSON-schema validation (from a route `schema` / OpenAPI body
 * annotation) is a validation error like any other, so it carries the same
 * VALIDATION_ERROR contract the Zod-based handlers use. ajv's `instancePath`
 * becomes `field`, its `keyword` becomes `code`, and the top-level message
 * names the first offending field. A client cannot tell which validator
 * rejected it, and does not lose `issues` when the answer came from ajv.
 */
function ajvResolution(root: RecordValue | null): ResolvedError {
  const issues: { path: string[]; field?: string; message: string; code?: string }[] = Array.isArray(
    root?.validation
  )
    ? root.validation.map((value: unknown) => {
        const item = asRecord(value);
        const rawPath = String(item?.instancePath ?? "").replace(/^\//, "");
        const field = rawPath.split("/").filter(Boolean).join(".");
        return {
          path: field ? field.split(".") : [],
          field: field || undefined,
          message: typeof item?.message === "string" ? item.message : "Validation failed",
          code: typeof item?.keyword === "string" ? item.keyword : undefined,
        };
      })
    : [];
  const details = issues.map((issue) => ({
    field: issue.field,
    path: issue.field ?? "",
    message: issue.message,
    code: issue.code,
  }));
  const first = issues[0];
  const message = first
    ? first.field
      ? `${first.field}: ${first.message}`
      : first.message
    : "Validation failed";
  return { status: 400, code: ErrorCode.VALIDATION_ERROR, message, details, issues };
}

function providerStatusOf(root: RecordValue | null): number | undefined {
  if (!root) return undefined;
  const response = asRecord(root.response);
  const fromResponse = response ? numeric(response.status) : undefined;
  if (fromResponse !== undefined) return fromResponse;
  const name = typeof root.name === "string" ? root.name : undefined;
  if (name && PROVIDER_ERROR_NAMES.has(name)) {
    return numeric(root.statusCode) ?? numeric(root.status);
  }
  return undefined;
}

function providerResolution(
  err: unknown,
  root: RecordValue | null,
  upstreamStatus: number
): ResolvedError {
  const operation = safeToken(root?.operation) ?? "Horizon request";
  const log: ErrorLogPlan = {
    level: "warn",
    message: "Horizon upstream failure",
    fields: {
      operation,
      statusCode: upstreamStatus,
      errorCode: safeToken(root?.code) ?? ErrorCode.UPSTREAM_ERROR,
    },
  };

  if (upstreamStatus === 429) {
    const converted = toProviderError(err, {
      provider: "horizon",
      operation,
      fallbackMessage: "Horizon is rate limiting requests. Please retry shortly.",
    });
    const retryAfter =
      converted instanceof ProviderError ? converted.retryAfterSeconds : undefined;
    return {
      status: converted.status,
      code: converted.code,
      message: converted.message,
      details: (converted as AppError).details,
      ...(retryAfter !== undefined
        ? { headers: { "Retry-After": String(retryAfter) }, retryAfter }
        : {}),
      log,
    };
  }

  const unavailable = upstreamStatus >= 500 || upstreamStatus === 408;
  return {
    status: 502,
    code: ErrorCode.UPSTREAM_ERROR,
    message: unavailable
      ? `${operation} is temporarily unavailable. Please retry shortly.`
      : `${operation} failed while contacting the Stellar network.`,
    log,
  };
}

export function resolveError(err: unknown): ResolvedError {
  if (err === null || err === undefined) {
    return {
      status: 500,
      code: ErrorCode.INTERNAL_ERROR,
      message: "Something went wrong.",
      log: { level: "error", message: "Unhandled error", fields: {}, includeError: true },
    };
  }

  if (err instanceof ZodError) return zodResolution(err);

  const root = asRecord(err);
  const code = typeof root?.code === "string" ? root.code : undefined;

  if (code === "FST_ERR_VALIDATION") return ajvResolution(root);

  if (
    code === "FST_ERR_CTP_EMPTY_JSON_BODY" ||
    (err instanceof SyntaxError && numeric(root?.statusCode) === 400)
  ) {
    return {
      status: 400,
      code: ErrorCode.VALIDATION_ERROR,
      message: "Request body must be valid JSON.",
    };
  }

  if (err instanceof AppError) {
    const headers: Record<string, string> = {};
    const retryAfter = err.retryAfterSeconds;
    if (retryAfter !== undefined) headers["Retry-After"] = String(retryAfter);
    if (err instanceof BearerAuthError) {
      headers["WWW-Authenticate"] = err.wwwAuthenticate;
    }
    return {
      status: err.status,
      code: err.code,
      message: err.message,
      details: err.details,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(retryAfter !== undefined ? { retryAfter } : {}),
    };
  }

  if (err instanceof TimeoutError || err instanceof TransportError) {
    const converted = toProviderError(err, {
      provider: "upstream",
      operation: "route",
      fallbackMessage: "The upstream service is unavailable",
    });
    return {
      status: converted.status,
      code: converted.code,
      message: converted.message,
      details: (converted as AppError).details,
    };
  }

  const limitError = toRequestLimitError(err);
  if (limitError) {
    return { status: limitError.status, code: limitError.code, message: limitError.message };
  }

  const prismaError = toPrismaError(err);
  if (prismaError) {
    return {
      status: prismaError.status,
      code: prismaError.code,
      message: prismaError.message,
      details: prismaError.details,
      log: {
        level: prismaError.retryable || prismaError.status >= 500 ? "warn" : "debug",
        message: "Database error",
        fields: {
          err,
          errorCode: prismaError.code,
          prismaCode: prismaError.prismaCode,
          constraint: prismaError.constraint,
        },
      },
    };
  }

  const operation = typeof root?.operation === "string" ? root.operation : undefined;
  const horizonFailure = resolveHorizonFailure(err, operation);
  if (horizonFailure) {
    return {
      status: horizonFailure.status,
      code: horizonFailure.code,
      message: horizonFailure.message,
      details: horizonFailure.details,
      log: {
        level: horizonFailure.level,
        message: "Horizon error mapped",
        fields: horizonFailure.logFields,
      },
    };
  }

  const upstreamStatus = providerStatusOf(root);
  if (upstreamStatus !== undefined) return providerResolution(err, root, upstreamStatus);

  const status = numeric(root?.statusCode) ?? numeric(root?.status);
  if (status !== undefined && status >= 400 && status < 500) {
    return {
      status,
      code: GENERIC_STATUS_CODES[status] ?? ErrorCode.BAD_REQUEST,
      message: GENERIC_STATUS_MESSAGES[status] ?? "Bad request",
    };
  }

  return {
    status: 500,
    code: ErrorCode.INTERNAL_ERROR,
    message: "Something went wrong.",
    log: { level: "error", message: "Unhandled error", fields: {}, includeError: true },
  };
}

export function formatResolvedError(
  resolved: ResolvedError,
  requestId?: string
): FormattedErrorResponse {
  return formatErrorResponse(
    resolved.code,
    resolved.message,
    requestId,
    resolved.details,
    resolved.issues,
    resolved.retryAfter
  );
}

/**
 * Format any error into a standardized error response object.
 * Returns { error: { code, message, details?, issues?, timestamp, requestId }, code, message, requestId }.
 */
export function serializeError(
  err: unknown,
  requestId: string = "req-unknown"
): FormattedErrorResponse {
  return formatResolvedError(resolveError(err), requestId);
}

export const errorHandlerPlugin = fp(async function errorHandlerPlugin(app: FastifyInstance) {
  app.setErrorHandler((err: Error, req: FastifyRequest, reply: FastifyReply) => {
    const requestId = req.id as string;
    const resolved = resolveError(err);

    for (const [name, value] of Object.entries(resolved.headers ?? {})) {
      reply.header(name, value);
    }
    if (resolved.log) {
      const fields: Record<string, unknown> = { requestId, ...resolved.log.fields };
      if (resolved.log.includeError) fields.err = err;
      req.log[resolved.log.level](fields, resolved.log.message);
    }

    return reply.code(resolved.status).send(formatResolvedError(resolved, requestId));
  });
});

export default errorHandlerPlugin;
