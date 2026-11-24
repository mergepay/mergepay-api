/**
 * Shared Zod schemas for treasury multisig configuration and weight changes.
 *
 * A group treasury's signing scheme is security-relevant: the signer weights
 * and thresholds decide how many approvals it takes to move funds. These
 * schemas are the request-shape gate for anything that proposes that
 * configuration (see `POST /groups/:id/treasury/validate-signers` in
 * src/routes/treasury.ts), so a malformed or impossible proposal is rejected
 * deterministically at the door:
 *
 *   - signer public keys must be checksum-validated ed25519 addresses ("G…"),
 *     which means a private/secret key (a stray "S…" or a malformed string)
 *     can never be accepted or handled here;
 *   - weights and thresholds are integers in Stellar's 0-255 range;
 *   - thresholds must be hierarchical: low ≤ med ≤ high.
 *
 * Deeper, on-chain validation against the account snapshot lives in
 * src/services/treasury-validation.ts; this module only validates shape and
 * bounds.
 */
import { z } from "zod";
import {
  mpMemoSchema,
  refineStellarAsset,
  stellarAccountIdSchema,
  stellarPublicKeySchema,
} from "../lib/stellar-validation";
import { canonicalAmountSchema } from "../lib/money";

/** A Stellar weight/threshold: integer in [0, 255]. */
const stellarWeightSchema = z
  .number()
  .int("Must be a whole number")
  .min(0, "Must be between 0 and 255")
  .max(255, "Must be between 0 and 255");

/** A configured treasury signer: a Stellar account plus its signing weight. */
export const treasurySignerSchema = z.object({
  publicKey: stellarPublicKeySchema,
  weight: stellarWeightSchema,
});

export type TreasurySignerInput = z.infer<typeof treasurySignerSchema>;

/** The signer roster: at least one, bounded well under Stellar's 20-signer cap. */
export const treasurySignersSchema = z
  .array(treasurySignerSchema)
  .min(1, "At least one signer is required")
  .max(20, "At most 20 signers are supported");

/** Stellar master-key thresholds: non-negative integers in [0, 255]. */
export const treasuryThresholdsSchema = z
  .object({
    low: stellarWeightSchema,
    med: stellarWeightSchema,
    high: stellarWeightSchema,
  })
  .superRefine((thresholds, ctx) => {
    if (thresholds.low > thresholds.med) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["low"],
        message: "Low threshold cannot exceed medium threshold",
      });
    }
    if (thresholds.med > thresholds.high) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["med"],
        message: "Medium threshold cannot exceed high threshold",
      });
    }
  });

export type TreasuryThresholdsInput = z.infer<typeof treasuryThresholdsSchema>;

/** A complete treasury signer configuration proposal. */
export const treasurySignerConfigSchema = z.object({
  signers: treasurySignersSchema,
  thresholds: treasuryThresholdsSchema,
});

export type TreasurySignerConfigInput = z.infer<typeof treasurySignerConfigSchema>;

/**
 * A single signer weight adjustment request (e.g. raising one co-signer's
 * authority or demoting it to weight 0). Reuses the same public-key and
 * weight bounds as the full roster so a one-off change cannot bypass them.
 */
export const treasurySignerWeightSchema = treasurySignerSchema;

/**
 * A request to adjust a treasury's signing threshold while keeping the signer
 * roster unchanged.
 */
export const treasuryThresholdUpdateSchema = z.object({
  thresholds: treasuryThresholdsSchema,
  requiredSigners: stellarWeightSchema,
});

export type TreasuryThresholdUpdateInput = z.infer<typeof treasuryThresholdUpdateSchema>;

// ─── Treasury proposal mutation payloads ────────────────────────────────────

/**
 * Path parameters for a group-scoped treasury proposal collection.
 * Bounded so an oversized identifier is rejected at the door rather than
 * reaching a database lookup.
 */
export const treasuryProposalGroupParamsSchema = z.object({
  groupId: z.string().min(1, "Group ID is required").max(64),
});

/** Path parameters for a single treasury proposal resource. */
export const treasuryProposalParamsSchema = z.object({
  groupId: z.string().min(1, "Group ID is required").max(64),
  proposalId: z.string().min(1, "Proposal ID is required").max(64),
});

/**
 * Payload for creating a treasury payment proposal. The destination is a
 * checksum-validated Stellar account, the amount is a positive, precision-safe
 * decimal within Stellar's Int64 range, and the asset pair must be a supported
 * asset (native XLM without an issuer, or the configured stablecoin).
 */
export const treasuryProposalCreateSchema = z
  .object({
    destination: stellarAccountIdSchema,
    // Reports the specific reason (zero, excess precision, out of range)
    // instead of a generic "invalid amount" message.
    amount: canonicalAmountSchema,
    assetCode: z.string().min(1, "Asset code is required").max(12),
    assetIssuer: z.string().nullable().optional(),
    memo: mpMemoSchema.optional(),
  })
  .superRefine((val, ctx) => {
    refineStellarAsset(ctx, val.assetCode, val.assetIssuer);
  });

export type TreasuryProposalCreateInput = z.infer<
  typeof treasuryProposalCreateSchema
>;

/**
 * Payload for a member signing (and, once the threshold is met, submitting) a
 * treasury proposal. The signed envelope must be a non-empty base64 XDR; the
 * service verifies it hashes to the persisted proposal before accepting it.
 * The upper bound keeps an oversized envelope out of the request pipeline.
 */
export const treasuryProposalSignSchema = z.object({
  signedXdr: z
    .string()
    .min(1, "Signed XDR is required")
    .max(100_000, "Signed XDR is too large"),
});

export type TreasuryProposalSignInput = z.infer<
  typeof treasuryProposalSignSchema
>;

/**
 * Final submission shares the sign payload shape: submission is the signature
 * that reaches the threshold, so the same envelope rules apply.
 */
export const treasuryProposalSubmitSchema = treasuryProposalSignSchema;