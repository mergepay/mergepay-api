import { z } from "zod";
import {
  canonicalAmountSchema,
  fromStroops,
  refineValidatedAsset,
  validateAmount,
} from "../lib/money";
import { sanitizedTextField } from "../lib/sanitize-text";
import { PERCENT_TOTAL_TOLERANCE } from "../services/settlement";

export const SplitType = z.enum(["equal", "custom", "percentage"]);

export type SplitType = z.infer<typeof SplitType>;

/**
 * Keep the raw string on failure so `superRefine` can still attach a precise
 * per-share issue; the validation itself never reaches downstream arithmetic.
 */
const shareAmountSchema = z.string().transform((value, ctx) => {
  const result = validateAmount(value);
  if (!result.ok) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.message });
    return value;
  }
  return result.value.decimal;
});

function stroopsIfValid(amount: string): bigint | undefined {
  const result = validateAmount(amount);
  return result.ok ? result.value.stroops : undefined;
}

/**
 * The expense's currency code. Trimmed and upper-cased on parse (#1183): the
 * supported-asset registry matches codes case-insensitively, so "xlm" and
 * " XLM " name the same asset as "XLM". `validateRequest` writes the parsed
 * body back, so normalizing here is what stops a raw spelling from being
 * persisted and splitting the group's balances across two currency keys.
 */
const assetCodeSchema = z
  .string({ required_error: "assetCode is required" })
  .trim()
  .min(1, "assetCode is required")
  .max(12, "assetCode must be at most 12 characters")
  .transform((value) => value.toUpperCase());

const identifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "Identifier must contain only letters, numbers, dashes, and underscores");

const memoSchema = z
  .string()
  .trim()
  .max(24)
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= 28,
    "Memo must be at most 28 UTF-8 bytes"
  )
  .optional();

const shareInput = z
  .object({
    userId: identifierSchema,
    amount: shareAmountSchema.optional(),
    percent: z.number().min(0).max(100).optional(),
  })
  .strict();

export const createExpenseSchema = z
  .object({
    title: sanitizedTextField({ min: 1, max: 80 }),
    description: sanitizedTextField({ max: 500 }).optional(),
    amount: canonicalAmountSchema,
    assetCode: assetCodeSchema,
    assetIssuer: z.string().nullable().optional(),
    splitType: SplitType,
    shares: z.array(shareInput).min(1).max(100),
    payerUserId: identifierSchema.optional(),
    memo: memoSchema,
    receiptUrl: z.string().url("Receipt URL must be a valid URL").nullable().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    refineValidatedAsset(ctx, val.assetCode, val.assetIssuer);

    const shareUserIds = val.shares.map((share) => share.userId);
    if (new Set(shareUserIds).size !== shareUserIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A user may appear only once in an expense split",
        path: ["shares"],
      });
    }

    if (val.splitType === "custom") {
      // Every share must carry an amount.
      if (!val.shares.every((s) => typeof s.amount === "string" && s.amount !== "")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Every share in a custom split must include an amount",
          path: ["shares"],
        });
        return; // further arithmetic checks are meaningless
      }

      const shareStroops = val.shares.map((s) => stroopsIfValid(s.amount!));

      // No share amount may be negative or zero. Invalid strings already have
      // a field-level issue from shareAmountSchema and are skipped here.
      for (let i = 0; i < val.shares.length; i++) {
        const amt = shareStroops[i];
        if (amt !== undefined && amt <= 0n) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Share amount for "${val.shares[i]!.userId}" must be greater than zero`,
            path: ["shares", i, "amount"],
          });
        }
      }

      // Sum of custom share amounts must equal the total expense amount.
      // Uses BigInt stroops to avoid floating-point rounding errors.
      const totalStroops = stroopsIfValid(val.amount);
      const validShareStroops = shareStroops.filter((s): s is bigint => s !== undefined);
      if (totalStroops === undefined || validShareStroops.length !== shareStroops.length) return;
      const shareSum = validShareStroops.reduce((acc, s) => acc + s, 0n);
      if (shareSum !== totalStroops) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `Custom split amounts must sum to the total expense amount (${val.amount}), ` +
            `but got ${fromStroops(shareSum)}`,
          path: ["shares"],
        });
      }
    }

    if (val.splitType === "percentage") {
      // Every participant must state their allocation. A share without a
      // percent, or with 0%, would otherwise pass whenever the remaining
      // shares sum to 100 and reach the settlement engine as a zero-value
      // obligation — malformed allocation data the schema is meant to stop.
      let missingPercent = false;
      for (let i = 0; i < val.shares.length; i++) {
        const percent = val.shares[i]!.percent;
        if (percent === undefined) {
          missingPercent = true;
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Missing percent: share for "${val.shares[i]!.userId}" must include a percent`,
            path: ["shares", i, "percent"],
          });
        } else if (percent <= 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Share percent for "${val.shares[i]!.userId}" must be greater than zero`,
            path: ["shares", i, "percent"],
          });
        }
      }
      if (missingPercent) return;

      const total = val.shares.reduce((sum, s) => sum + (s.percent ?? 0), 0);
      // Same tolerance the settlement engine applies, so every payload that
      // passes here is a payload `computeShares` will accept.
      if (Math.abs(total - 100) > PERCENT_TOTAL_TOLERANCE) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Percentage shares must sum to 100%, but got ${total}%`,
          path: ["shares"],
        });
      }
    }
  });

export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;

export const updateExpenseSchema = z
  .object({
    title: sanitizedTextField({ min: 1, max: 80 }).optional(),
    description: sanitizedTextField({ max: 500 }).nullable().optional(),
    memo: memoSchema,
    receiptUrl: z.string().url("Receipt URL must be a valid URL").nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided",
  });

export type UpdateExpenseInput = z.infer<typeof updateExpenseSchema>;
