/**
 * Auth request schemas — issue #519.
 *
 * The canonical Zod schemas for the SEP-10 endpoints live in
 * `src/validations/sep10.ts`, which the auth routes (src/routes/auth.ts) apply
 * inside their handlers so a malformed payload is rejected with a 400
 * VALIDATION_ERROR before any challenge is built and before the Stellar SDK is
 * asked to parse a signature. `sep10VerifyRequestSchema` is the one that gates
 * `POST /auth/verify`: it checks the signed transaction envelope's field
 * presence, length, base64 form, and XDR word alignment, and leaves the
 * envelope's structure and signatures to `authenticateChallenge`
 * (src/services/sep10.ts).
 *
 * This module re-exports them under the location the issue names so callers
 * have a single import point, following the same pattern as `src/schemas/sep24.ts`
 * and `src/schemas/common.ts`. The rules themselves must not be duplicated here
 * — two copies of a validation contract drift, and the weaker one is the one
 * clients get.
 */
export {
  SEP10_TRANSACTION_XDR_MAX_LENGTH,
  sep10ChallengeRequestSchema,
  sep10QuerySchema,
  sep10VerifyRequestSchema,
  type Sep10ChallengeRequest,
  type Sep10VerifyRequest,
} from "../validations/sep10";
