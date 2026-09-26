/**
 * Stellar asset formatting and utility functions.
 *
 * Provides standard, uniform string representations for Stellar native assets (XLM)
 * and issued credit assets (e.g. USDC:<issuer>) across API responses, logging,
 * and internal payloads.
 */
import { Asset, StrKey } from "@stellar/stellar-sdk";

export interface StellarAssetInput {
  code: string;
  issuer?: string | null;
}

function validateIssuedAsset(code: string, issuer: string): { code: string; issuer: string } {
  const normalizedCode = code.trim();
  const normalizedIssuer = issuer.trim();
  if (!normalizedCode) {
    throw new Error("Issued asset code cannot be empty");
  }
  if (!StrKey.isValidEd25519PublicKey(normalizedIssuer)) {
    throw new Error(`Invalid issuer public key for asset ${normalizedCode}`);
  }

  const asset = new Asset(normalizedCode, normalizedIssuer);
  return { code: asset.getCode(), issuer: asset.getIssuer()! };
}

/**
 * Formats a Stellar asset representation into a canonical string identifier.
 *
 * Standard representation rules:
 * - Native assets (XLM / native) are formatted strictly as `"XLM"`.
 * - Issued credit assets are formatted strictly as `"<code>:<issuer>"`.
 *
 * @param asset - A Stellar Asset instance, an object with code and optional issuer,
 *                or the asset code string. When a plain string is passed it is
 *                treated as the asset code.
 * @param issuer - Optional issuer account public key when passing code as the first argument.
 * @returns Canonical asset string identifier (e.g. "XLM" or "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5").
 *
 * @throws {Error} If the asset input is missing, or a non-native asset is missing its issuing account.
 */
export function formatAssetIdentifier(
  asset: Asset | StellarAssetInput | string,
  issuer?: string | null
): string {
  if (!asset) {
    throw new Error("Asset parameter is required");
  }

  // 1. Instance of Stellar SDK Asset
  if (asset instanceof Asset) {
    if (asset.isNative()) {
      return "XLM";
    }
    const assetIssuer = asset.getIssuer();
    const assetCode = asset.getCode();
    if (!assetIssuer) {
      throw new Error(`Issued asset ${assetCode} is missing an issuer`);
    }
    return `${assetCode}:${assetIssuer}`;
  }

  // 2. Object with code (and optional issuer property)
  if (typeof asset === "object") {
    const code = asset.code?.trim();
    if (!code) {
      throw new Error("Asset object must have a non-empty code property");
    }

    if (code.toUpperCase() === "XLM" || code.toLowerCase() === "native") {
      if (!asset.issuer && !issuer) {
        return "XLM";
      }
    }

    const effectiveIssuer = asset.issuer?.trim() || issuer?.trim();
    if (!effectiveIssuer) {
      if (code.toUpperCase() === "XLM" || code.toLowerCase() === "native") {
        return "XLM";
      }
      throw new Error(`Asset ${code} requires a valid issuer public key`);
    }

    const validated = validateIssuedAsset(code, effectiveIssuer);
    return `${validated.code}:${validated.issuer}`;
  }

  // 3. String representation
  if (typeof asset === "string") {
    const trimmed = asset.trim();
    if (!trimmed) {
      throw new Error("Asset string cannot be empty");
    }

    if (trimmed.toLowerCase() === "native" || (trimmed.toUpperCase() === "XLM" && !issuer)) {
      return "XLM";
    }

    // Check if already in <code>:<issuer> format
    if (trimmed.includes(":")) {
      const parts = trimmed.split(":");
      if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
        const c = parts[0].trim();
        const i = parts[1].trim();
        if (c.toLowerCase() === "native" || c.toUpperCase() === "XLM") {
          if (!i || i.toLowerCase() === "native") return "XLM";
        }
        const validated = validateIssuedAsset(c, i);
        return `${validated.code}:${validated.issuer}`;
      }
      throw new Error(`Invalid asset identifier format: "${trimmed}"`);
    }

    // Code provided as string, issuer provided as second argument
    const effectiveIssuer = issuer?.trim();
    if (!effectiveIssuer) {
      if (trimmed.toUpperCase() === "XLM" || trimmed.toLowerCase() === "native") {
        return "XLM";
      }
      throw new Error(`Asset ${trimmed} requires a valid issuer public key`);
    }

    const validated = validateIssuedAsset(trimmed, effectiveIssuer);
    return `${validated.code}:${validated.issuer}`;
  }

  throw new Error("Unsupported asset input type");
}

/**
 * Parses a canonical asset identifier string into its constituent code and issuer.
 *
 * @param identifier - Asset identifier string (e.g. "native" or "USDC:GBBD47...")
 * @returns Object with code and issuer (issuer is null for native asset).
 */
export function parseAssetIdentifier(identifier: string): { code: string; issuer: string | null } {
  if (!identifier || typeof identifier !== "string") {
    throw new Error("Identifier must be a non-empty string");
  }

  const trimmed = identifier.trim();
  if (trimmed.toLowerCase() === "native" || trimmed.toUpperCase() === "XLM") {
    return { code: "XLM", issuer: null };
  }

  const colonIdx = trimmed.indexOf(":");
  if (colonIdx === -1) {
    throw new Error(`Invalid non-native asset identifier: "${trimmed}". Expected "<code>:<issuer>"`);
  }

  const code = trimmed.slice(0, colonIdx).trim();
  const issuer = trimmed.slice(colonIdx + 1).trim();

  if (!code || !issuer) {
    throw new Error(`Invalid asset identifier components in: "${trimmed}"`);
  }

  return validateIssuedAsset(code, issuer);
}
