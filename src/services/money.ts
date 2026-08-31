/**
 * Money utilities for balance math and settlement computations.
 *
 * All math runs in BigInt stroops (10^7 per unit). This module delegates
 * input validation to the shared `src/lib/money.ts` utility to ensure
 * a single source of truth for amount/asset validation.
 */

import { z } from "zod";
import {
  STROOPS_PER_UNIT,
  MAX_STROOPS,
  MAX_AMOUNT,
  validateAmount as libValidateAmount,
  validateAsset as libValidateAsset,
  fromStroops as libFromStroops,
  stroopsToStellarAmount as libStroopsToStellarAmount,
  compareAmounts as libCompareAmounts,
  addAmounts as libAddAmounts,
  subtractAmounts as libSubtractAmounts,
  refineValidatedAsset,
  type ValidatedAmount,
  type ValidationOutcome,
} from "../lib/money";

// Re-export constants for backward compatibility
export { STROOPS_PER_UNIT as STROOPS_PER_XLM, MAX_STROOPS, MAX_AMOUNT };

/** Absolute value of a bigint — used by balance math, which is signed. */
export function bigIntAbs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * Normalize a decimal amount string to canonical form (positive only).
 * Delegates to shared validation utility.
 */
export function normalizeAmount(value: string): string {
  const result = libValidateAmount(value);
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.value.decimal;
}

/**
 * Parse a canonical decimal amount exactly, without floating-point arithmetic.
 *
 * Signed values are accepted because net balances are signed (negative = owes).
 * Zero is accepted for balance math. Route input is validated with
 * `normalizeAmount`/`amountSchema`, which stay strictly positive.
 */
export function toStroops(amount: string): bigint {
  // For signed amounts (used in balance math), we handle the sign ourselves
  // then validate the magnitude using shared utility (but allow zero).
  if (typeof amount !== "string") {
    throw new Error("Amount must be a string");
  }

  const negative = amount.startsWith("-");
  const unsigned = negative ? amount.slice(1) : amount;

  // Validate the unsigned amount using shared utility but allow zero
  const result = validateUnsignedAmountAllowZero(unsigned);
  if (!result.ok) {
    throw new Error(result.message);
  }

  return negative ? -result.value.stroops : result.value.stroops;
}

/**
 * Internal validation for unsigned amounts that allows zero.
 * Used by balance math where zero is a valid value.
 */
function validateUnsignedAmountAllowZero(value: string): ValidationOutcome<ValidatedAmount> {
  // Reject whitespace padding
  const trimmed = value.trim();
  if (trimmed !== value) {
    return {
      ok: false,
      reason: "whitespace_padding",
      message: "Amount must not have leading or trailing whitespace",
      code: "INVALID_AMOUNT",
    };
  }

  // Reject empty
  if (!trimmed) {
    return {
      ok: false,
      reason: "malformed",
      message: "Amount is required",
      code: "INVALID_AMOUNT",
    };
  }

  // Reject exponent notation, signs, non-digits
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return {
      ok: false,
      reason: "malformed",
      message: `"${value}" is not a valid decimal amount (no exponents, signs, or non-digits)`,
      code: "INVALID_AMOUNT",
    };
  }

  // Split into whole and fractional parts
  const [wholeRaw, fracRaw = ""] = trimmed.split(".");

  // Check precision (max 7 decimal places)
  if (fracRaw.length > 7) {
    return {
      ok: false,
      reason: "excess_precision",
      message: `Amount "${value}" exceeds 7-decimal precision`,
      code: "INVALID_AMOUNT",
    };
  }

  // Convert to stroops using BigInt only
  const whole = wholeRaw.replace(/^0+(?=\d)/, "") || "0";
  const paddedFrac = (fracRaw + "0000000").slice(0, 7);
  const stroops = BigInt(whole) * STROOPS_PER_UNIT + BigInt(paddedFrac);

  // Allow zero for balance math
  if (stroops < 0n) {
    return {
      ok: false,
      reason: "zero_or_negative",
      message: "Amount must not be negative",
      code: "INVALID_AMOUNT",
    };
  }

  // Must fit in Stellar's Int64 range
  if (stroops > MAX_STROOPS) {
    return {
      ok: false,
      reason: "out_of_range",
      message: "Amount exceeds the maximum representable Stellar value",
      code: "INVALID_AMOUNT",
    };
  }

  // Build canonical decimal string (trim trailing zeros from fraction)
  const canonicalFrac = paddedFrac.replace(/0+$/, "");
  const canonical = canonicalFrac ? `${whole}.${canonicalFrac}` : whole;

  return { ok: true, value: { decimal: canonical, stroops } };
}

/** Convert stroops to the canonical decimal representation used by the API. */
export function fromStroops(stroops: bigint | number | string): string {
  let value: bigint;
  if (typeof stroops === "bigint") {
    value = stroops;
  } else if (typeof stroops === "number") {
    if (!Number.isSafeInteger(stroops)) {
      throw new Error("Stroop value must be an exact integer");
    }
    value = BigInt(stroops);
  } else {
    // Parse integer string
    if (!/^-?\d+$/.test(stroops)) {
      throw new Error("Stroop value must be a canonical integer string");
    }
    value = BigInt(stroops);
  }

  if (bigIntAbs(value) > MAX_STROOPS) {
    throw new Error("Stroop value is outside the supported Stellar range");
  }

  return libFromStroops(value);
}

/**
 * Render stroops the way Stellar itself expects an amount on the wire: always
 * exactly 7 decimal places, no trailing-zero trimming. `fromStroops` is the
 * canonical *API* representation; this is the canonical *ledger* one.
 */
export function stroopsToStellarAmount(stroops: bigint): string {
  return libStroopsToStellarAmount(stroops);
}

/** Return true only for a valid, strictly positive Stellar amount. */
export function isPositive(amount: string): boolean {
  try {
    normalizeAmount(amount);
    return true;
  } catch {
    return false;
  }
}

export function addAmounts(left: string, right: string): string {
  return libAddAmounts(left, right);
}

export function subtractAmounts(left: string, right: string): string {
  return libSubtractAmounts(left, right);
}

export function compareAmounts(left: string, right: string): number {
  return libCompareAmounts(left, right);
}

export const amountSchema = z
  .string()
  .superRefine((value, ctx) => {
    const result = libValidateAmount(value);
    if (!result.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: result.message,
      });
    }
  })
  .transform((value) => {
    const result = libValidateAmount(value);
    if (!result.ok) return z.NEVER;
    return result.value.decimal;
  });

export const assetSchema = z
  .object({
    assetCode: z.string().min(1).max(12),
    assetIssuer: z.string().nullable().optional(),
  })
  .superRefine((asset, ctx) => refineValidatedAsset(ctx, asset.assetCode, asset.assetIssuer))
  .transform((asset) => {
    // We can't easily get the ValidatedAsset here without re-validating,
    // but the superRefine already validated it. Return the raw object for compatibility.
    return {
      assetCode: asset.assetCode,
      assetIssuer: asset.assetIssuer ?? null,
    };
  });

export function validateAsset(assetCode: string, assetIssuer?: string | null): {
  assetCode: string;
  assetIssuer: string | null;
} {
  const result = libValidateAsset(assetCode, assetIssuer);
  if (!result.ok) {
    throw new Error(result.message);
  }
  return {
    assetCode: result.value.code,
    assetIssuer: result.value.issuer,
  };
}