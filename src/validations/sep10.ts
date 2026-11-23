import { config } from "../config";
import { Errors } from "../errors";
/**
 * Zod validation schemas for the SEP-10 authentication endpoints.
 *
 * `/auth/challenge` and `/auth/verify` parse their body and query string
 * against these strict schemas before any challenge is built or any XDR,
 * signature, or database work happens in src/services/sep10.ts. Unknown keys
 * are rejected rather than stripped, so a misspelled or smuggled field fails
 * loudly with 400 VALIDATION_ERROR instead of being silently ignored.
 *
 * Neither endpoint reads a request header: the client is identified solely by
 * the body, and rate limiting is keyed by IP. There is deliberately no header
 * schema — validating headers the handler never consumes would only reject
 * ordinary proxies and user agents.
 */
import { z } from "zod";
import { stellarAccountIdSchema } from "../lib/stellar-validation";
import { clientDomainSchema, sep10DomainSchema } from "../lib/sep10-domain";

/** A Stellar ed25519 public key is always exactly 56 characters (G + 55). */
const STELLAR_ACCOUNT_ID_LENGTH = 56;

/**
 * SEP-10 challenge request payload (`POST /auth/challenge`).
 *
 * `account` is the client's Stellar public key. The length check runs before
 * the checksum refinement so an oversized string is rejected cheaply.
 */
export const sep10ChallengeRequestSchema = z
  .object({
    account: z
      .string({
        required_error: "account is required",
        invalid_type_error: "account must be a string",
      })
      .length(
        STELLAR_ACCOUNT_ID_LENGTH,
        `account must be a ${STELLAR_ACCOUNT_ID_LENGTH}-character Stellar public key`
      )
      .pipe(stellarAccountIdSchema),
  })
  .strict();

/**
 * Query string for both SEP-10 POST endpoints. They take all input in the
 * body, so any query parameter is a client mistake — most often a SEP-10
 * `GET /auth?account=...` habit — and is rejected rather than ignored.
 */
export const sep10QuerySchema = z.object({}).strict();

export type Sep10ChallengeRequest = z.infer<typeof sep10ChallengeRequestSchema>;

/**
 * XDR packs every value into whole 4-byte words (RFC 4506 §8) and pads to
 * them, so a genuine envelope — a `TransactionEnvelope`, a fee-bump wrapper,
 * anything this SDK can hand back — always decodes to a multiple of 4 bytes.
 * A string that decodes to 1, 2, or 3 stray bytes is a mistyped, truncated, or
 * hand-rolled payload, and is cheaper to reject here than inside the SDK.
 */
const XDR_WORD_BYTES = 4;

/** Longest accepted base64 envelope. A SEP-10 challenge is a few hundred bytes. */
export const SEP10_TRANSACTION_XDR_MAX_LENGTH = 50000;

/** Standard base64 (RFC 4648 §4) with canonical padding. */
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Decode base64 and require canonical form.
 *
 * Node's decoder is lenient: it tolerates missing padding and non-zero trailing
 * bits that a different decoder would reject. Re-encoding and comparing is the
 * only reliable way to know the string is one a well-behaved client produced,
 * rather than something that merely survives a round trip.
 */
function decodeCanonicalBase64(value: string): Buffer | null {
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded : null;
}

/**
 * Whether the string is canonical base64 — true for anything an earlier rule
 * has already rejected.
 *
 * A non-base64 string is not "non-canonical", it is not base64 at all, so the
 * alphabet rule above is the one that reports it. Staying quiet here is what
 * keeps `details` a list of distinct problems rather than one problem restated
 * in three vocabularies.
 */
function isCanonicalBase64(value: string): boolean {
  if (!BASE64_PATTERN.test(value)) return true;
  return decodeCanonicalBase64(value) !== null;
}

/**
 * Whether the envelope decodes to a whole number of XDR words — true for
 * anything an earlier rule has already rejected, for the same reason.
 */
function isWholeXdrWords(value: string): boolean {
  if (value.length === 0 || !BASE64_PATTERN.test(value)) return true;
  const decoded = decodeCanonicalBase64(value);
  if (decoded === null) return true;
  return decoded.length >= XDR_WORD_BYTES && decoded.length % XDR_WORD_BYTES === 0;
}

/**
 * The signed challenge envelope itself.
 *
 * Rules run cheapest first — presence, length, alphabet, canonical encoding,
 * then XDR word alignment — and each reports only when it is the first thing
 * wrong with the value, so a client is told what to fix rather than every
 * consequence of it.
 *
 * What this deliberately does *not* do is parse the XDR. Structure, domains,
 * time bounds, and signatures are the SDK's job and are answered with 401 by
 * `authenticateChallenge` (src/services/sep10.ts); duplicating that work here
 * would only restate it in two places, and a schema that accepted or rejected
 * an envelope the SDK would decide differently would be worse than no schema
 * at all. This layer answers one question only: is this field a plausible
 * base64 XDR envelope, so that a client mistake is a 400 rather than an
 * opaque 401?
 */
const transactionXdrSchema = z
  .string({
    required_error: "transaction is required",
    invalid_type_error: "transaction must be a string",
  })
  .min(1, "Transaction envelope is required")
  .max(SEP10_TRANSACTION_XDR_MAX_LENGTH, "Transaction envelope exceeds maximum size")
  .regex(BASE64_PATTERN, "Transaction envelope must be standard base64 XDR (not base64url)")
  .refine(isCanonicalBase64, "Transaction envelope must use canonical base64 encoding")
  .refine(
    isWholeXdrWords,
    "Transaction envelope must decode to a whole number of XDR words (4 bytes each)"
  );

