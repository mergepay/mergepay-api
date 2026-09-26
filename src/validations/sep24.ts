/**
 * Shared Zod schemas for SEP-24 (anchor) deposit and withdrawal requests.
 *
 * These schemas are used at the route boundary so malformed request data is
 * rejected before asset lookup, upstream calls, database writes, or business
 * logic are reached.
 */
import { z } from "zod";
import {
  stellarAmountSchema,
  stellarPublicKeySchema,
} from "../lib/stellar-validation";

/** A Stellar public key (G…), checksum-validated via StrKey. */
export const sep24AccountSchema = stellarPublicKeySchema;

/** SEP-24 asset code: alphanumeric, 1-12 chars, normalised to upper case. */
export const sep24AssetCodeSchema = z
  .string()
  .min(1, "assetCode is required")
  .max(12, "assetCode must be at most 12 characters")
  .regex(/^[A-Za-z0-9]+$/, "assetCode may only contain letters and digits")
  .transform((value) => value.toUpperCase());

/** SEP-24 amount: positive decimal with Stellar's 7-decimal precision. */
export const sep24AmountSchema = stellarAmountSchema;

/** SEP-24 memo: short alphanumeric anchor-side memo. */
export const sep24MemoSchema = z
  .string()
  .max(28, "memo must be at most 28 characters")
  .regex(/^[A-Za-z0-9]+$/, "memo may only contain letters and digits")
  .optional();

/** The Stellar transaction-memo kind accompanying `memo`. */
export const sep24MemoTypeSchema = z.enum(["text", "id", "hash"]);

function refineMemoPairing(
  value: { memo?: string; memoType?: "text" | "id" | "hash" },
  ctx: z.RefinementCtx
): void {
  if (value.memo && !value.memoType) {
    ctx.addIssue({
      code: "custom",
      path: ["memoType"],
      message: "memoType is required when memo is supplied",
    });
  }
  if (value.memoType && !value.memo) {
    ctx.addIssue({
      code: "custom",
      path: ["memo"],
      message: "memo is required when memoType is supplied",
    });
  }
}

function refineRefundMemoPairing(
  value: { refundMemo?: string; refundMemoType?: "text" | "id" | "hash" },
  ctx: z.RefinementCtx
): void {
  if (value.refundMemo && !value.refundMemoType) {
    ctx.addIssue({
      code: "custom",
      path: ["refundMemoType"],
      message: "refundMemoType is required when refundMemo is supplied",
    });
  }
  if (value.refundMemoType && !value.refundMemo) {
    ctx.addIssue({
      code: "custom",
      path: ["refundMemo"],
      message: "refundMemo is required when refundMemoType is supplied",
    });
  }
}

const sharedFields = {
  assetCode: sep24AssetCodeSchema,
  assetIssuer: z.string().nullable().optional(),
  amount: sep24AmountSchema.optional(),
  account: sep24AccountSchema.optional(),
  to: sep24AccountSchema.optional(),
  memo: sep24MemoSchema,
  memoType: sep24MemoTypeSchema.optional(),
  walletName: z.string().trim().min(1).max(120).optional(),
  anchorName: z.string().max(64).optional(),
  refundAddress: sep24AccountSchema.optional(),
  refundMemo: sep24MemoSchema,
  refundMemoType: sep24MemoTypeSchema.optional(),
  extraMetadata: z.record(z.string(), z.unknown()).optional(),
};

function validateNativeIssuer<
  T extends {
    assetCode: string;
    assetIssuer?: string | null;
    memo?: string;
    memoType?: "text" | "id" | "hash";
    refundMemo?: string;
    refundMemoType?: "text" | "id" | "hash";
  }
>(schema: z.ZodType<T>) {
  return schema
    .refine(
      (value) => !(value.assetCode === "XLM" && value.assetIssuer),
      {
        message: "XLM is a native asset and does not take an issuer",
        path: ["assetIssuer"],
      }
    )
    .superRefine(refineMemoPairing)
    .superRefine(refineRefundMemoPairing);
}

/** Strict request schema for starting either SEP-24 interactive flow. */
export const sep24InteractiveRequestSchema = validateNativeIssuer(
  z.object(sharedFields).strict()
);

/** Deposit initiation uses the shared interactive request contract. */
export const sep24DepositRequestSchema = sep24InteractiveRequestSchema;

/**
 * Strict concrete withdrawal request. Unlike a generic interactive start, a
 * withdrawal must include the amount that is being settled.
 */
export const sep24WithdrawRequestSchema = validateNativeIssuer(
  z.object({ ...sharedFields, amount: sep24AmountSchema }).strict()
);

export type Sep24InteractiveRequest = z.infer<typeof sep24InteractiveRequestSchema>;
export type Sep24DepositRequest = z.infer<typeof sep24DepositRequestSchema>;
export type Sep24WithdrawRequest = z.infer<typeof sep24WithdrawRequestSchema>;
