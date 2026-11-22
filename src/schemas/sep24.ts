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
  sep24AssetCodeShapeSchema,
  sep24CallbackQuerySchema,
  sep24CompleteRequestSchema,
  sep24DepositRequestSchema,
  sep24ExtraMetadataSchema,
  sep24InitQuerySchema,
  sep24InteractiveRequestSchema,
  sep24LangSchema,
  sep24MemoSchema,
  sep24MemoTypeSchema,
  sep24NoParamsSchema,
  sep24NoQuerySchema,
  sep24OpaqueIdSchema,
  sep24SessionParamsSchema,
  sep24SessionQuerySchema,
  sep24StellarTransactionHashSchema,
  sep24TransactionQuerySchema,
  sep24TransactionsQuerySchema,
  sep24WithdrawalParamsSchema,
  sep24WithdrawalRequestBodySchema,
  sep24WithdrawRequestSchema,
  type Sep24CallbackQuery,
  type Sep24CompleteRequest,
  type Sep24InitQuery,
  type Sep24InteractiveRequest,
  type Sep24DepositRequest,
  type Sep24SessionParams,
  type Sep24SessionQuery,
  type Sep24TransactionQuery,
  type Sep24TransactionsQuery,
  type Sep24WithdrawalParams,
  type Sep24WithdrawalRequestBody,
  type Sep24WithdrawRequest,
} from "../validations/sep24";

import { z } from "zod";
import { validateRequest } from "../middleware/validate-request";
import {
  sep24AccountSchema,
  sep24AmountSchema,
  sep24AssetCodeShapeSchema,
  sep24DepositRequestSchema,
  sep24WithdrawRequestSchema,
  sep24InitQuerySchema,
  sep24LangSchema,
  sep24MemoSchema,
  sep24MemoTypeSchema,
  sep24StellarTransactionHashSchema,
} from "../validations/sep24";

/**
 * Request validation middleware for the SEP-24 deposit initiation endpoints.
 *
 * Applied as a `preHandler` to both aliases — `POST /anchors/deposit` and
 * `POST /api/sep24/deposit` — so the two cannot drift: they share one schema
 * pair and one hook. Query first, then body, and both run before the anchor is
 * contacted, so a malformed request never reaches an upstream call, the
 * database, or the audit log.
 *
 * The hook throws the raw `ZodError`; src/plugins/error-handler.ts renders it
 * as the standard `400 VALIDATION_ERROR` envelope with `details` and `issues`.
 */
export const validateSep24Deposit = validateRequest({
  query: sep24InitQuerySchema,
  body: sep24DepositRequestSchema,
});

/**
 * Request validation middleware for the SEP-24 withdrawal initiation
 * endpoints (`POST /anchors/withdraw`, `POST /api/sep24/withdraw`).
 *
 * Identical to {@link validateSep24Deposit} except for the body schema, which
 * additionally requires the amount being settled.
 */
export const validateSep24Withdraw = validateRequest({
  query: sep24InitQuerySchema,
  body: sep24WithdrawRequestSchema,
});

export const validateSep24DepositMiddleware = validateSep24Deposit;
export const validateSep24WithdrawMiddleware = validateSep24Withdraw;
/** Aliases for explicit middleware naming (#867). */
export const sep24DepositValidationMiddleware = validateSep24Deposit;
export const sep24WithdrawValidationMiddleware = validateSep24Withdraw;

/**
 * Dedicated schema for SEP-24 deposit initiation parameters.
 */
export const sep24DepositInitiationSchema = z.object({
  query: sep24InitQuerySchema.optional(),
  body: sep24DepositRequestSchema,
});

/**
 * Dedicated schema for SEP-24 withdrawal initiation parameters.
 */
export const sep24WithdrawalInitiationSchema = z.object({
  query: sep24InitQuerySchema.optional(),
  body: sep24WithdrawRequestSchema,
});

/**
 * Validate SEP-24 deposit request payload.
 */
export function validateSep24DepositRequest(body: unknown) {
  return sep24DepositRequestSchema.parse(body);
}

/**
 * Validate SEP-24 withdrawal request payload.
 */
export function validateSep24WithdrawalRequest(body: unknown) {
  return sep24WithdrawRequestSchema.parse(body);
}

/**
 * Validate SEP-24 initiation query parameters.
 */
export function validateSep24InitQuery(query: unknown) {
  return sep24InitQuerySchema.parse(query);
}

/**
 * Creates a Fastify preHandler validation middleware for SEP-24 endpoints (#807).
 */
