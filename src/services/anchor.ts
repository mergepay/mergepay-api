/**
 * Anchor (SEP-1 / SEP-10 / SEP-24) integration.
 *
 * All outbound HTTP to the anchor is funnelled through this module so tests can
 * mock it. The default anchor is the SDF test anchor (testanchor.stellar.org).
 *
 * Every external HTTP call has a bounded timeout. Timeout and transport errors
 * are classified so callers (API routes, worker) can distinguish them from
 * business-logic errors.
 *
 * SEP-24 Transaction Statuses
 * ──────────────────────────
 * See: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md#transaction-history
 *
 * incomplete              → No transaction in progress (initial state)
 * pending_user_transfer_start → Waiting for the user to transfer funds
 * pending_stellar         → Transaction submitted to Stellar, awaiting confirmations
 * pending_trust           → Anchor waiting for trustline
 * pending_user            → Anchor needs more info from the user
 * pending_anchor          → Anchor is processing (intermediate, not yet on-chain)
 * pending_transaction_info_update → Anchor needs updated info from user
 * pending_receiver        → Anchor waiting on receiver (withdrawal)
 * pending_sender          → Anchor waiting on sender (deposit)
 * completed               → Transaction successfully completed
 * no_market               → Anchor cannot fulfill the request
 * too_small               → Amount below minimum
 * too_large               → Amount above maximum
 * error                   → Transaction failed
 * refunded                → Transaction refunded after error
 * expired                 → Transaction expired
 */

import toml from "toml";
import { z } from "zod";
import { config } from "../config";
import { Errors } from "../errors";
import { fetchWithTimeout, withTimeout, TimeoutError, TransportError } from "./timeout";

export interface AnchorToml {
  homeDomain: string;
  webAuthEndpoint: string;
  transferServerSep24: string;
  signingKey: string;
  assets: { code: string; issuer: string | null }[];
}

const tomlCache = new Map<string, { value: AnchorToml; at: number }>();
const TOML_TTL = 5 * 60 * 1000;

// ─── SEP-24 status mapping ─────────────────────────────────────────────────

/**
 * Terminal statuses — once reached, the session must never be overwritten
 * by a subsequent poll cycle.
 */
export const TERMINAL_ANCHOR_STATUSES = new Set([
  "completed",
  "error",
  "refunded",
  "expired",
  "no_market",
  "too_small",
  "too_large",
]);

/**
 * Statuses that should trigger an audit log event when reached via polling.
 */
export const AUDITABLE_ANCHOR_STATUSES = new Set([
  "completed",
  "error",
  "refunded",
  "expired",
  "no_market",
  "too_small",
  "too_large",
]);

/**
 * Normalised result returned by pollTransaction.
 */
export interface PollResult {
  /** The raw status string returned by the anchor (null if unavailable). */
  rawStatus: string | null;
  /** The mapped local status. */
  status: string;
  /** Human-readable message for logging or storing as failureReason. */
  message: string;
  /** True if the poll encountered an error (timeout, network, malformed). */
  isError: boolean;
  /** Anchor-provided transaction JSON for debugging (sanitized). */
  transaction?: Record<string, unknown>;
  /** SEP-24 amount_in / amount_out / amount_fee if available. */
  amountIn?: string;
  amountOut?: string;
  amountFee?: string;
  /** SEP-24 stellar_transaction_hash if available. */
  stellarTransactionHash?: string;
}

// ─── Zod schemas for anchor responses ───────────────────────────────────────

const challengeResponseSchema = z.object({
  transaction: z.string(),
  network_passphrase: z.string().optional(),
});

const tokenResponseSchema = z.object({
  token: z.string(),
});

const interactiveResponseSchema = z.object({
  url: z.string(),
  id: z.string(),
});

const sep24TransactionResponseSchema = z.object({
  transaction: z.object({
    status: z.string(),
    id: z.string().optional(),
    kind: z.string().optional(),
    amount_in: z.string().optional(),
    amount_out: z.string().optional(),
    amount_fee: z.string().optional(),
    started_at: z.string().optional(),
    completed_at: z.string().optional(),
    stellar_transaction_hash: z.string().optional(),
    external_transaction_id: z.string().optional(),
    message: z.string().optional(),
    refunds: z.any().optional(),
  }),
});

// ─── Service implementation ─────────────────────────────────────────────────

