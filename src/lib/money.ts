/**
 * Shared money/asset validation utility.
 *
 * This is the SINGLE source of truth for:
 * - Asset validation (XLM native, USDC with configured issuer)
 * - Amount validation (positive, 7dp max, representable as stroops)
 * - Decimal string <-> stroops conversion (BigInt only, never floats)
 *
 * Used by BOTH request validation (Zod) AND transaction/XDR construction.
 * This prevents drift between what gets validated and what gets put on-chain.
 */

import { z } from "zod";
import { StrKey } from "@stellar/stellar-sdk";
import { config } from "../config";
import { Errors } from "../errors";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Stellar's precision: 7 decimal places (10^7 stroops per unit). */
export const STROOPS_PER_UNIT = 10_000_000n;

/** Maximum signed 64-bit stroop value (Stellar's Int64 max). */
export const MAX_STROOPS = 9_223_372_036_854_775_807n;

/** Maximum representable decimal amount string. */
export const MAX_AMOUNT = "922337203685.4775807";

/** Supported asset types. */
export type AssetType = "native" | "issued";

/** Canonical asset configuration after validation. */
export interface ValidatedAsset {
  code: string;
  type: AssetType;
  issuer: string | null;
  name: string;
}

/** Validated amount result with both string and stroops representations. */
export interface ValidatedAmount {
  /** Canonical decimal string (trimmed, no leading/trailing zeros except "0"). */
  decimal: string;
  /** Amount in stroops (integer, 10^7 per unit). */
  stroops: bigint;
}

/** Rejection reasons for asset validation. */
export type AssetRejectionReason =
  | "unsupported_code"
  | "native_with_issuer"
  | "issued_without_issuer"
  | "issuer_mismatch"
  | "invalid_issuer_format"
  | "network_mismatch";

/** Rejection reasons for amount validation. */
export type AmountRejectionReason =
  | "malformed"
  | "zero_or_negative"
  | "excess_precision"
  | "out_of_range"
  | "exponent_notation"
  | "whitespace_padding";

/** Unified validation result. */
export interface ValidationResult<T> {
  ok: true;
  value: T;
}

/** Unified validation error. */
export interface ValidationError {
  ok: false;
  reason: AssetRejectionReason | AmountRejectionReason;
  message: string;
  /** Machine-readable code for API error responses. */
  code: string;
}

/** Combined validation outcome. */
export type ValidationOutcome<T> = ValidationResult<T> | ValidationError;

// ─── Asset Registry ──────────────────────────────────────────────────────────

const SUPPORTED_ASSETS: Array<{
  code: string;
  type: AssetType;
  issuer: string | null;
  name: string;
  network: "testnet" | "public" | "both";
}> = [
  {
    code: "XLM",
    type: "native",
    issuer: null,
    name: "Stellar Lumens",
    network: "both",
  },
  {
    code: "USDC",
    type: "issued",
    issuer: config.STABLE_ASSET_ISSUER || null,
    name: "USD Coin",
    network: "public",
  },
];

const _byCode = new Map<string, typeof SUPPORTED_ASSETS[0]>();
const _byCodeIssuer = new Map<string, typeof SUPPORTED_ASSETS[0]>();

for (const a of SUPPORTED_ASSETS) {
  _byCode.set(a.code.toUpperCase(), a);
  const key = `${a.code.toUpperCase()}::${a.issuer ?? ""}`;
  _byCodeIssuer.set(key, a);
}

function assertNetwork(asset: typeof SUPPORTED_ASSETS[0]): void {
  if (asset.network === "both") return;
  const currentNetwork = config.STELLAR_NETWORK ?? "public";
  if (asset.network !== currentNetwork) {
    throw Errors.badRequest(
      "invalid_asset",
      `"${asset.code}" is not available on the ${currentNetwork} network (valid on: ${asset.network})`
    );
  }
}

// ─── Asset Validation ────────────────────────────────────────────────────────

/**
 * Validate an asset code and optional issuer.
 * Returns the canonical ValidatedAsset on success, or a ValidationError.
 */
