/**
 * Centralized Stellar asset configuration and validation.
 *
 * Every supported asset (XLM native, USDC issued, etc.) is defined once here
 * with its code, type, issuer, precision, and valid network(s).  Services and
 * routes import from this module instead of scattering string literals or
 * ad‑hoc checks across the codebase.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *
 *   import { getAssetConfig, validateAsset } from "../services/assets";
 *
 *   const asset = getAssetConfig("USDC", "G…");   // → AssetConfig
 *   validateAsset("XLM");                          // → never throws
 *   validateAsset("BADCOIN", "G…");                // → throws AppError
 *   validateAmount("123.4567890");                  // → ok
 *   validateAmount("123.45678901");                 // → throws
 */

import { StrKey } from "@stellar/stellar-sdk";
import { config } from "../config";
import { Errors } from "../errors";
import type { AssetSpec } from "./stellar";
import {
  validateAsset as libValidateAsset,
  validateAmount as libValidateAmount,
  isSupportedAsset as libIsSupportedAsset,
  supportedAssetCodes as libSupportedAssetCodes,
} from "../lib/money";

// ─── Types ─────────────────────────────────────────────────────────────────

export type AssetType = "native" | "issued";

export interface SupportedAsset {
  /** Stellar asset code (e.g. "XLM", "USDC"). */
  code: string;
  /** "native" for XLM, "issued" for all other assets. */
  type: AssetType;
  /** The asset issuer's Stellar public key. `null` for native assets. */
  issuer: string | null;
  /** Human-friendly label. */
  name: string;
  /**
   * Which Stellar network(s) this asset is considered valid on.
   * - `"both"` – valid on testnet and public
   * - `"public"` – only valid on public network
   * - `"testnet"` – only valid on testnet
   */
  network: "testnet" | "public" | "both";
}

/**
 * Resolved asset configuration returned after validation.
 * Narrower than SupportedAsset because the network is already matched.
 */
export interface AssetConfig {
  code: string;
  type: AssetType;
  issuer: string | null;
  name: string;
}

/** Maximum number of decimal places Stellar supports. */
export const ASSET_PRECISION = 7;

// ─── Asset registry ────────────────────────────────────────────────────────

/**
 * The complete list of assets Mergepay officially supports.
 *
 * To add a new asset, add an entry here and ensure the routes that accept
 * asset codes also list the new code in their Zod schemas (the asset module
 * will reject the code, but a descriptive Zod message is friendlier).
 */
