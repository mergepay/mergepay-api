/**
 * Dedicated SEP-10 authentication route module with Zod validation middleware (#875).
 *
 * Implements Zod validation preHandler hooks to ensure invalid requests, malformed
 * public keys, and non-canonical base64 XDR envelopes are rejected with standard
 * 400 VALIDATION_ERROR before reaching cryptographic challenge handling.
 *
 * Stable `error.code` values documented for web client parity:
 *
 * | Code | HTTP | Cause |
 * | --- | --- | --- |
 * | `VALIDATION_ERROR` | 400 | Request schema rejected the account or XDR field. |
 * | `INVALID_CHALLENGE` | 401 | Malformed, unrelated, replayed, or otherwise unclassifiable signed challenge. |
 * | `CHALLENGE_EXPIRED` | 401 | Signed challenge's max time is past the validity window. |
 * | `CHALLENGE_NOT_YET_VALID` | 401 | Signed challenge's min time is still ahead of the server clock. |
 * | `CHALLENGE_WINDOW_TOO_LONG` | 401 | Signed challenge declares a longer window than this server issues. |
 * | `HOME_DOMAIN_MISMATCH` | 400/401 | Challenge was issued for another home domain. |
 * | `NETWORK_MISMATCH` | 401 | Challenge was signed for another Stellar network. |
 * | `INVALID_SIGNATURE` | 401 | Signer or threshold check failed. |
 */
import type { FastifyInstance } from "fastify";
import { buildChallenge, authenticateChallenge } from "../services/sep10";
import { classifySep10Error } from "../services/auth";
import {
  sep10ChallengeRequestSchema,
  sep10ChallengeQuerySchema,
  sep10VerifyRequestSchema,
  validateSep10ChallengeHook,
  validateSep10VerifyHook,
} from "../validations/sep10";
import { openApiBody, openApiErrorResponses, openApiResponse } from "../lib/openapi";

export {
  validateSep10ChallengeHook,
  validateSep10VerifyHook,
};

export default async function sep10Routes(app: FastifyInstance) {
  // GET /sep10/challenge with preHandler query validation
  app.get(
    "/sep10/challenge",
    {
      preHandler: [validateSep10ChallengeHook],
      schema: {
        tags: ["Auth"],
        summary: "Request SEP-10 challenge via query parameter",
        description: "Validates account query parameter via Zod and issues challenge transaction.",
        response: {
          ...openApiResponse({
            transaction: { type: "string" },
            networkPassphrase: { type: "string" },
          }),
          ...openApiErrorResponses(400, 429),
        },
      },
    },
    async (req: any) => {
      const { account } = req.sep10Challenge;
      return buildChallenge(account);
    }
  );

  // POST /sep10/challenge with preHandler body validation
  app.post(
    "/sep10/challenge",
    {
      preHandler: [validateSep10ChallengeHook],
      schema: {
        tags: ["Auth"],
        summary: "Request SEP-10 challenge via request body",
        description: "Validates account payload via Zod and issues challenge transaction.",
        body: openApiBody(sep10ChallengeRequestSchema, { enforce: false }),
        response: {
          ...openApiResponse({
            transaction: { type: "string" },
            networkPassphrase: { type: "string" },
          }),
          ...openApiErrorResponses(400, 429),
        },
      },
    },
    async (req: any) => {
      const { account } = req.sep10Challenge;
      return buildChallenge(account);
    }
  );

  // POST /sep10/verify with preHandler body validation
  app.post(
    "/sep10/verify",
    {
      preHandler: [validateSep10VerifyHook],
      schema: {
        tags: ["Auth"],
        summary: "Verify signed SEP-10 challenge transaction",
        description: "Validates transaction XDR via Zod before verifying signatures.",
        body: openApiBody(sep10VerifyRequestSchema, { enforce: false }),
        response: {
          ...openApiResponse({
            token: { type: "string" },
          }),
          ...openApiErrorResponses(400, 401, 429),
        },
      },
    },
    async (req: any) => {
      const { transaction } = req.sep10Verify;
      try {
        const result = await authenticateChallenge(transaction);
        req.log.info({ sep10Account: result.account, ip: req.ip }, "SEP-10 challenge verified successfully");
        return result;
      } catch (err) {
        const classified = classifySep10Error(err);
        req.log.warn(
          {
            authFailure: "sep10_verify_failed",
            errorCode: classified.code,
            errorMessage: classified.message,
            ip: req.ip,
          },
          "SEP-10 challenge verification failed"
        );
        throw classified;
      }
    }
  );
}
