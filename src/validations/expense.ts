import { z } from "zod";
import { canonicalAmountSchema, refineValidatedAsset } from "../lib/money";

export const SplitType = z.enum(["equal", "custom", "percentage"]);

export type SplitType = z.infer<typeof SplitType>;

/**
 * Maximum number of decimal places Stellar supports (10^7 stroops per unit).
 * Used for precision-safe comparisons between share amounts.
 */
const STROOPS_DECIMALS = 7;
const STROOPS_SCALE = 10_000_000n;

/**
 * Convert a decimal amount string to stroops (BigInt) for precise
 * arithmetic that avoids floating-point rounding errors.
 */
function amountToStroops(amount: string): bigint {
  if (typeof amount !== "string") return 0n;
  const [whole = "0", frac = ""] = amount.split(".");
  const padded = frac.padEnd(STROOPS_DECIMALS, "0").slice(0, STROOPS_DECIMALS);
  return BigInt(whole) * STROOPS_SCALE + BigInt(padded);
}

/**
 * Convert a stroops value back to a canonical decimal string.
 * Trailing zeros in the fractional part are stripped.
 */
function fromStroopsBigInt(stroops: bigint): string {
  const sign = stroops < 0n ? "-" : "";
  const magnitude = stroops < 0n ? -stroops : stroops;
  const whole = magnitude / STROOPS_SCALE;
  const frac = (magnitude % STROOPS_SCALE).toString().padStart(STROOPS_DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${sign}${whole}.${frac}` : `${sign}${whole}`;
}

const shareInput = z.object({
  userId: z.string().min(1),
  amount: z
    .string()
    .regex(/^\d+(?:\.\d{1,7})?$/, "Amount must have at most 7 decimal places")
    .optional(),
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
    receiptUrl: z.string().nullable().optional(),
  })
  .superRefine((val, ctx) => {
    refineValidatedAsset(ctx, val.assetCode, val.assetIssuer);

    if (val.splitType === "custom") {
      // Every share must carry an amount.
      if (!val.shares.every((s) => s.amount !== undefined && s.amount !== "")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Every share in a custom split must include an amount",
          path: ["shares"],
        });
        return; // further arithmetic checks are meaningless
      }

      // No share amount may be negative or zero.
      for (let i = 0; i < val.shares.length; i++) {
        const amt = val.shares[i]!.amount!;
        if (amountToStroops(amt) <= 0n) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Share amount for "${val.shares[i]!.userId}" must be greater than zero`,
            path: ["shares", i, "amount"],
          });
        }
      }

      // Sum of custom share amounts must equal the total expense amount.
      // Uses BigInt stroops to avoid floating-point rounding errors.
      const totalStroops = amountToStroops(val.amount);
      const shareSum = val.shares.reduce(
        (acc, s) => acc + amountToStroops(s.amount!),
        0n
      );
      if (shareSum !== totalStroops) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `Custom split amounts must sum to the total expense amount (${val.amount}), ` +
            `but got ${fromStroopsBigInt(shareSum)}`,
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
