/**
 * Shared Zod validation for Stellar accounts, assets, and amounts.
 *
 * Centralizing this means every route that accepts a public key, an asset,
 * or a payment amount rejects the same malformed input the same way, before
 * the request reaches a service or the database. No Horizon I/O happens
 * here — that stays in src/services/stellar.ts.
 */
import { z } from "zod";
import { StrKey } from "@stellar/stellar-sdk";
import { config } from "../config";

/** Stellar's ledger-enforced ceiling for a signed 64-bit stroop amount (Int64 max). */
export const MAX_STROOPS = 9223372036854775807n;

const PLAIN_DECIMAL_RE = /^\d+(\.\d+)?$/;

/**
 * Parse a plain decimal amount string into stroops (value * 10^7), enforcing
 * Stellar's 7-decimal-place precision and the network's max representable
 * value. Throws a descriptive Error on anything that isn't a clean, positive,
 * in-range decimal — no exponents, signs, whitespace, or extra precision.
 */
export function parseStellarAmount(raw: string): bigint {
  const trimmed = raw.trim();
  if (trimmed !== raw || !PLAIN_DECIMAL_RE.test(trimmed)) {
    throw new Error(
      "Amount must be a plain decimal string (no exponents, signs, or whitespace)"
    );
  }
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > 7) {
    throw new Error("Amount supports at most 7 decimal places");
  }
  const stroops = BigInt(whole) * 10_000_000n + BigInt((frac + "0000000").slice(0, 7));
  if (stroops <= 0n) {
    throw new Error("Amount must be greater than zero");
  }
  if (stroops > MAX_STROOPS) {
    throw new Error("Amount exceeds the maximum representable Stellar value");
  }
  return stroops;
}

function isValidStellarAmount(raw: string): boolean {
  try {
    parseStellarAmount(raw);
    return true;
  } catch {
    return false;
  }
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
 * Validates an { assetCode, assetIssuer } pair against the assets Mergepay
 * supports: native XLM (never an issuer) and the configured stablecoin
 * (always the configured issuer for the active network). Called from a
 * schema's `.superRefine` so field-level errors attach to the right path.
 */
export function refineStellarAsset(
  ctx: z.RefinementCtx,
  assetCode: string,
  assetIssuer: string | null | undefined,
  path: { code?: (string | number)[]; issuer?: (string | number)[] } = {}
): void {
  const issuer = assetIssuer ?? null;
  const codePath = path.code ?? ["assetCode"];
  const issuerPath = path.issuer ?? ["assetIssuer"];

  if (assetCode === "XLM") {
    if (issuer) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: issuerPath,
        message: "XLM must not specify an issuer",
      });
    }
    return;
  }

  if (assetCode === config.STABLE_ASSET_CODE) {
    if (issuer !== config.STABLE_ASSET_ISSUER) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: issuerPath,
        message: `${config.STABLE_ASSET_CODE} requires the configured issuer for the ${config.STELLAR_NETWORK} network`,
      });
    }
    return;
  }

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: codePath,
    message: `Unsupported asset: ${assetCode}`,
  });
}

/** Reusable { assetCode, assetIssuer } object schema with asset support validated. */
export const stellarAssetSchema = z
  .object({
    assetCode: z.string().min(1).max(12),
    assetIssuer: z.string().nullable().optional(),
  })
  .superRefine((val, ctx) => refineStellarAsset(ctx, val.assetCode, val.assetIssuer));