export function validateAsset(code: string, issuer?: string | null): ValidationOutcome<ValidatedAsset> {
  const upper = code.toUpperCase().trim();
  if (!upper) {
    return {
      ok: false,
      reason: "unsupported_code",
      message: "Asset code is required",
      code: "INVALID_ASSET",
    };
  }

  // Check exact (code + issuer) match first
  if (issuer) {
    const issuerTrimmed = issuer.trim();
    if (!StrKey.isValidEd25519PublicKey(issuerTrimmed)) {
      return {
        ok: false,
        reason: "invalid_issuer_format",
        message: `"${issuer}" is not a valid Stellar public key`,
        code: "INVALID_ASSET",
      };
    }
    const exact = _byCodeIssuer.get(`${upper}::${issuerTrimmed}`);
    if (exact) {
      assertNetwork(exact);
      return { ok: true, value: stripNetwork(exact) };
    }
  }

  // Check by code only
  const entry = _byCode.get(upper);
  if (!entry) {
    return {
      ok: false,
      reason: "unsupported_code",
      message: `Unsupported asset code "${code}". Supported codes: ${[..._byCode.keys()].join(", ")}`,
      code: "INVALID_ASSET",
    };
  }

  // Native asset with issuer supplied? That's a mistake.
  if (entry.type === "native" && issuer) {
    return {
      ok: false,
      reason: "native_with_issuer",
      message: `"${entry.code}" is a native asset and does not take an issuer`,
      code: "INVALID_ASSET",
    };
  }

  // Issued asset without issuer provided? Use the default.
  if (entry.type === "issued" && !issuer) {
    if (!entry.issuer) {
      return {
        ok: false,
        reason: "issued_without_issuer",
        message: `"${code}" issuer is not configured. Set STABLE_ASSET_ISSUER or provide an issuer.`,
        code: "INVALID_ASSET",
      };
    }
    assertNetwork(entry);
    return { ok: true, value: stripNetwork(entry) };
  }

  // Issued asset with mismatched issuer?
  if (entry.type === "issued" && issuer && entry.issuer && issuer.trim() !== entry.issuer) {
    return {
      ok: false,
      reason: "issuer_mismatch",
      message: `"${code}" issuer mismatch. Expected ${entry.issuer}, got ${issuer}`,
      code: "INVALID_ASSET",
    };
  }

  assertNetwork(entry);
  return { ok: true, value: stripNetwork(entry) };
}

function stripNetwork(asset: typeof SUPPORTED_ASSETS[0]): ValidatedAsset {
  return {
    code: asset.code,
    type: asset.type,
    issuer: asset.issuer,
    name: asset.name,
  };
}

/**
 * Quick boolean check for supported asset (no throw).
 */
export function isSupportedAsset(code: string, issuer?: string | null): boolean {
  return validateAsset(code, issuer).ok;
}

/**
 * Get list of supported asset codes for Zod schemas.
 */
export function supportedAssetCodes(): string[] {
  return [..._byCode.keys()];
}

// ─── Amount Validation & Conversion ──────────────────────────────────────────

// Loose decimal for initial parse: allows leading zeros
const RAW_DECIMAL_RE = /^\d+(?:\.\d+)?$/;

/**
 * Validate and normalize a decimal amount string.
 * Returns ValidatedAmount with canonical decimal string and stroops.
 * Rejects: malformed, zero/negative, >7dp, out of range, exponent, whitespace.
 */
