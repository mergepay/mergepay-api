/**
 * Request size and shape limits, and the client errors they produce.
 *
 * ## Why this exists
 *
 * Fastify and @fastify/multipart already reject an oversized request — but they
 * reject it in their own words, with their own error codes, and the API's error
 * handler was passing those through as a generic `BAD_REQUEST`. A client could
 * see that its upload failed and not learn whether the file was too large, there
 * were too many files, or a single field was oversized. This module maps each
 * limit to a stable code and a message that names the actual limit.
 *
 * ## Where the limits are enforced
 *
 * Enforcement happens at the narrowest practical scope, so an ordinary JSON
 * route is never constrained by a limit that exists for uploads:
 *
 *  - the **global** `bodyLimit` on the Fastify instance (`JSON_BODY_LIMIT_BYTES`)
 *    bounds every JSON body;
 *  - **per-route** `bodyLimit` overrides tighten the routes that take signed
 *    envelopes or credentials (`AUTH_BODY_LIMIT_BYTES`) and widen the one route
 *    that takes a file — see the `onRoute` hook in src/app.ts;
 *  - **multipart** limits (`fileSize`, `files`, `fieldSize`, `parts`) are
 *    configured on the plugin and apply to the multipart route.
 *
 * Every limit is read from the established environment configuration with a
 * safe default, so a deployment can tighten or relax them without a code change.
 *
 * ## What is never logged
 *
 * Nothing here reads a field value, a filename, or an uploaded byte. The errors
 * carry the configured limit and the name of the constraint that tripped —
 * never the content that tripped it.
 */

import { config } from "../config";
import { ErrorCode } from "./errors";

/** A limit violation, resolved to what the client should be told. */
export interface RequestLimitError {
  status: number;
  code: string;
  message: string;
}

function mb(bytes: number): string {
  const value = bytes / (1024 * 1024);
  // Whole numbers read better than "5.0 MB"; fractions keep one decimal.
  return Number.isInteger(value) ? `${value} MB` : `${value.toFixed(1)} MB`;
}

function kb(bytes: number): string {
  const value = bytes / 1024;
  return Number.isInteger(value) ? `${value} KB` : `${value.toFixed(1)} KB`;
}

/**
 * Error codes raised by Fastify core and @fastify/multipart when a limit trips.
 *
 * Matched on the code rather than the message: the codes are part of those
 * packages' public contract, and the messages are not.
 */
const LIMIT_CODES: Record<string, () => RequestLimitError> = {
  // Fastify core: the request body exceeded the route's (or the instance's)
  // bodyLimit. 413 rather than 400 — the request was well-formed, just too big.
  FST_ERR_CTP_BODY_TOO_LARGE: () => ({
    status: 413,
    code: ErrorCode.REQUEST_TOO_LARGE,
    message: `Request body is too large. The limit is ${kb(config.JSON_BODY_LIMIT_BYTES)}.`,
  }),

  // @fastify/multipart: one uploaded file exceeded `fileSize`.
  FST_REQ_FILE_TOO_LARGE: () => ({
    status: 413,
    code: ErrorCode.FILE_TOO_LARGE,
    message: `Files must be under ${mb(config.MULTIPART_FILE_SIZE_BYTES)}.`,
  }),

  // @fastify/multipart: more files than `files` allows.
  FST_FILES_LIMIT: () => ({
    status: 413,
    code: ErrorCode.TOO_MANY_FILES,
    message: `Too many files. At most ${config.MULTIPART_MAX_FILES} may be uploaded per request.`,
  }),

  // @fastify/multipart: a single non-file field exceeded `fieldSize`.
  FST_FIELDS_LIMIT: () => ({
    status: 413,
    code: ErrorCode.FIELD_TOO_LARGE,
    message: `A form field is too large. Fields must be under ${kb(config.MULTIPART_FIELD_SIZE_BYTES)}.`,
  }),

  // @fastify/multipart: more parts (fields + files) than `parts` allows.
  FST_PARTS_LIMIT: () => ({
    status: 413,
    code: ErrorCode.TOO_MANY_PARTS,
    message: `Too many form parts. At most ${config.MULTIPART_MAX_FIELDS} are accepted per request.`,
  }),

  // @fastify/multipart: the body was not parseable as multipart at all.
  FST_INVALID_MULTIPART_CONTENT_TYPE: () => ({
    status: 415,
    code: ErrorCode.BAD_REQUEST,
    message: "Request must be multipart/form-data.",
  }),
};

/**
 * Multipart parse failures that are not limit violations.
 *
 * Busboy surfaces a malformed body as a plain error whose message names the
 * problem. These are answered as a 400 with a fixed message rather than echoing
 * the parser's text, which can quote the malformed input.
 */
const MALFORMED_MULTIPART_MARKERS = [
  "unexpected end of form",
  "malformed part header",
  "missing content-type",
  "unexpected end of multipart data",
];

/**
 * Resolve an error to a limit violation, or null if it is not one.
 *
 * Called by the central error handler before its generic 4xx fallback, so a
 * limit rejection produces the same shaped response as any other client error
 * while keeping its own code.
 */
export function toRequestLimitError(error: unknown): RequestLimitError | null {
  if (!error || typeof error !== "object") return null;

  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") {
    const resolve = LIMIT_CODES[code];
    if (resolve) return resolve();
  }

  const message = (error as { message?: unknown }).message;
  if (typeof message === "string") {
    const lowered = message.toLowerCase();
    if (MALFORMED_MULTIPART_MARKERS.some((marker) => lowered.includes(marker))) {
      return {
        status: 400,
        code: ErrorCode.BAD_REQUEST,
        // Deliberately fixed text: the parser's own message can quote the
        // malformed body back to the client.
        message: "Malformed multipart request.",
      };
    }
  }

  return null;
}

/**
 * The limits, as the API documents them. Exposed so tests and clients can
 * assert against the configured values rather than hard-coded numbers.
 */
export function requestLimits() {
  return {
    jsonBodyBytes: config.JSON_BODY_LIMIT_BYTES,
    multipartFileBytes: config.MULTIPART_FILE_SIZE_BYTES,
    multipartFieldBytes: config.MULTIPART_FIELD_SIZE_BYTES,
    multipartMaxFiles: config.MULTIPART_MAX_FILES,
    multipartMaxParts: config.MULTIPART_MAX_FIELDS,
  };
}
