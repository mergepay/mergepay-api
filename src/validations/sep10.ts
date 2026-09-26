/**
 * Zod validation schema for SEP-10 authentication challenge verification.
 *
 * Validates the `/auth/verify` request body, ensuring the transaction is
 * canonical base64 before it reaches the XDR and signature checks in
 * src/services/sep10.ts.
 */
import { z } from "zod";

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
 */
export const sep10VerifyRequestSchema = z.object({
  transaction: transactionXdrSchema,
  home_domain: sep10DomainSchema.optional(),
  client_domain: sep10DomainSchema.optional(),
  // Accept the original API spelling for existing clients.
  clientDomain: sep10DomainSchema.optional(),
});

export type Sep10VerifyRequest = z.infer<typeof sep10VerifyRequestSchema>;