export function validateAmount(value: string): ValidationOutcome<ValidatedAmount> {
  // Reject whitespace padding (must be exact match after trim)
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
  if (!RAW_DECIMAL_RE.test(trimmed)) {
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

  // Must be positive
  if (stroops <= 0n) {
    return {
      ok: false,
      reason: "zero_or_negative",
      message: "Amount must be greater than zero",
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

/**
 * Convert a canonical decimal string to stroops (BigInt).
 * Precondition: input must be a canonical decimal from validateAmount().
 */
export function toStroops(amount: string): bigint {
  const [whole, frac = ""] = amount.split(".");
  const paddedFrac = (frac + "0000000").slice(0, 7);
  return BigInt(whole) * STROOPS_PER_UNIT + BigInt(paddedFrac);
}

/**
 * Convert stroops to canonical decimal string (API representation).
 */
export function fromStroops(stroops: bigint): string {
  const magnitude = stroops < 0n ? -stroops : stroops;
  const whole = magnitude / STROOPS_PER_UNIT;
  const frac = (magnitude % STROOPS_PER_UNIT).toString().padStart(7, "0").replace(/0+$/, "");
  const sign = stroops < 0n ? "-" : "";
  return frac.length > 0 ? `${sign}${whole}.${frac}` : `${sign}${whole}`;
}

/**
 * Convert stroops to Stellar's wire format (always exactly 7 decimal places).
 */
export function stroopsToStellarAmount(stroops: bigint): string {
  const magnitude = stroops < 0n ? -stroops : stroops;
  const whole = magnitude / STROOPS_PER_UNIT;
  const frac = (magnitude % STROOPS_PER_UNIT).toString().padStart(7, "0");
  const sign = stroops < 0n ? "-" : "";
  return `${sign}${whole}.${frac}`;
}

/**
 * Compare two decimal amounts (canonical strings) using stroops.
 * Returns -1, 0, 1.
 */
export function compareAmounts(a: string, b: string): number {
  const sa = toStroops(a);
  const sb = toStroops(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/**
 * Add two decimal amounts, return canonical decimal string.
 */
export function addAmounts(a: string, b: string): string {
  return fromStroops(toStroops(a) + toStroops(b));
}

/**
 * Subtract b from a, return canonical decimal string.
 * Throws if result would be negative.
 */
export function subtractAmounts(a: string, b: string): string {
  const result = toStroops(a) - toStroops(b);
  if (result < 0n) throw new Error("Amount cannot be negative");
  return fromStroops(result);
}

// ─── Zod Schema Helpers ──────────────────────────────────────────────────────

/**
 * Zod schema for a validated amount.
 * Transforms input to ValidatedAmount { decimal, stroops }.
 */
export const validatedAmountSchema = z
  .string()
  .transform((val, ctx) => {
    const result = validateAmount(val);
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
 * Zod schema for just the canonical decimal string (transforms to normalized form).
 */
export const canonicalAmountSchema = z
  .string()
  .transform((val, ctx) => {
    const result = validateAmount(val);
    if (!result.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: result.message,
      });
      return z.NEVER;
    }
    return result.value.decimal;
  });

/**
 * Zod refinement for asset validation.
 * Attaches errors to the correct field paths.
 */
export function refineValidatedAsset(
  ctx: z.RefinementCtx,
  assetCode: string,
  assetIssuer: string | null | undefined,
  path: { code?: (string | number)[]; issuer?: (string | number)[] } = {}
): void {
  const result = validateAsset(assetCode, assetIssuer ?? null);
  if (!result.ok) {
    const targetPath = result.reason === "native_with_issuer" || result.reason === "issuer_mismatch" || result.reason === "invalid_issuer_format"
      ? (path.issuer ?? ["assetIssuer"])
      : (path.code ?? ["assetCode"]);
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: targetPath,
      message: result.message,
    });
  }
}

/**
 * Reusable { assetCode, assetIssuer } object schema with validation.
 * Transforms to ValidatedAsset.
 */
export const validatedAssetSchema = z
  .object({
    assetCode: z.string().min(1).max(12),
    assetIssuer: z.string().nullable().optional(),
  })
  .superRefine((val, ctx) => refineValidatedAsset(ctx, val.assetCode, val.assetIssuer))
  .transform((val) => {
    const result = validateAsset(val.assetCode, val.assetIssuer ?? null);
    if (!result.ok) return z.NEVER; // Should not happen due to superRefine
    return result.value;
  });

// ─── Combined Schema for Settlement Creation ────────────────────────────────

/**
 * Schema for settlement creation payload with validated asset + amount.
 * Returns { asset: ValidatedAsset; amount: ValidatedAmount }.
 */
export const settlementCreateSchema = z
  .object({
    assetCode: z.string().min(1).max(12),
    assetIssuer: z.string().nullable().optional(),
    amount: z.string().min(1),
    destination: z.string().min(1),
    memoCode: z.string().min(1).max(28),
    validitySeconds: z.number().int().positive().max(300).optional(),
  })
  .superRefine((val, ctx) => {
    refineValidatedAsset(ctx, val.assetCode, val.assetIssuer);
    const amtResult = validateAmount(val.amount);
    if (!amtResult.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amount"],
        message: amtResult.message,
      });
    }
  })
  .transform((val) => {
    const assetResult = validateAsset(val.assetCode, val.assetIssuer ?? null);
    const amtResult = validateAmount(val.amount);
    if (!assetResult.ok || !amtResult.ok) return z.NEVER;
    return {
      asset: assetResult.value,
      amount: amtResult.value,
      destination: val.destination,
      memoCode: val.memoCode,
      validitySeconds: val.validitySeconds,
    };
  });

// ─── Type Exports ────────────────────────────────────────────────────────────

export type ValidatedSettlementCreate = z.infer<typeof settlementCreateSchema>;