export function createSep24ValidationMiddleware(kind: "deposit" | "withdrawal") {
  return kind === "deposit"
    ? sep24DepositValidationMiddleware
    : sep24WithdrawValidationMiddleware;
}

/**
 * Dedicated Zod validation schema for SEP-24 deposit request parameters (#807).
 * Validates wire format inputs (supporting snake_case & camelCase) and normalizes them.
 */
const sep24DepositWireParamsSchema = z
  .object({
    asset_code: sep24AssetCodeShapeSchema.optional(),
    assetCode: sep24AssetCodeShapeSchema.optional(),
    account: sep24AccountSchema.optional(),
    amount: sep24AmountSchema.optional(),
    memo: sep24MemoSchema.optional(),
    memo_type: sep24MemoTypeSchema.optional(),
    memoType: sep24MemoTypeSchema.optional(),
    lang: sep24LangSchema.optional(),
    wallet_name: z.string().max(255).optional(),
    walletName: z.string().max(255).optional(),
    wallet_url: z.string().url().max(2048).optional(),
    walletUrl: z.string().url().max(2048).optional(),
    claimable_balance_supported: z.union([z.boolean(), z.enum(["true", "false"])]).optional(),
    asset_issuer: sep24AccountSchema.nullable().optional(),
    assetIssuer: sep24AccountSchema.nullable().optional(),
  })
  .passthrough()
  .transform((data) => {
    const rawAssetCode = data.asset_code ?? data.assetCode;
    const memo = data.memo;
    const memoType = data.memo_type ?? data.memoType;
    const assetIssuer = data.asset_issuer ?? data.assetIssuer;
    return {
      ...data,
      assetCode: rawAssetCode ? rawAssetCode.toUpperCase() : undefined,
      memo,
      memoType,
      assetIssuer,
    };
  })
  .superRefine((data, ctx) => {
    if (!data.assetCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["asset_code"],
        message: "asset_code is required",
      });
    }
    if (data.assetCode === "XLM" && data.assetIssuer) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["asset_issuer"],
        message: "XLM is a native asset and does not take an issuer",
      });
    }
    if (data.memo && !data.memoType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["memo_type"],
        message: "memo_type is required when memo is supplied",
      });
    }
    if (data.memoType && !data.memo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["memo"],
        message: "memo is required when memo_type is supplied",
      });
    }
  });

/**
 * Dedicated Zod validation schema for SEP-24 withdrawal request parameters (#807).
 * Requires amount and validates wire format inputs.
 */
const sep24WithdrawWireParamsSchema = z
  .object({
    asset_code: sep24AssetCodeShapeSchema.optional(),
    assetCode: sep24AssetCodeShapeSchema.optional(),
    account: sep24AccountSchema.optional(),
    amount: sep24AmountSchema.optional(),
    dest: sep24AccountSchema.optional(),
    dest_extra: z.string().max(255).optional(),
    memo: sep24MemoSchema.optional(),
    memo_type: sep24MemoTypeSchema.optional(),
    memoType: sep24MemoTypeSchema.optional(),
    lang: sep24LangSchema.optional(),
    wallet_name: z.string().max(255).optional(),
    walletName: z.string().max(255).optional(),
    wallet_url: z.string().url().max(2048).optional(),
    walletUrl: z.string().url().max(2048).optional(),
    asset_issuer: sep24AccountSchema.nullable().optional(),
    assetIssuer: sep24AccountSchema.nullable().optional(),
  })
  .passthrough()
  .transform((data) => {
    const rawAssetCode = data.asset_code ?? data.assetCode;
    const memo = data.memo;
    const memoType = data.memo_type ?? data.memoType;
    const assetIssuer = data.asset_issuer ?? data.assetIssuer;
    return {
      ...data,
      assetCode: rawAssetCode ? rawAssetCode.toUpperCase() : undefined,
      memo,
      memoType,
      assetIssuer,
    };
  })
  .superRefine((data, ctx) => {
    if (!data.assetCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["asset_code"],
        message: "asset_code is required",
      });
    }
    if (!data.amount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amount"],
        message: "amount is required for withdrawal",
      });
    }
    if (data.assetCode === "XLM" && data.assetIssuer) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["asset_issuer"],
        message: "XLM is a native asset and does not take an issuer",
      });
    }
    if (data.memo && !data.memoType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["memo_type"],
        message: "memo_type is required when memo is supplied",
      });
    }
    if (data.memoType && !data.memo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["memo"],
        message: "memo is required when memo_type is supplied",
      });
    }
  });

const sep24DepositRequestParamsSchema = z.object({
  query: sep24InitQuerySchema.optional(),
  body: sep24DepositRequestSchema,
});

