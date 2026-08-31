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
import pino from "pino";
import { config } from "../config";
import { Errors } from "../errors";
import { fetchWithTimeout } from "./timeout";
import { anchorCircuit } from "./anchor-circuit";
import { logRetryAttempt, upstreamCauseOf, withRetry } from "./retry";

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
  /** Classification of the failure if isError is true. */
  errorCategory?: "transient" | "indeterminate" | "permanent";
  /**
   * Whether the raw status was recognized as a known SEP-24 value. Unknown
   * statuses map to `pending_anchor` but carry `recognized === false` so the
   * worker can log them explicitly.
   */
  recognized?: boolean;
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

const sep24TransactionResponseSchema = z
  .object({
    transaction: z
      .object({
        status: z.string().min(1),
        id: z.string().optional(),
        kind: z.string().optional(),
        amount_in: z.union([z.string(), z.number()]).optional(),
        amount_out: z.union([z.string(), z.number()]).optional(),
        amount_fee: z.union([z.string(), z.number()]).optional(),
        started_at: z.string().optional(),
        completed_at: z.string().optional(),
        stellar_transaction_hash: z.string().optional(),
        external_transaction_id: z.string().optional(),
        message: z.string().optional(),
        refunds: z.any().optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((data, ctx) => {
    // A transaction without a usable status is malformed — never accept a
    // blank/whitespace status that would silently round-trip to pending.
    const raw = data.transaction.status.trim();
    if (!raw) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transaction", "status"],
        message: "transaction status must be a non-empty string",
      });
    }
  });

// ─── Retry policy for anchor reads ──────────────────────────

/**
 * Structured sink for retry telemetry. Anchor calls run from routes and from
 * the reconciliation worker alike, so there is no request logger to borrow;
 * attempt metadata goes to the console with the operation and attempt number
 * and nothing from the anchor's response body.
 */
const retryLog = {
  warn(entry: object, message: string): void {
    console.warn(`[anchor] ${message}`, JSON.stringify(entry));
  },
};

/**
 * A non-OK anchor response, raised so the retry policy can classify it by
 * status. `fetch` resolves for 4xx and 5xx alike, so without this the policy
 * would see a successful attempt and a 503 would never be retried.
 *
 * The status is all that crosses this boundary — the anchor's body is not
 * attached, since it reaches the client only as a stable UPSTREAM_ERROR.
 */
class AnchorHttpError extends Error {
  readonly status: number;
  /**
   * `withTimeout` passes an error through untouched only when it carries both
   * `statusCode` and `code` — its test for an intentional application error.
   * Without them this would be rewrapped as a `TransportError` and a 4xx would
   * be retried as though the connection had failed.
   */
  readonly statusCode: number;
  readonly code = "UPSTREAM_ERROR";

  constructor(operation: string, status: number) {
    super(`Anchor "${operation}" responded with HTTP ${status}`);
    this.name = "AnchorHttpError";
    this.status = status;
    this.statusCode = status;
  }
}

/**
 * Fetch an anchor **read** endpoint with a per-attempt timeout and bounded
 * retries. 5xx and transport failures are repeated with backoff; 4xx — 429
 * included — surface immediately. See `src/services/retry.ts` for the rules
 * governing which calls may use this and which must not.
 */
async function fetchReadWithRetry(
  url: string,
  operation: string,
  timeoutMs: number,
  init?: RequestInit
): Promise<Response> {
  return withRetry(
    {
      operation,
      timeoutMs,
      onAttemptFailed: (entry) => logRetryAttempt(retryLog, entry),
    },
    async (signal) => {
      const response = await fetch(url, { ...init, signal });
      // Surface the status as a throw so retry classification can see it; the
      // caller still gets the Response back when the attempt succeeds.
      if (!response.ok) throw new AnchorHttpError(operation, response.status);
      return response;
    }
  );
}

// ─── Service implementation ─────────────────────────────────────────────────

export const anchorService = {
  /**
   * Fetch & parse the anchor's stellar.toml (cached 5 min).
   *
   * A read, so transient failures are retried before the circuit breaker sees
   * a failure: one dropped connection to an otherwise healthy anchor should
   * not count toward opening the circuit. Only an exhausted attempt budget —
   * or a permanent 4xx — records a failure against the provider.
   */
  async getToml(homeDomain: string): Promise<AnchorToml> {
    const cached = tomlCache.get(homeDomain);
    if (cached && Date.now() - cached.at < TOML_TTL) return cached.value;

    const provider = `toml:${homeDomain}`;
    if (anchorCircuit.isOpen(provider)) {
      throw Errors.upstream(`Circuit open for anchor ${homeDomain}`);
    }

    const url = `https://${homeDomain}/.well-known/stellar.toml`;
    let res: Response;
    try {
      res = await fetchReadWithRetry(url, "Anchor.getToml", config.ANCHOR_TOML_TIMEOUT_MS);
    } catch (err) {
      anchorCircuit.recordFailure(provider);
      throw err;
    }
    let parsed: any;
    try {
      parsed = toml.parse(await res.text());
    } catch {
      anchorCircuit.recordFailure(provider);
      throw Errors.upstream("Anchor returned invalid stellar.toml");
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
      anchorCircuit.recordFailure(provider);
      throw Errors.upstream("Anchor stellar.toml is missing required SEP-24 fields");
    }
    anchorCircuit.recordSuccess(provider);

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

  async getAnchorConfig(): Promise<AnchorToml> {
    return this.getToml(config.ANCHOR_HOME_DOMAIN);
  },

  /**
   * Step 1: get a SEP-10 challenge from the anchor for the user account.
   *
   * A read: the challenge is issued fresh per request and an abandoned one
   * simply expires unused, so repeating the call creates no lasting state.
   */
  async getChallenge(
    webAuthEndpoint: string,
    account: string
  ): Promise<{ transaction: string; networkPassphrase: string }> {
    const url = `${webAuthEndpoint}?account=${encodeURIComponent(account)}`;
    const res = await fetchReadWithRetry(
      url,
      "Anchor.getChallenge",
      config.ANCHOR_CHALLENGE_TIMEOUT_MS
    );
    const data = parseJson(challengeResponseSchema, await res.json());
    return {
      transaction: data.transaction,
      networkPassphrase: data.network_passphrase ?? config.networkPassphrase,
    };
  },

  /**
   * Step 2: exchange the signed challenge for an anchor JWT.
   *
   * Deliberately a single attempt. The challenge is single-use: an anchor that
   * consumed it and lost the response will reject the repeat as a replay, so a
   * retry turns a recoverable timeout into a hard authentication failure. The
   * caller restarts from `getChallenge` instead.
   */
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

  /**
   * Start a SEP-24 interactive deposit or withdrawal flow.
   *
   * Deliberately a single attempt. This creates a transaction record on the
   * anchor side; repeating it after a lost response leaves the user with two
   * open anchor sessions for one intent, only one of which we track.
   */
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
   *
   * A read, so transient failures are retried within the call. The circuit
   * breaker only records a failure once the attempt budget is exhausted —
   * counting each individual attempt would open the circuit after a single
   * bad poll rather than after a genuinely unhealthy anchor.
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
      res = await fetchReadWithRetry(
        url,
        "Anchor.getTransactionStatus",
        config.ANCHOR_POLL_TIMEOUT_MS,
        { headers: { Authorization: `Bearer ${params.token}` } }
      );
      anchorCircuit.recordSuccess(provider);
    } catch {
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
   *
   * A read, so transient failures are retried inside the call before a
   * `PollResult` with `isError` is returned. The worker's own retry schedule
   * therefore governs genuinely unavailable anchors rather than momentary
   * blips, and the circuit breaker counts one failure per exhausted budget
   * rather than one per attempt.
   */
  async pollTransaction(params: {
    transferServer: string;
    token: string;
    id: string;
    timeoutMs?: number;
  }): Promise<PollResult> {
    const timeoutMs = params.timeoutMs ?? config.ANCHOR_POLL_TIMEOUT_MS;
    const provider = `tx:${params.transferServer}`;
    if (anchorCircuit.isOpen(provider)) {
      return {
        rawStatus: null,
        status: "pending_anchor",
        message: "Anchor circuit is open",
        isError: true,
        errorCategory: "transient",
      };
    }

    const url = `${params.transferServer}/transaction?id=${encodeURIComponent(params.id)}`;

    let response: Response;
    try {
      response = await fetchReadWithRetry(url, "Anchor.pollTransaction", timeoutMs, {
        headers: { Authorization: `Bearer ${params.token}` },
      });
      anchorCircuit.recordSuccess(provider);
    } catch (err: unknown) {
      anchorCircuit.recordFailure(provider);
      // The retry wrapper maps every failure to a stable upstream error, so the
      // anchor's HTTP status is read back off the preserved cause to keep the
      // previous poll-result message intact.
      const cause = upstreamCauseOf(err);
      const message =
        cause instanceof AnchorHttpError
          ? `Anchor returned HTTP ${cause.status}`
          : `Anchor poll failed: ${err instanceof Error ? err.message : String(err)}`;
      return {
        rawStatus: null,
        status: "pending_anchor",
        message,
        isError: true,
        errorCategory: isTransient ? "transient" : "permanent",
      };
    }

    let json: Record<string, unknown>;
    try {
      json = (await response.json()) as Record<string, unknown>;
    } catch {
      anchorCircuit.recordFailure(provider);
      return {
        rawStatus: null,
        status: "pending_anchor",
        message: "Anchor returned malformed (non-JSON) response",
        isError: true,
        errorCategory: "permanent",
      };
    }

    const parseResult = sep24TransactionResponseSchema.safeParse(json);
    if (!parseResult.success) {
      anchorCircuit.recordFailure(provider);
      return {
        rawStatus: null,
        status: "pending_anchor",
        message: "Anchor returned invalid or malformed transaction response schema",
        isError: true,
        errorCategory: "permanent",
      };
    }

    const tx = parseResult.data.transaction;
    const rawStatus = tx.status;
    const recognized = isKnownSep24Status(rawStatus);
    const mappedStatus = mapAnchorStatus(rawStatus);

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
      message: typeof tx.message === "string" ? safeFailureMessage(tx.message) : undefined,
      refunds: tx.refunds,
    };

    let displayMessage = `SEP-24 status: ${rawStatus} → ${mappedStatus}`;
    if (mappedStatus === "error" && typeof tx.message === "string") {
      displayMessage = safeFailureMessage(tx.message);
    }

    if (!recognized) {
      log.warn(
        {
          rawStatus,
          mappedStatus,
          externalTransactionId: params.id,
        },
        `SEP-24 transaction reported an unknown status: ${rawStatus} — mapping to ${mappedStatus} and will keep polling`
      );
    }

    return {
      rawStatus,
      status: mappedStatus,
      message: displayMessage,
      isError: false,
      recognized,
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
 * The exhaustive set of SEP-24 transaction statuses (lowercased) that we
 * understand and map explicitly. Any status outside this set is treated as
 * unknown and handled explicitly rather than silently swallowed.
 *
 * See: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md#transaction-history
 */
export const KNOWN_SEP24_STATUSES: ReadonlySet<string> = new Set([
  // Initial
  "incomplete",
  // Intermediate
  "pending_user_transfer_start",
  "pending_stellar",
  "pending_trust",
  "pending_user",
  "pending_anchor",
  "pending_transaction_info_update",
  "pending_receiver",
  "pending_sender",
  // Terminal
  "completed",
  "no_market",
  "too_small",
  "too_large",
  "error",
  "refunded",
  "expired",
]);

/** Whether a raw status string is a recognized SEP-24 value (case-insensitive). */
export function isKnownSep24Status(raw: string): boolean {
  if (!raw) return false;
  return KNOWN_SEP24_STATUSES.has(raw.trim().toLowerCase());
}

/**
 * Map a raw SEP-24 status string to Mergepay's internal status.
 *
 * The mapping is exhaustive for every known SEP-24 value and funnels
 * terminal failures into the repository's single `error` state. If the
 * upstream returns a status we do not recognise, we map it to
 * "pending_anchor" (a safe intermediate) instead of erroring out, because a
 * future anchor deployment might introduce new intermediate states — but the
 * unknown status is surfaced via `isKnownSep24Status` so callers can log it
 * explicitly rather than mistaking a foreign terminal state for a pending one.
 *
 * Terminal states (completed, error, refunded, expired, no_market, too_small,
 * too_large) are idempotent — the worker must never overwrite them once set.
 */
export function mapAnchorStatus(raw: string): string {
  const normalized = raw ? raw.trim().toLowerCase() : "";
  switch (normalized) {
    // ── Terminal (success) ──
    case "completed":
      return "completed";

    // ── Terminal (failure) ──
    case "error":
    case "expired":
    case "no_market":
    case "too_small":
    case "too_large":
      return "error";

    case "refunded":
      return "refunded";

    // ── Intermediate (requires user action) ──
    case "pending_user_transfer_start":
      return "pending_user_transfer_start";

    // ── Intermediate (anchor / stellar / user actions) ──
    case "pending_user":
    case "pending_transaction_info_update":
    case "pending_receiver":
    case "pending_sender":
    case "pending_stellar":
    case "pending_trust":
    case "pending_anchor":
      return "pending_anchor";

    // ── Initial ──
    case "incomplete":
      return "incomplete";

    // ── Unknown → safe default ──
    default:
      log.warn(
        { rawStatus: raw, mappedStatus: "pending_anchor" },
        `Unknown SEP-24 status received: ${raw} — mapping to pending_anchor`
      );
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