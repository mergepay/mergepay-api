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
import { stellarPublicKeySchema } from "../lib/stellar-validation";

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