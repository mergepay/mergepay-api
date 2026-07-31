import { z } from "zod";
import { config } from "../config";

/** Stellar represents asset amounts as signed int64 stroops. */
export const STROOPS_PER_XLM = 10_000_000n;
export const MAX_STROOPS = 9_223_372_036_854_775_807n;
export const MAX_AMOUNT = "922337203685.4775807";

const CANONICAL_AMOUNT = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const CANONICAL_STROOPS = /^-?(?:0|[1-9]\d*)$/;

/** Absolute value of a bigint — used by balance math, which is signed. */
export function bigIntAbs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

export function normalizeAmount(value: string): string {
  if (typeof value !== "string") {
    throw new Error("Amount must be a decimal string");
  }
  if (!CANONICAL_AMOUNT.test(value)) {
    throw new Error("Amount must be a canonical decimal string");
  }

  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > 7) {
    throw new Error("Amount must have at most 7 decimal places");
  }

  const stroops = toStroops(value);
  if (stroops <= 0n) {
    throw new Error("Amount must be greater than zero");
  }
  if (stroops > MAX_STROOPS) {
    throw new Error("Amount exceeds the supported Stellar range");
  }

  const trimmedFraction = fraction.replace(/0+$/, "");
  return trimmedFraction.length > 0 ? `${whole}.${trimmedFraction}` : whole;
}

/**
 * Parse a canonical decimal amount exactly, without floating-point arithmetic.
 *
 * Signed values are accepted because net balances are signed (negative = owes).
 * Route input is validated with `normalizeAmount`/`amountSchema`, which stay
 * strictly positive.
 */
export function toStroops(amount: string): bigint {
  if (typeof amount !== "string" || !CANONICAL_AMOUNT.test(amount)) {
    throw new Error("Amount must be a canonical decimal string");
  }

  const negative = amount.startsWith("-");
  const [whole, fraction = ""] = (negative ? amount.slice(1) : amount).split(".");
  if (fraction.length > 7) {
    throw new Error("Amount must have at most 7 decimal places");
  }

  const paddedFraction = fraction.padEnd(7, "0");
  const magnitude = BigInt(whole) * STROOPS_PER_XLM + BigInt(paddedFraction || "0");
  if (magnitude > MAX_STROOPS) {
    throw new Error("Amount exceeds the supported Stellar range");
  }
  return negative ? -magnitude : magnitude;
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
    if (!CANONICAL_STROOPS.test(stroops)) {
      throw new Error("Stroop value must be a canonical integer string");
    }
    value = BigInt(stroops);
  }

  if (bigIntAbs(value) > MAX_STROOPS) {
    throw new Error("Stroop value is outside the supported Stellar range");
  }

  const sign = value < 0n ? "-" : "";
  const magnitude = bigIntAbs(value);
  const whole = magnitude / STROOPS_PER_XLM;
  const fraction = (magnitude % STROOPS_PER_XLM)
    .toString()
    .padStart(7, "0")
    .replace(/0+$/, "");
  return fraction.length > 0 ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}

/**
 * Render stroops the way Stellar itself expects an amount on the wire: always
 * exactly 7 decimal places, no trailing-zero trimming. `fromStroops` is the
 * canonical *API* representation; this is the canonical *ledger* one.
 */
export function stroopsToStellarAmount(stroops: bigint): string {
  if (bigIntAbs(stroops) > MAX_STROOPS) {
    throw new Error("Stroop value is outside the supported Stellar range");
  }
  const sign = stroops < 0n ? "-" : "";
  const magnitude = bigIntAbs(stroops);
  const whole = magnitude / STROOPS_PER_XLM;
  const fraction = (magnitude % STROOPS_PER_XLM).toString().padStart(7, "0");
  return `${sign}${whole}.${fraction}`;
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
  return fromStroops(toStroops(normalizeAmount(left)) + toStroops(normalizeAmount(right)));
}

export function subtractAmounts(left: string, right: string): string {
  const result = toStroops(normalizeAmount(left)) - toStroops(normalizeAmount(right));
  if (result < 0n) throw new Error("Amount cannot be negative");
  return fromStroops(result);
}

export function compareAmounts(left: string, right: string): number {
  const a = toStroops(normalizeAmount(left));
  const b = toStroops(normalizeAmount(right));
  return a < b ? -1 : a > b ? 1 : 0;
}

export const amountSchema = z
  .string()
  .superRefine((value, ctx) => {
    try {
      normalizeAmount(value);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : "Invalid amount",
      });
    }
  })
  .transform(normalizeAmount);

export const assetSchema = z
  .object({
    assetCode: z.string(),
    assetIssuer: z.string().nullable().optional(),
  })
  .superRefine((asset, ctx) => {
    if (asset.assetCode === "XLM") {
      if (asset.assetIssuer !== undefined && asset.assetIssuer !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["assetIssuer"],
          message: "XLM must not include an issuer",
        });
      }
      return;
    }

    if (asset.assetCode !== config.STABLE_ASSET_CODE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assetCode"],
        message: "Unsupported asset code",
      });
      return;
    }

    if (asset.assetIssuer !== config.STABLE_ASSET_ISSUER) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assetIssuer"],
        message: "Invalid issuer for the configured asset",
      });
    }
  });

export function validateAsset(assetCode: string, assetIssuer?: string | null): {
  assetCode: "XLM" | string;
  assetIssuer: string | null;
} {
  const parsed = assetSchema.parse({ assetCode, assetIssuer });
  return {
    assetCode: parsed.assetCode,
    assetIssuer: parsed.assetIssuer ?? null,
  };
}
