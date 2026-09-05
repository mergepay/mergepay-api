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
