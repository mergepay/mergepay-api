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

const sep10DomainSchema = z
  .string()
  .min(1, "Domain cannot be empty when provided")
  .max(253, "Domain exceeds maximum length")
  .regex(
    /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/,
    "Domain must be a valid domain name"
  );

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
 * Optional SEP-10 `home_domain` and `client_domain` values are format-checked.
 * The legacy `clientDomain` spelling remains accepted for existing clients.
 * Any other key is rejected.
 *
 * Re-exported from `src/schemas/auth.ts`, the import point this endpoint's
 * contract is published under.
 */
export const sep10VerifyRequestSchema = z
  .object({
    transaction: transactionXdrSchema,
    home_domain: sep10DomainSchema.optional(),
    client_domain: sep10DomainSchema.optional(),
    // Accept the original API spelling for existing clients.
    clientDomain: sep10DomainSchema.optional(),
  })
  .strict();

export type Sep10VerifyRequest = z.infer<typeof sep10VerifyRequestSchema>;