export const SUPPORTED_ASSETS: SupportedAsset[] = [
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

// Fast lookup maps
const _byCode = new Map<string, SupportedAsset>();
const _byCodeIssuer = new Map<string, SupportedAsset>();

for (const a of SUPPORTED_ASSETS) {
  _byCode.set(a.code.toUpperCase(), a);
  const key = issuerKey(a.code, a.issuer);
  _byCodeIssuer.set(key, a);
}

function issuerKey(code: string, issuer: string | null): string {
  return `${code.toUpperCase()}::${issuer ?? ""}`;
}

// ─── Validation ────────────────────────────────────────────────────────────

/**
 * Look up a supported asset by code and optional issuer.
 *
 * Returns the `AssetConfig` on success.
 *
 * Throws a controlled `AppError` (400 BAD_REQUEST) when:
 * - The asset code is not in the supported list.
 * - An issuer is provided for a native asset (XLM).
 * - The issuer does not match the supported issuer for an issued asset.
 * - The asset is not valid for the currently configured Stellar network.
 */
export function getAssetConfig(
  code: string,
  issuer?: string | null
): AssetConfig {
  const result = libValidateAsset(code, issuer);
  if (!result.ok) {
    throw Errors.badRequest("invalid_asset", result.message);
  }
  return result.value;
}

/**
 * Validate an asset code + issuer combination and return the config.
 * Convenience wrapper around `getAssetConfig` that also runs
 * `validateIssuer` on non‑null issuers.
 */
export function validateAsset(
  code: string,
  issuer?: string | null
): AssetConfig {
  if (issuer) {
    validateIssuer(issuer);
  }
  return getAssetConfig(code, issuer ?? undefined);
}

/**
 * Assert that `key` is a syntactically valid Stellar public key.
 * Throws a controlled AppError (400) on failure.
 */
export function validateIssuer(issuer: string): void {
  if (!StrKey.isValidEd25519PublicKey(issuer)) {
    throw Errors.badRequest(
      "invalid_asset",
      `"${issuer}" is not a valid Stellar public key`
    );
  }
}

/**
 * Assert that an amount string respects Stellar's 7‑decimal precision limit
 * and is a positive number.  Returns the validated amount string (canonical form).
 *
 * Rejects:
 * - Empty or non‑numeric strings.
 * - Zero or negative amounts.
 * - Values with more than 7 decimal places.
 * - Exponent notation, whitespace padding.
 * - Amounts exceeding Stellar's Int64 range.
 *
 * Uses BigInt arithmetic only — never floating point.
 */
export function validateAmount(value: string): string {
  const result = libValidateAmount(value);
  if (!result.ok) {
    throw Errors.badRequest("invalid_amount", result.message);
  }
  return result.value.decimal;
}

/**
 * Validate an `AssetSpec`-shaped object.
 */
export function validateAssetSpec(spec: { code: string; issuer?: string | null }): AssetConfig {
  return validateAsset(spec.code, spec.issuer ?? null);
}

/**
 * Convert an `AssetConfig` back to the `AssetSpec` shape expected by
 * `src/services/stellar.ts`.
 */
export function assetConfigToSpec(asset: AssetConfig): AssetSpec {
  return { code: asset.code, issuer: asset.issuer };
}

/**
 * Quick check: is the given code+issuer a supported asset?
 * Returns `true`/`false` — no throw.
 */
export function isSupportedAsset(code: string, issuer?: string | null): boolean {
  return libIsSupportedAsset(code, issuer);
}

/**
 * Return the list of supported asset codes for use in Zod schemas etc.
 */
export function supportedAssetCodes(): string[] {
  return libSupportedAssetCodes();
}

/**
 * Startup validation of the asset-related configuration, called once by
 * `buildApp()`. Failing here surfaces a misconfigured deployment at boot
 * rather than as a confusing 400 on the first settlement attempt. Also
 * validates the static SUPPORTED_ASSETS list itself (no duplicate codes,
 * every issued asset has an issuer) so a bad edit to that list is caught
 * the same way as bad environment configuration.
 */
export function validateAssetConfig(): void {
  const seen = new Set<string>();
  for (const a of SUPPORTED_ASSETS) {
    if (seen.has(a.code.toUpperCase())) {
      throw new Error(`Duplicate asset code "${a.code}" in SUPPORTED_ASSETS`);
    }
    seen.add(a.code.toUpperCase());
    if (a.type === "issued" && !a.issuer) {
      throw new Error(
        `Issued asset "${a.code}" requires a non-empty issuer. Set STABLE_ASSET_ISSUER.`
      );
    }
  }

  const stableCode = config.STABLE_ASSET_CODE?.trim();
  if (!stableCode) {
    throw new Error("STABLE_ASSET_CODE must be set");
  }

  const stable = _byCode.get(stableCode.toUpperCase());
  if (!stable) {
    throw new Error(
      `STABLE_ASSET_CODE "${stableCode}" is not one of the supported assets ` +
        `(${supportedAssetCodes().join(", ")})`
    );
  }

  if (stable.type === "issued") {
    const issuer = config.STABLE_ASSET_ISSUER?.trim();
    if (!issuer) {
      throw new Error(`STABLE_ASSET_ISSUER must be set for issued asset "${stableCode}"`);
    }
    if (!StrKey.isValidEd25519PublicKey(issuer)) {
      throw new Error("STABLE_ASSET_ISSUER is not a valid Stellar public key");
    }
  }
}

// ─── Internal helpers ──────────────────────────────────────────────────────

function assertNetwork(asset: SupportedAsset): void {
  if (asset.network === "both") return;

  // config.STELLAR_NETWORK is "testnet" | "public"
  const currentNetwork: string = config.STELLAR_NETWORK ?? "public";

  if (asset.network !== currentNetwork) {
    throw Errors.badRequest(
      "invalid_asset",
      `"${asset.code}" is not available on the ${currentNetwork} network ` +
        `(valid on: ${asset.network})`
    );
  }
}

function stripNetwork(asset: SupportedAsset): AssetConfig {
  return {
    code: asset.code,
    type: asset.type,
    issuer: asset.issuer,
    name: asset.name,
  };
}