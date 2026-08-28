/**
 * Shared Zod validation for Stellar accounts, assets, and amounts.
 *
 * Centralizing this means every route that accepts a public key, an asset,
 * or a payment amount rejects the same malformed input the same way, before
 * the request reaches a service or the database. No Horizon I/O happens
 * here — that stays in src/services/stellar.ts.
 *
 * This module now delegates to the shared `src/lib/money.ts` utility for
 * amount and asset validation to ensure a single source of truth.
 */

import { z } from "zod";
import { StrKey } from "@stellar/stellar-sdk";
import {
  MAX_STROOPS,
  validateAmount as libValidateAmount,
  validateAsset as libValidateAsset,
  refineValidatedAsset,
  type ValidatedAmount,
  type ValidatedAsset,
} from "./money";

/** Stellar's ledger-enforced ceiling for a signed 64-bit stroop amount (Int64 max). */
export { MAX_STROOPS };

/**
 * Parse a plain decimal amount string into stroops (value * 10^7), enforcing
 * Stellar's 7-decimal-place precision and the network's max representable
 * value. Throws a descriptive Error on anything that isn't a clean, positive,
 * in-range decimal — no exponents, signs, whitespace, or extra precision.
 */
export function parseStellarAmount(raw: string): bigint {
  const result = libValidateAmount(raw);
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.value.stroops;
}

function isValidStellarAmount(raw: string): boolean {
  return libValidateAmount(raw).ok;
}

/** A Stellar ed25519 public key ("G..."), checksum-validated. */
export const stellarPublicKeySchema = z
  .string()
  .refine((v) => StrKey.isValidEd25519PublicKey(v), {
    message: "Invalid Stellar public key",
  });

/** A positive, precision-safe decimal amount string, within Stellar's Int64 range. */
export const stellarAmountSchema = z
  .string()
  .min(1)
  .max(40)
  .refine(isValidStellarAmount, { message: "Invalid Stellar amount" });

/**
 * Zod transform schema that validates and returns a ValidatedAmount { decimal, stroops }.
 * Use this when you need the parsed stroops value.
 */
export const validatedAmountSchema = z
  .string()
  .transform((val, ctx) => {
    const result = libValidateAmount(val);
    if (!result.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: result.message,
      });
      return z.NEVER;
    }
    return result.value;
  });

/**
 * Validates an { assetCode, assetIssuer } pair against the assets Mergepay
 * supports: native XLM (never an issuer) and the configured stablecoin
 * (always the configured issuer for the active network). Called from a
 * schema's `.superRefine` so field-level errors attach to the right path.
 *
 * Delegates to the shared utility for consistent validation.
 */
export function refineStellarAsset(
  ctx: z.RefinementCtx,
  assetCode: string,
  assetIssuer: string | null | undefined,
  path: { code?: (string | number)[]; issuer?: (string | number)[] } = {}
): void {
  refineValidatedAsset(ctx, assetCode, assetIssuer, path);
}

/** Reusable { assetCode, assetIssuer } object schema with asset support validated. */
export const stellarAssetSchema = z
  .object({
    assetCode: z.string().min(1).max(12),
    assetIssuer: z.string().nullable().optional(),
  })
  .superRefine((val, ctx) => refineStellarAsset(ctx, val.assetCode, val.assetIssuer))
  .transform((val) => {
    const result = libValidateAsset(val.assetCode, val.assetIssuer ?? null);
    if (!result.ok) return z.NEVER;
    return result.value;
  });

// Re-export types for convenience
export type { ValidatedAmount, ValidatedAsset };