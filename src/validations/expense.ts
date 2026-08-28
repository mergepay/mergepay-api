import { z } from "zod";
import { canonicalAmountSchema, refineValidatedAsset } from "../lib/money";

export const SplitType = z.enum(["equal", "custom", "percentage"]);

export type SplitType = z.infer<typeof SplitType>;

const shareInput = z.object({
  userId: z.string().min(1),
  amount: z.string().regex(/^\d+(?:\.\d{1,7})?$/, "Amount must have at most 7 decimal places").optional(),
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
      if (!val.shares.every((s) => s.amount !== undefined && s.amount !== "")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Invalid split configuration",
          path: ["shares"],
        });
      }
    }
    if (val.splitType === "percentage") {
      const total = val.shares.reduce((sum, s) => sum + (s.percent ?? 0), 0);
      if (Math.abs(total - 100) >= 0.01) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Invalid split configuration",
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
