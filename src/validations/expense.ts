import { z } from "zod";
import {
  canonicalAmountSchema,
  fromStroops,
  refineValidatedAsset,
  validateAmount,
} from "../lib/money";

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

const shareInput = z.object({
  userId: z.string().min(1),
  amount: shareAmountSchema.optional(),
  percent: z.number().min(0).max(100).optional(),
});

export const createExpenseSchema = z
  .object({
    title: z.string().min(1).max(80),
    description: z.string().max(500).optional(),
    amount: canonicalAmountSchema,
    assetCode: z.string().min(1).max(12),
    assetIssuer: z.string().nullable().optional(),
    splitType: SplitType,
    shares: z.array(shareInput).min(1),
    payerUserId: z.string().optional(),
    memo: z.string().max(24).optional(),
    receiptUrl: z.string().url("Receipt URL must be a valid URL").nullable().optional(),
  })
  .superRefine((val, ctx) => {
    refineValidatedAsset(ctx, val.assetCode, val.assetIssuer);

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
      const total = val.shares.reduce((sum, s) => sum + (s.percent ?? 0), 0);
      if (Math.abs(total - 100) >= 0.01) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Percentage shares must sum to 100%, but got ${total}%`,
          path: ["shares"],
        });
      }
    }
  });

export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;

export const updateExpenseSchema = z.object({
  title: z.string().min(1).max(80).optional(),
  description: z.string().max(500).nullable().optional(),
  memo: z.string().max(24).optional(),
  receiptUrl: z.string().nullable().optional(),
});

export type UpdateExpenseInput = z.infer<typeof updateExpenseSchema>;