/**
 * SEP-10 verify request payload.
 *
 * The `transaction` field is the signed Stellar transaction envelope (XDR string)
 * returned by the client wallet after signing the challenge from `/auth/challenge`.
 * It must be canonical base64 of a whole number of XDR words; the envelope's
 * structure and its signatures are verified by `authenticateChallenge`
 * (src/services/sep10.ts), which is the single authority on whether this is a
 * challenge this server issued.
 *
 * Optional SEP-10 `home_domain` and `client_domain` values are format-checked
 * here because their *shape* is this layer's question. What the server does
 * with them is decided by the route (src/routes/auth.ts) before any envelope is
 * touched: `client_domain` is rejected outright, since this server performs no
 * client-domain verification, and a `home_domain` that is not the domain the
 * challenges are issued for is rejected as a mismatch. The legacy `clientDomain`
 * spelling remains accepted as a key so that the response a such a client gets
 * is that explicit "not supported" error rather than a confusing "unknown
 * field" one.
 * Any other key is rejected.
 *
 * Re-exported from `src/schemas/auth.ts`, the import point this endpoint's
 * contract is published under.
 */
export const sep10VerifyRequestSchema = z
  .object({
    transaction: transactionXdrSchema,
    home_domain: sep10DomainSchema.optional(),
    client_domain: clientDomainSchema.optional(),
    // Accept the original API spelling for existing clients.
    clientDomain: clientDomainSchema.optional(),
  })
  .strict();

export type Sep10VerifyRequest = z.infer<typeof sep10VerifyRequestSchema>;

/**
 * Answer SEP-10 domain claims before a challenge envelope is ever consumed.
 * Shared by the body-validating hooks and the legacy auth routes so an
 * unsupported `client_domain` or a wrong `home_domain` always gets the same
 * explicit 400 rather than silently being dropped.
 */
export function validateSep10DomainClaims(claims: {
  home_domain?: string;
  client_domain?: string;
  clientDomain?: string;
}): void {
  if (claims.client_domain !== undefined || claims.clientDomain !== undefined) {
    throw Errors.badRequest(
      "client_domain_unsupported",
      "This server does not support SEP-10 client_domain authentication"
    );
  }
  if (
    claims.home_domain !== undefined &&
    claims.home_domain.toLowerCase() !== config.SEP10_HOME_DOMAIN.toLowerCase()
  ) {
    throw Errors.badRequest(
      "home_domain_mismatch",
      `home_domain must match the domain this server issues challenges for (${config.SEP10_HOME_DOMAIN})`
    );
  }
}

/**
 * Cheap shape check for XDR received outside a JSON body. Header transport has
 * no request-body schema, so this keeps oversized and non-canonical envelopes
 * out of the cryptographic verifier without changing its 401 error contract.
 */
export function assertSep10TransactionEnvelope(value: string): void {
  if (!transactionXdrSchema.safeParse(value).success) invalidSep10Envelope();
}

function invalidSep10Envelope(): never {
  throw Errors.invalidChallenge();
}

/**
 * Query schema for SEP-10 challenge requests via GET query parameters (#875).
 */
export const sep10ChallengeQuerySchema = z
  .object({
    account: z
      .string({
        required_error: "account is required",
        invalid_type_error: "account must be a string",
      })
      .length(
        STELLAR_ACCOUNT_ID_LENGTH,
        `account must be a ${STELLAR_ACCOUNT_ID_LENGTH}-character Stellar public key`
      )
      .pipe(stellarAccountIdSchema),
    home_domain: sep10DomainSchema.optional(),
    client_domain: clientDomainSchema.optional(),
  })
  .strict();

export type Sep10ChallengeQuery = z.infer<typeof sep10ChallengeQuerySchema>;

/**
 * Fastify preHandler hook / middleware validating incoming SEP-10 challenge requests (#875).
 */
export async function validateSep10ChallengeHook(req: any) {
  if (req.method === "GET") {
    const parsed = sep10ChallengeQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path.join(".") || "account";
      throw Errors.badRequest("VALIDATION_ERROR", `${field}: ${issue?.message ?? "Invalid SEP-10 challenge parameters"}`);
    }
    validateSep10DomainClaims(parsed.data);
    req.sep10Challenge = parsed.data;
  } else {
    const parsedQuery = sep10QuerySchema.safeParse(req.query ?? {});
    if (!parsedQuery.success) {
      throw Errors.badRequest("VALIDATION_ERROR", "Unexpected query parameters on POST /auth/challenge");
    }
    const parsedBody = sep10ChallengeRequestSchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      const issue = parsedBody.error.issues[0];
      const field = issue?.path.join(".") || "account";
      throw Errors.badRequest("VALIDATION_ERROR", `${field}: ${issue?.message ?? "Invalid SEP-10 challenge payload"}`);
    }
    req.sep10Challenge = parsedBody.data;
  }
}

/**
 * Fastify preHandler hook / middleware validating incoming SEP-10 verify requests (#875).
 */
export async function validateSep10VerifyHook(req: any) {
  const parsedQuery = sep10QuerySchema.safeParse(req.query ?? {});
  if (!parsedQuery.success) {
    throw Errors.badRequest("VALIDATION_ERROR", "Unexpected query parameters on POST /auth/verify");
  }
  const parsedBody = sep10VerifyRequestSchema.safeParse(req.body ?? {});
  if (!parsedBody.success) {
    const issue = parsedBody.error.issues[0];
    const field = issue?.path.join(".") || "transaction";
    throw Errors.badRequest("VALIDATION_ERROR", `${field}: ${issue?.message ?? "Invalid SEP-10 verify payload"}`);
  }
  validateSep10DomainClaims(parsedBody.data);
  req.sep10Verify = parsedBody.data;
}
