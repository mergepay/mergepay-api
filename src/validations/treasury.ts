import { Errors } from "../errors";
import { assetCodeSchema, assetIssuerSchema } from "../schemas/asset";
import { mpMemoSchema } from "../lib/stellar-validation";
import { validateRequest } from "../middleware/validate-request";
import { treasuryProposalExpiryDaysSchema } from "../services/treasury-proposal-expiry";
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
import { sanitizedTextField } from "../lib/sanitize-text";
import { paginationQuerySchema } from "../lib/pagination";
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
    description: sanitizedTextField({
      min: 1,
      max: 280,
      minMessage: "Description cannot be empty",
      maxMessage: "Description must be 280 characters or fewer",
    }).optional(),
  })
  // Strict is deliberate: a proposal carries an externally built envelope, and
  // an unexpected field such as `secret` or `seed` must be refused outright
  // rather than silently stripped (issue #1080).
  .strict()
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

/**
 * A co-signature submission for an in-flight treasury proposal (issue #657).
 *
 * Guards `POST /treasury/:id/sign`. `.strict()` is the point: a co-signer must
 * never be able to hand the backend key material, so a body carrying anything
 * besides `signedXdr` — a stray `secret`, a `seed`, a raw `signature` — is
 * rejected outright rather than silently stripped on the way to the database.
 *
 * Shape only. Whether the envelope still matches the proposal's stored
 * transaction, and whether each signature verifies against a live, authorized
 * signer, is decided by `treasurySignaturesService.submitSignature`.
 */
export const treasurySignatureSubmitSchema = z
  .object({
    signedXdr: treasuryXdrSchema,
  })
  .strict();

export type TreasurySignatureSubmitInput = z.infer<
  typeof treasurySignatureSubmitSchema
>;


const DECIMAL_AMOUNT = /^\d+(\.\d+)?$/;

/**
 * Strict decimal amount schema for treasury multisig proposals:
 * must be a positive decimal string (e.g. "100", "0.5").
 */
export const treasuryAmountSchema = z
  .string({
    required_error: "Amount is required",
    invalid_type_error: "Amount must be a string",
  })
  .trim()
  .min(1, "Amount is required")
  .regex(DECIMAL_AMOUNT, "Amount must be a positive decimal number")
  .refine(
    (val) => {
      const num = Number(val);
      return !Number.isNaN(num) && num > 0;
    },
    "Amount must be greater than zero"
  );

/**
 * Dedicated Zod schema for treasury multisig transaction proposal payloads (#874).
 *
 * Validates destination public key, positive decimal amount, asset code,
 * optional asset issuer, memo, optional signers with weights, and optional threshold.
 */
export const treasuryMultisigProposalPayloadSchema = z
  .object({
    destination: stellarPublicKeySchema,
    amount: treasuryAmountSchema,
    assetCode: assetCodeSchema,
    assetIssuer: assetIssuerSchema.nullable().optional(),
    memo: mpMemoSchema.optional(),
    signers: treasurySignersSchema.optional(),
    threshold: stellarWeightSchema.optional(),
    xdr: treasuryXdrSchema.optional(),
    description: sanitizedTextField({
      max: 280,
      maxMessage: "Description must be 280 characters or fewer",
    }).optional(),
    expiresInDays: treasuryProposalExpiryDaysSchema.optional(),
  })
  // Strict so a client cannot smuggle key material or unrelated fields into a
  // server-built payment proposal; the route's Zod middleware reports an
  // unrecognized key with the standard 400 VALIDATION_ERROR envelope (#1080).
  .strict()
  .refine(
    (data) => {
      if (data.assetCode !== "XLM" && data.assetCode !== "native" && !data.assetIssuer) {
        return false;
      }
      return true;
    },
    {
      message: "assetIssuer is required for non-native assets",
      path: ["assetIssuer"],
    }
  );

export type TreasuryMultisigProposalPayload = z.infer<
  typeof treasuryMultisigProposalPayloadSchema
>;

/** Every persisted lifecycle state of a server-built treasury proposal. */
export const TREASURY_PROPOSAL_STATUSES = [
  "pending",
  "awaiting_signatures",
  "submitted",
  "confirmed",
  "failed",
  "expired",
] as const;

export type TreasuryProposalStatus = (typeof TREASURY_PROPOSAL_STATUSES)[number];

/**
 * Query contract for `GET /groups/:groupId/treasury/proposals` (issue #1053).
 *
 * Extends the shared cursor-pagination schema with closed-enum status,
 * creator, and creation-date filters. Unknown keys stay a 400 (`.strict()`
 * is preserved by `.extend()`), and an inverted date range is rejected rather
 * than silently returning an empty page.
 */
export const treasuryProposalListQuerySchema = paginationQuerySchema
  .extend({
    status: z.enum(TREASURY_PROPOSAL_STATUSES).optional(),
    creatorId: z.string().min(1).max(64).optional(),
    startDate: z.string().datetime({ offset: true }).optional(),
    endDate: z.string().datetime({ offset: true }).optional(),
  })
  .refine(
    (query) =>
      !query.startDate ||
      !query.endDate ||
      new Date(query.startDate).getTime() <= new Date(query.endDate).getTime(),
    {
      message: "startDate must be before or equal to endDate",
      path: ["startDate"],
    }
  );

export type TreasuryProposalListQuery = z.infer<
  typeof treasuryProposalListQuerySchema
>;

/**
 * Request-validation middleware for both externally built transaction proposals
 * (`/treasury/propose`, `/api/treasury/proposals`) — issue #1080.
 *
 * Uses the shared `validateRequest` preHandler so a rejection is rendered by
 * the central ZodError handler as `400 VALIDATION_ERROR` with `details` and
 * `issues`, identical to every other validated surface.
 */
export const validateTreasuryTxProposalCreateRequest = validateRequest({
  body: treasuryTxProposalCreateSchema,
});

/**
 * Request-validation middleware for server-built payment proposals
 * (`/groups/:groupId/treasury/proposals`) — issue #1080.
 */
export const validateTreasuryMultisigProposalCreateRequest = validateRequest({
  body: treasuryMultisigProposalPayloadSchema,
});

/**
 * Fastify preHandler validation hook for treasury multisig proposals (#874).
 */
export async function validateTreasuryProposalHook(req: any) {
  const parsed = treasuryMultisigProposalPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const pathStr = firstIssue?.path.join(".") || "payload";
    throw Errors.badRequest(
      "VALIDATION_ERROR",
      `${pathStr}: ${firstIssue?.message ?? "Invalid proposal payload"}`
    );
  }
  req.treasuryProposal = parsed.data;
}
