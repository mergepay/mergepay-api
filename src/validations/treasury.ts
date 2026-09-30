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
import { isValidXdr } from "../utils/stellar-xdr";

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

/**
 * A treasury transaction envelope: a base64 XDR string the SDK can decode
 * (issue #419's shared `isValidXdr` gate). Shape-only — whether the envelope
 * is unsigned, sourced from the treasury account, or matches the expected
 * intent is checked by the service that owns those invariants.
 */
export const treasuryXdrSchema = z
  .string()
  .min(1, "Transaction XDR is required")
  .max(50000, "Transaction XDR exceeds maximum size")
  .refine(
    (value) => isValidXdr(value),
    "Transaction must be a valid base64-encoded Stellar XDR"
  );

/**
 * A treasury multisig proposal creation payload (issue #402).
 *
 * Guards the `POST /api/treasury/proposals` route (src/routes/treasury-signatures.ts)
 * so a malformed proposal is rejected deterministically before it can reach
 * the signature-collection workflow:
 *
 *   - `treasuryId` — the treasury (group) the proposal spends from. The
 *     historical field name `groupId` is still accepted so existing clients
 *     keep working; the schema normalises either to `treasuryId`.
 *   - `xdr` — the unsigned envelope, validated for parseability up front.
 *   - `description` — optional human-readable metadata ("pay March rent",
 *     "vendor invoice #42") stored with the proposal for display; bounded so
 *     it cannot be used as a free-form data dump.
 *
 * Semantic checks (treasury enabled, envelope unsigned, source account
 * matches) stay in `treasurySignaturesService.createProposal` — this schema
 * owns the payload *shape* only.
 */
export const treasuryTxProposalCreateSchema = z
  .object({
    /** Canonical treasury identifier (issue #402). */
    treasuryId: z.string().min(1).optional(),
    /** Legacy alias for `treasuryId`, retained for backward compatibility. */
    groupId: z.string().min(1).optional(),
    xdr: treasuryXdrSchema,
    description: z
      .string()
      .min(1, "Description cannot be empty")
      .max(280, "Description must be 280 characters or fewer")
      .optional(),
  })
  .refine((value) => Boolean(value.treasuryId ?? value.groupId), {
    message: "treasuryId is required",
    path: ["treasuryId"],
  })
  // Guaranteed non-empty by the refinement above: either name resolves to the
  // same treasury, and `treasuryId` is the canonical one handlers read.
  .transform((value) => ({
    ...value,
    treasuryId: (value.treasuryId ?? value.groupId) as string,
  }));

export type TreasuryTxProposalCreateInput = z.infer<
  typeof treasuryTxProposalCreateSchema
>;