import { z } from "zod";

const memoType = z.enum(["text", "id", "hash"]);

/** Shared SEP-24 parameter contract for deposit and withdrawal starts. */
export const sep24InteractiveSchema = z
  .object({
    assetCode: z.string().trim().min(1).max(12),
    anchorName: z.string().trim().min(1).max(120).optional(),
    account: z.string().regex(/^G[A-Z2-7]{55}$/).optional(),
    memo: z.string().trim().min(1).max(64).optional(),
    memoType: memoType.optional(),
    walletName: z.string().trim().min(1).max(120).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.memo && !value.memoType) {
      ctx.addIssue({ code: "custom", path: ["memoType"], message: "memoType is required when memo is supplied" });
    }
    if (value.memoType && !value.memo) {
      ctx.addIssue({ code: "custom", path: ["memo"], message: "memo is required when memoType is supplied" });
    }
  });

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
    stellar_transaction_id: z.string().max(128).nullish(),
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
