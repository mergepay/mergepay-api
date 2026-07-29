/**
 * Anchor (SEP-1 / SEP-10 / SEP-24) integration.
 *
 * All outbound HTTP to the anchor is funnelled through this module so tests can
 * mock it. The default anchor is the SDF test anchor (testanchor.stellar.org).
 */

import { createHmac, timingSafeEqual } from "crypto";
import toml from "toml";
import { config } from "../config";
import { Errors } from "../errors";

export interface AnchorToml {
  homeDomain: string;
  webAuthEndpoint: string;
  transferServerSep24: string;
  signingKey: string;
  assets: { code: string; issuer: string | null }[];
}

const tomlCache = new Map<string, { value: AnchorToml; at: number }>();
const TOML_TTL = 5 * 60 * 1000;

// Retry configuration: exponential backoff with jitter
const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 100,
  maxDelayMs: 2000,
};

/**
 * Calculate delay with exponential backoff and bounded jitter.
 * @param attempt - Current attempt number (0-indexed)
 * @returns Delay in milliseconds
 */
function calculateBackoffDelay(attempt: number): number {
  const exponentialDelay = RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * RETRY_CONFIG.baseDelayMs; // Add bounded jitter
  return Math.min(exponentialDelay + jitter, RETRY_CONFIG.maxDelayMs);
}

/**
 * Check if a status code indicates a transient error that should be retried.
 * @param status - HTTP status code
 * @returns true if the error is transient (5xx)
 */
function isTransientError(status: number): boolean {
  return status >= 500 && status < 600;
}

/**
 * Sleep for a given number of milliseconds.
 * @param ms - Milliseconds to sleep
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with exponential backoff retry for transient errors.
 * Does NOT retry 4xx errors.
 * @param url - URL to fetch
 * @param options - Fetch options
 * @param attempt - Current attempt number (internal use)
 * @returns Response object
 */
async function fetchWithRetry(
  url: string,
  options?: RequestInit,
  attempt = 0
): Promise<Response> {
  const res = await fetch(url, options);

  // Don't retry 4xx errors
  if (res.status >= 400 && res.status < 500) {
    return res;
  }

  // Retry transient 5xx/network errors
  if (!res.ok && isTransientError(res.status) && attempt < RETRY_CONFIG.maxRetries) {
    const delay = calculateBackoffDelay(attempt);
    await sleep(delay);
    return fetchWithRetry(url, options, attempt + 1);
  }

  return res;
}

export const anchorService = {
  /**
   * Fetch & parse the anchor's stellar.toml (cached 5 min).
   * Retries transient errors with exponential backoff.
   */
  async getToml(homeDomain: string): Promise<AnchorToml> {
    const cached = tomlCache.get(homeDomain);
    if (cached && Date.now() - cached.at < TOML_TTL) return cached.value;

    const url = `https://${homeDomain}/.well-known/stellar.toml`;
    const res = await fetchWithRetry(url);
    if (!res.ok) {
      throw Errors.upstream(`Could not load stellar.toml for ${homeDomain}`);
    }
    const parsed = toml.parse(await res.text());

    const assets = (parsed.CURRENCIES ?? []).map((c: any) => ({
      code: c.code,
      issuer: c.issuer ?? null,
    }));

    const value: AnchorToml = {
      homeDomain,
      webAuthEndpoint: parsed.WEB_AUTH_ENDPOINT,
      transferServerSep24: parsed.TRANSFER_SERVER_SEP0024,
      signingKey: parsed.SIGNING_KEY,
      assets,
    };
    tomlCache.set(homeDomain, { value, at: Date.now() });
    return value;
  },

  /**
   * Clear the TOML cache (useful for testing).
   */
  clearTomlCache(): void {
    tomlCache.clear();
  },

  /**
   * Get retry configuration (useful for testing).
   */
  getRetryConfig() {
    return { ...RETRY_CONFIG };
  },

  /** Step 1: get a SEP-10 challenge from the anchor for the user account. */
  async getChallenge(
    webAuthEndpoint: string,
    account: string
  ): Promise<{ transaction: string; networkPassphrase: string }> {
    const url = `${webAuthEndpoint}?account=${encodeURIComponent(account)}`;
    const res = await fetchWithRetry(url);
    if (!res.ok) throw Errors.upstream("Anchor SEP-10 challenge request failed");
    const data: any = await res.json();
    return {
      transaction: data.transaction,
      networkPassphrase: data.network_passphrase ?? config.networkPassphrase,
    };
  },

  /** Step 2: exchange the signed challenge for an anchor JWT. */
  async getToken(webAuthEndpoint: string, signedXdr: string): Promise<string> {
    const res = await fetchWithRetry(webAuthEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transaction: signedXdr }),
    });
    if (!res.ok) throw Errors.upstream("Anchor SEP-10 token exchange failed");
    const data: any = await res.json();
    return data.token;
  },

  /** Step 3: start a SEP-24 interactive deposit/withdraw. */
  async startInteractive(params: {
    transferServer: string;
    token: string;
    kind: "deposit" | "withdrawal";
    assetCode: string;
    account: string;
  }): Promise<{ url: string; id: string }> {
    const path = params.kind === "deposit" ? "deposit" : "withdraw";
    const url = `${params.transferServer}/transactions/${path}/interactive`;
    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.token}`,
      },
      body: JSON.stringify({
        asset_code: params.assetCode,
        account: params.account,
      }),
    });
    if (!res.ok) throw Errors.upstream("Anchor interactive flow request failed");
    const data: any = await res.json();
    return { url: data.url, id: data.id };
  },

  /** Poll a single SEP-24 transaction's status. */
  async getTransactionStatus(params: {
    transferServer: string;
    token: string;
    id: string;
  }): Promise<string | null> {
    const url = `${params.transferServer}/transaction?id=${encodeURIComponent(
      params.id
    )}`;
    const res = await fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${params.token}` },
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    return data?.transaction?.status ?? null;
  },
};

/**
 * Verify a webhook signature from an anchor using HMAC-SHA256.
 * @param payload - Raw request body as string
 * @param signature - Value of x-anchor-signature header
 * @param secret - The signing key from anchor's stellar.toml
 * @returns true if signature is valid
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const expected = createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
  const expectedBuffer = Buffer.from(`sha256=${expected}`, "utf8");
  const signatureBuffer = Buffer.from(signature, "utf8");

  // Ensure buffers are same length for timing-safe comparison
  if (expectedBuffer.length !== signatureBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, signatureBuffer);
}

/** Map a raw SEP-24 status to Mergepay's AnchorSessionStatus enum. */
export function mapAnchorStatus(raw: string): string {
  switch (raw) {
    case "completed":
      return "completed";
    case "pending_user_transfer_start":
      return "pending_user_transfer_start";
    case "error":
    case "too_small":
    case "too_large":
      return "error";
    case "refunded":
      return "refunded";
    case "incomplete":
      return "incomplete";
    default:
      return "pending_anchor";
  }
}
