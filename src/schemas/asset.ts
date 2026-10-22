/**
 * Shared Zod schemas for Stellar asset query and request parameters.
 *
 * Route handlers parse incoming asset codes and issuer public keys with these
 * schemas so malformed values are rejected with the standard validation error
 * shape before they can reach a Horizon/Stellar service, a lookup, or the
 * database.
 *
 * - `assetCodeSchema` / `assetIssuerSchema` are the field-level primitives and
 *   can be dropped into any schema shape.
 * - `assetQuerySchema` is the full asset identifier (code + issuer) and also
 *   enforces the pairing rules: the native asset never takes an issuer, and a
 *   non-native asset always names a valid issuer.
 */
import { z } from "zod";
import { StrKey } from "@stellar/stellar-sdk";

/** Stellar's protocol limit on an asset code's length. */
export const ASSET_CODE_MAX_LENGTH = 12;

/** The network's native asset code. Native assets never carry an issuer. */
export const NATIVE_ASSET_CODE = "XLM";

/** A Stellar asset code: 1-12 alphanumeric characters, whitespace-trimmed. */
export const assetCodeSchema = z
  .string({ required_error: "assetCode is required" })
  .trim()
  .min(1, "assetCode is required")
  .max(
    ASSET_CODE_MAX_LENGTH,
    `assetCode must be at most ${ASSET_CODE_MAX_LENGTH} characters`
  )
  .regex(/^[A-Za-z0-9]+$/, "assetCode may only contain letters and digits");

/** A Stellar asset issuer: a checksum-validated G-address public key. */
export const assetIssuerSchema = z
  .string({ required_error: "assetIssuer is required" })
  .trim()
  .min(1, "assetIssuer is required")
  .refine((value) => StrKey.isValidEd25519PublicKey(value), {
    message: "assetIssuer must be a valid Stellar public key beginning with 'G'",
  });

/** The `{ assetCode, assetIssuer }` field shape shared by asset schemas. */
export const assetQueryFields = {
  assetCode: assetCodeSchema,
  assetIssuer: assetIssuerSchema.nullable().optional(),
};

/** The subset of fields the asset pairing rules operate on. */
export interface AssetPair {
  assetCode: string;
  assetIssuer?: string | null;
}

/**
 * Enforces the asset pairing rules on a parsed `{ assetCode, assetIssuer }`:
 * the native asset rejects any issuer, and every non-native asset requires a
 * valid issuer. Attach it with `.superRefine(refineAssetPair)` to any object
 * schema that carries the `assetQueryFields` shape.
 */
export function refineAssetPair(value: AssetPair, ctx: z.RefinementCtx): void {
  const isNative = value.assetCode.toUpperCase() === NATIVE_ASSET_CODE;

  if (isNative) {
    if (value.assetIssuer) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assetIssuer"],
        message: `${NATIVE_ASSET_CODE} is a native asset and does not take an issuer`,
      });
    }
    return;
  }

  if (!value.assetIssuer) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["assetIssuer"],
      message: `assetIssuer is required for non-native asset "${value.assetCode}"`,
    });
  }
}

/** Full asset identification: a valid code plus, for issued assets, a valid issuer. */
export const assetQuerySchema = z
  .object(assetQueryFields)
  .superRefine(refineAssetPair);

export type AssetQuery = z.infer<typeof assetQuerySchema>;
