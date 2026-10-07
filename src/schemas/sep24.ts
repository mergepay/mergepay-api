/**
 * SEP-24 request schemas — issue #366.
 *
 * The canonical Zod schemas for SEP-24 deposit/withdrawal initialization and
 * status requests live in `src/validations/sep24.ts`, which both anchor route
 * files apply inside their handlers (src/routes/anchors.ts for
 * `/anchors/deposit|withdraw`, src/routes/sep24.ts for
 * `/api/sep24/deposit|withdraw`) so malformed query strings and payloads are
 * rejected with a 400 VALIDATION_ERROR before any anchor I/O happens.
 *
 * This module re-exports them under the location the issue names so callers
 * have a single import point and there is exactly one source of truth — the
 * earlier divergent schema that lived here (regex-only account checks, no
 * amount/memo rules) was never wired into a route and has been removed rather
 * than left as a weaker duplicate.
 */
export {
  sep24AccountSchema,
  sep24AmountSchema,
  sep24AssetCodeSchema,
  sep24CallbackQuerySchema,
  sep24DepositRequestSchema,
  sep24ExtraMetadataSchema,
  sep24InitQuerySchema,
  sep24InteractiveRequestSchema,
  sep24MemoSchema,
  sep24MemoTypeSchema,
  sep24StellarTransactionHashSchema,
  sep24WithdrawRequestSchema,
  type Sep24CallbackQuery,
  type Sep24InitQuery,
  type Sep24InteractiveRequest,
  type Sep24DepositRequest,
  type Sep24WithdrawRequest,
} from "../validations/sep24";

import { z } from "zod";
import type { FastifyRequest, FastifyReply } from "fastify";
import {
  sep24DepositRequestSchema,
  sep24WithdrawRequestSchema,
  sep24InitQuerySchema,
  sep24StellarTransactionHashSchema,
} from "../validations/sep24";

/**
 * Request validation middleware for SEP-24 deposit initiation endpoint.
 * Validates query parameters and request body using Zod schemas.
 */
export async function validateSep24Deposit(
  req: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  req.query = sep24InitQuerySchema.parse(req.query ?? {});
  req.body = sep24DepositRequestSchema.parse(req.body);
}

/**
 * Request validation middleware for SEP-24 withdrawal initiation endpoint.
 * Validates query parameters and request body using Zod schemas.
 */
export async function validateSep24Withdraw(
  req: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  req.query = sep24InitQuerySchema.parse(req.query ?? {});
  req.body = sep24WithdrawRequestSchema.parse(req.body);
}

// -- deposit / withdrawal status callbacks ----------------------------------

/**
 * The SEP-24 transaction object, in both shapes anchors send it: wrapped in a
 * `transaction` envelope (the SEP-24 `GET /transaction` response shape, which
 * most anchors reuse for callbacks) or flattened at the top level.
 *
 * `passthrough` is deliberate — anchors add fields freely, and an unrecognized
 * one must never reject an otherwise valid callback. Only what Mergepay reads
 * is validated.
 */
export const sep24CallbackTransactionSchema = z
  .object({
    id: z.string().min(1).max(255),
    status: z.string().min(1).max(64),
    kind: z.string().max(64).optional(),
    amount_in: z.string().max(64).nullish(),
    amount_out: z.string().max(64).nullish(),
    amount_fee: z.string().max(64).nullish(),
    stellar_transaction_id: sep24StellarTransactionHashSchema.nullish(),
    external_transaction_id: z.string().max(255).nullish(),
    message: z.string().max(1024).nullish(),
  })
  .passthrough();

/**
 * Canonical validation for SEP-24 deposit and withdrawal status callbacks.
 *
 * This is the single source of truth for every callback surface —
 * `POST /api/sep24/callback` (JWT-authenticated), `POST /api/webhooks/sep24`
 * (HMAC-authenticated), and `POST /anchors/webhook` (shared-secret) — so a
 * payload that one anchor callback accepts cannot be rejected by another.
 *
 * A callback must carry a transaction id and a status, either at the top
 * level or under `transaction`; anything else is a malformed payload and
 * fails with the project's standard structured `VALIDATION_ERROR` (HTTP 400)
 * *before* any database or anchor call. Unknown fields are passed through
 * rather than rejected — see `sep24CallbackTransactionSchema`.
 */
export const sep24CallbackSchema = z
  .object({
    transaction: sep24CallbackTransactionSchema.optional(),
    id: z.string().min(1).max(255).optional(),
    status: z.string().min(1).max(64).optional(),
    // Anchors send the failure explanation either here or inside
    // `transaction`; both placements are read, so both are typed.
    message: z.string().max(1024).nullish(),
  })
  .passthrough()
  .transform((body, ctx) => {
    const transaction = body.transaction;
    const id = transaction?.id ?? body.id;
    const status = transaction?.status ?? body.status;

    if (!id || !status) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "SEP-24 callback must carry a transaction id and status, either at the top level or under `transaction`",
      });
      return z.NEVER;
    }

    return {
      externalTransactionId: id,
      rawStatus: status,
      message: transaction?.message ?? body.message ?? null,
      stellarTransactionId: transaction?.stellar_transaction_id ?? null,
      amountIn: transaction?.amount_in ?? null,
      amountOut: transaction?.amount_out ?? null,
      amountFee: transaction?.amount_fee ?? null,
    };
  });

/** The normalized callback every SEP-24 callback handler receives. */
export type Sep24Callback = z.infer<typeof sep24CallbackSchema>;
