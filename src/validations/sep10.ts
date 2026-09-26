/**
 * Zod validation schema for SEP-10 authentication challenge verification.
 *
 * Validates the request body for the `/auth/verify` endpoint, ensuring the
 * transaction envelope is a non-empty string before it reaches the
 * cryptographic verification logic in src/services/sep10.ts.
 */
import { z } from "zod";

/**
 * SEP-10 verify request payload.
 *
 * The `transaction` field is the signed Stellar transaction envelope (XDR string)
 * returned by the client wallet after signing the challenge from `/auth/challenge`.
 * It must be a non-empty string; further structural and cryptographic validation
 * happens in `verifyChallenge` (src/services/sep10.ts).
 *
 * The optional `clientDomain` field is used by some SEP-10 implementations to
 * communicate the client's domain to the server for additional verification.
 * Per SEP-10, this is optional and when present must be a valid domain string.
 */
export const sep10VerifyRequestSchema = z.object({
  transaction: z
    .string()
    .min(1, "Transaction envelope is required")
    .max(50000, "Transaction envelope exceeds maximum size"),
  clientDomain: z
    .string()
    .min(1, "Client domain cannot be empty when provided")
    .max(253, "Client domain exceeds maximum length")
    .regex(
      /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/,
      "Client domain must be a valid domain name"
    )
    .optional(),
});

export type Sep10VerifyRequest = z.infer<typeof sep10VerifyRequestSchema>;