export const anchorService = {
  /** Fetch & parse the anchor's stellar.toml (cached 5 min). */
  async getToml(homeDomain: string): Promise<AnchorToml> {
    const cached = tomlCache.get(homeDomain);
    if (cached && Date.now() - cached.at < TOML_TTL) return cached.value;

    const provider = `toml:${homeDomain}`;
    if (anchorCircuit.isOpen(provider)) {
      throw new RetryableError(`Circuit open for anchor ${homeDomain}`, "ANCHOR_CIRCUIT_OPEN", config.ANCHOR_CIRCUIT_COOLDOWN_MS);
    }

    const url = `https://${homeDomain}/.well-known/stellar.toml`;
    const res = await fetchWithTimeout(url, "Anchor.getToml", config.ANCHOR_TOML_TIMEOUT_MS);
    if (!res.ok) {
      throw new RetryableError(`Could not load stellar.toml for ${homeDomain}`, "ANCHOR_UPSTREAM");
    }
    let parsed: any;
    try {
      parsed = toml.parse(await res.text());
    } catch {
      throw new RetryableError("Anchor returned invalid stellar.toml", "ANCHOR_MALFORMED");
    }

    const currencies = Array.isArray(parsed.CURRENCIES) ? parsed.CURRENCIES : [];
    const assets = currencies
      .filter((currency: any) => typeof currency?.code === "string")
      .map((currency: any) => ({
        code: currency.code,
        issuer: typeof currency.issuer === "string" ? currency.issuer : null,
      }));

    if (
      typeof parsed.WEB_AUTH_ENDPOINT !== "string" ||
      typeof parsed.TRANSFER_SERVER_SEP0024 !== "string" ||
      typeof parsed.SIGNING_KEY !== "string"
    ) {
      throw new RetryableError("Anchor stellar.toml is missing required SEP-24 fields", "ANCHOR_MALFORMED");
    }

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

  /** Step 1: get a SEP-10 challenge from the anchor for the user account. */
  async getChallenge(
    webAuthEndpoint: string,
    account: string
  ): Promise<{ transaction: string; networkPassphrase: string }> {
    const url = `${webAuthEndpoint}?account=${encodeURIComponent(account)}`;
    const res = await fetchWithTimeout(url, "Anchor.getChallenge", config.ANCHOR_CHALLENGE_TIMEOUT_MS);
    if (!res.ok) throw Errors.upstream("Anchor SEP-10 challenge request failed");
    const data = parseJson(challengeResponseSchema, await res.json());
    return {
      transaction: data.transaction,
      networkPassphrase: data.network_passphrase ?? config.networkPassphrase,
    };
  },

  /** Step 2: exchange the signed challenge for an anchor JWT. */
  async getToken(webAuthEndpoint: string, signedXdr: string): Promise<string> {
    const res = await fetchWithTimeout(
      webAuthEndpoint,
      "Anchor.getToken",
      config.ANCHOR_TOKEN_TIMEOUT_MS,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transaction: signedXdr }),
      }
    );
    if (!res.ok) throw Errors.upstream("Anchor SEP-10 token exchange failed");
    return parseJson(tokenResponseSchema, await res.json()).token;
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
    const res = await fetchWithTimeout(
      url,
      "Anchor.startInteractive",
      config.ANCHOR_INTERACTIVE_TIMEOUT_MS,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.token}`,
        },
        body: JSON.stringify({
          asset_code: params.assetCode,
          account: params.account,
        }),
      }
    );
    if (!res.ok) throw Errors.upstream("Anchor interactive flow request failed");
    return parseJson(interactiveResponseSchema, await res.json());
  },

  /**
   * Poll a single SEP-24 transaction's status.
   *
   * Returns a raw status string or null if the anchor responded with a
   * non-OK status or the transaction was not found.
   */
  async getTransactionStatus(params: {
    transferServer: string;
    token: string;
    id: string;
  }): Promise<string | null> {
    const provider = `tx:${params.transferServer}`;
    if (anchorCircuit.isOpen(provider)) {
      return null;
    }

    const url = `${params.transferServer}/transaction?id=${encodeURIComponent(
      params.id
    )}`;
    let res: Response;
    try {
      res = await fetchWithTimeout(url, "Anchor.getTransactionStatus", config.ANCHOR_POLL_TIMEOUT_MS, {
        headers: { Authorization: `Bearer ${params.token}` },
      }), 10_000);
      anchorCircuit.recordSuccess(provider);
    } catch {
      anchorCircuit.recordFailure(provider);
      return null;
    }

    if (!res.ok) {
      anchorCircuit.recordFailure(provider);
      return null;
    }

    try {
      const data = parseJson(sep24TransactionResponseSchema, await res.json());
      const rawStatus = data.transaction?.status;
      return rawStatus ? rawStatus.trim().toLowerCase() : null;
    } catch {
      anchorCircuit.recordFailure(provider);
      return null;
    }
  },

  /**
   * Full SEP-24 poll with timeout, error normalization, and rich result.
   *
   * This is the primary method the worker should call. It wraps
   * getTransactionStatus with a timeout, parses the full transaction
   * response, and returns a normalised PollResult.
   */
  async pollTransaction(params: {
    transferServer: string;
    token: string;
    id: string;
    timeoutMs?: number;
  }): Promise<PollResult> {
    const timeoutMs = params.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    const provider = `tx:${params.transferServer}`;
    if (anchorCircuit.isOpen(provider)) {
      return {
        rawStatus: null,
        status: "pending_anchor",
        message: "Anchor circuit is open",
        isError: true,
      };
    }

    const rawStatus =
      typeof tx.status === "string" ? tx.status : (json.status as string | undefined) ?? null;
    if (!rawStatus) {
      return {
        rawStatus: null,
        status: "pending_anchor",
        message: "Anchor response missing transaction status",
        isError: true,
      };
    }

    // Sanitise — only carry forward benign fields for debugging
    const sanitizedTx: Record<string, unknown> = {
      id: tx.id,
      status: rawStatus,
      kind: tx.kind,
      amount_in: tx.amount_in,
      amount_out: tx.amount_out,
      amount_fee: tx.amount_fee,
      started_at: tx.started_at,
      completed_at: tx.completed_at,
      stellar_transaction_hash: tx.stellar_transaction_hash,
      external_transaction_id: tx.external_transaction_id,
      message: tx.message,
      refunds: tx.refunds,
    };

    const mappedStatus = mapAnchorStatus(rawStatus);

    return {
      rawStatus,
      status: mappedStatus,
      message: `SEP-24 status: ${rawStatus} → ${mappedStatus}`,
      isError: false,
      transaction: sanitizedTx,
      amountIn:
        typeof tx.amount_in === "string" || typeof tx.amount_in === "number"
          ? String(tx.amount_in)
          : undefined,
      amountOut:
        typeof tx.amount_out === "string" || typeof tx.amount_out === "number"
          ? String(tx.amount_out)
          : undefined,
      amountFee:
        typeof tx.amount_fee === "string" || typeof tx.amount_fee === "number"
          ? String(tx.amount_fee)
          : undefined,
      stellarTransactionHash:
        typeof tx.stellar_transaction_hash === "string"
          ? tx.stellar_transaction_hash
          : undefined,
    };
  },

};

// ─── Status mapping ─────────────────────────────────────────────────────────

/**
 * Map a raw SEP-24 status string to Mergepay's internal status.
 *
 * Rule: If the upstream returns a status we do not recognise, we map it to
 * "pending_anchor" (a safe intermediate) instead of erroring out, because
 * a future anchor deployment might introduce new intermediate states.
 *
 * Terminal states (completed, error, refunded, expired, no_market,
 * too_small, too_large) are idempotent — the worker must never overwrite
 * them once set.
 */
export function mapAnchorStatus(raw: string): string {
  switch (raw) {
    // ── Terminal (success) ──
    case "completed":
      return "completed";

    // ── Terminal (failure) ──
    case "error":
      return "error";
    case "refunded":
      return "refunded";
    case "expired":
      return "expired";
    case "no_market":
      return "no_market";
    case "too_small":
      return "too_small";
    case "too_large":
      return "too_large";

    // ── Intermediate (requires user action) ──
    case "pending_user_transfer_start":
      return "pending_user_transfer_start";
    case "pending_user":
      return "pending_user";
    case "pending_transaction_info_update":
      return "pending_transaction_info_update";
    case "pending_receiver":
      return "pending_receiver";
    case "pending_sender":
      return "pending_sender";

    // ── Intermediate (anchor / stellar) ──
    case "pending_stellar":
      return "pending_stellar";
    case "pending_trust":
      return "pending_trust";
    case "pending_anchor":
      return "pending_anchor";

    // ── Initial ──
    case "incomplete":
      return "incomplete";

    // ── Unknown → safe default ──
    default:
      return "pending_anchor";
  }
}

/** Whether a normalized status is terminal and no longer needs polling. */
export function isTerminalAnchorStatus(status: string): boolean {
  return status === "completed" || status === "error" || status === "refunded";
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function parseJson<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw Errors.upstream("Anchor returned an unexpected response format");
  }
  return result.data;
}