const sep24WithdrawRequestParamsSchema = z.object({
  query: sep24InitQuerySchema.optional(),
  body: sep24WithdrawRequestSchema,
});

const isSep24RequestEnvelope = (value: unknown): value is { body: unknown } =>
  typeof value === "object" && value !== null && "body" in value;

/** Parse one of the two supported SEP-24 parameter shapes without masking its validation errors. */
const parseSep24Params = <T>(
  wireSchema: z.ZodType<T>,
  requestSchema: z.ZodType<T>,
) =>
  z.preprocess((input, ctx) => {
    const schema = isSep24RequestEnvelope(input) ? requestSchema : wireSchema;
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      parsed.error.issues.forEach((issue) => ctx.addIssue(issue));
      return z.NEVER;
    }
    return parsed.data;
  }, z.any());

type Sep24DepositParamsOutput =
  | z.infer<typeof sep24DepositWireParamsSchema>
  | z.infer<typeof sep24DepositRequestParamsSchema>;
type Sep24WithdrawParamsOutput =
  | z.infer<typeof sep24WithdrawWireParamsSchema>
  | z.infer<typeof sep24WithdrawRequestParamsSchema>;

/** Accept both the SEP-24 wire shape and the request-envelope shape used by route callers. */
export const sep24DepositParamsSchema = parseSep24Params(
  sep24DepositWireParamsSchema,
  sep24DepositRequestParamsSchema,
) as z.ZodType<Sep24DepositParamsOutput>;

export const sep24WithdrawParamsSchema = parseSep24Params(
  sep24WithdrawWireParamsSchema,
  sep24WithdrawRequestParamsSchema,
) as z.ZodType<Sep24WithdrawParamsOutput>;

export type Sep24DepositParams = z.infer<typeof sep24DepositParamsSchema>;
export type Sep24WithdrawParams = z.infer<typeof sep24WithdrawParamsSchema>;

export const sep24DepositParametersSchema = sep24DepositParamsSchema;
export const sep24WithdrawParametersSchema = sep24WithdrawParamsSchema;

export function validateSep24DepositParams(data: unknown): Sep24DepositParams {
  return sep24DepositParamsSchema.parse(data);
}

export function validateSep24WithdrawParams(data: unknown): Sep24WithdrawParams {
  return sep24WithdrawParamsSchema.parse(data);
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


/**
 * Zod schema for SEP-24 interactive deposit callback parameters.
 */
export const sep24InteractiveDepositCallbackParamsSchema = z
  .object({
    id: z.string().min(1).max(255).optional(),
    status: z.string().min(1).max(64).optional(),
    kind: z.literal("deposit").optional(),
    amount_in: z.string().max(64).nullish(),
    amount_out: z.string().max(64).nullish(),
    amount_fee: z.string().max(64).nullish(),
    stellar_transaction_id: sep24StellarTransactionHashSchema.nullish(),
    external_transaction_id: z.string().max(255).nullish(),
    message: z.string().max(1024).nullish(),
    transaction: sep24CallbackTransactionSchema.optional(),
  })
  .passthrough();

/**
 * Zod schema for SEP-24 interactive withdrawal callback parameters.
 */
export const sep24InteractiveWithdrawalCallbackParamsSchema = z
  .object({
    id: z.string().min(1).max(255).optional(),
    status: z.string().min(1).max(64).optional(),
    kind: z.literal("withdrawal").optional(),
    amount_in: z.string().max(64).nullish(),
    amount_out: z.string().max(64).nullish(),
    amount_fee: z.string().max(64).nullish(),
    stellar_transaction_id: sep24StellarTransactionHashSchema.nullish(),
    external_transaction_id: z.string().max(255).nullish(),
    message: z.string().max(1024).nullish(),
    transaction: sep24CallbackTransactionSchema.optional(),
  })
  .passthrough();

export type Sep24InteractiveDepositCallbackParams = z.infer<
  typeof sep24InteractiveDepositCallbackParamsSchema
>;
export type Sep24InteractiveWithdrawalCallbackParams = z.infer<
  typeof sep24InteractiveWithdrawalCallbackParamsSchema
>;

/**
 * Validate SEP-24 interactive callback parameters for deposit or withdrawal flows.
 */
export function validateSep24InteractiveCallbackParams(
  params: unknown,
  kind?: "deposit" | "withdrawal"
) {
  if (kind === "deposit") {
    return sep24InteractiveDepositCallbackParamsSchema.parse(params);
  }
  if (kind === "withdrawal") {
    return sep24InteractiveWithdrawalCallbackParamsSchema.parse(params);
  }
  return sep24CallbackSchema.parse(params);
}


