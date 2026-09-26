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

const transactionXdrSchema = z
  .string()
  .min(1, "Transaction envelope is required")
  .max(50000, "Transaction envelope exceeds maximum size")
  .regex(
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
    "Transaction envelope must be base64-encoded XDR"
  )
  .refine(
    (value) => Buffer.from(value, "base64").toString("base64") === value,
    "Transaction envelope must use canonical base64 encoding"
  );

/**
 * SEP-10 verify request payload.
 *
 * The `transaction` field is the signed Stellar transaction envelope (XDR string)
 * returned by the client wallet after signing the challenge from `/auth/challenge`.
 * It must be canonical base64; XDR structure and cryptographic validation
 * happen in `verifyChallenge` (src/services/sep10.ts).
 *
 * Optional SEP-10 `home_domain` and `client_domain` values are format-checked.
 * The legacy `clientDomain` spelling remains accepted for existing clients.
 * Any other key is rejected.
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