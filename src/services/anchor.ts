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
import { AppError } from "../errors";
import {
  ProviderError,
  type ProviderFailureCategory,
} from "../lib/provider-error";
import { fetchWithTimeout, toProviderError } from "./timeout";
import { anchorCircuit } from "./anchor-circuit";
import { safeFailureMessage } from "./job-retry";
import { isSep24TransactionStatus } from "./sep24-types";
import {
  AnchorError,
  AnchorNetworkError,
  AnchorTimeoutError,
  AnchorUnavailableError,
  AnchorUpstreamError,
  AnchorValidationError,
  anchorErrorForStatus,
} from "./anchor-errors";
import {
  parseSep24TransactionResponse,
  resolveSep24Status,
  type Sep24AnchorTransaction,
} from "./anchor-schemas";
import {
  classifyUpstreamFailure,
  logRetryAttempt,
  upstreamCauseOf,
  withRetry,
} from "./retry";

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
  /**
   * Normalized provider failure category for a failed poll — lets the worker
   * distinguish transient outages from permanent rejections without parsing
   * message text. Undefined on success.
   */
  category?: ProviderFailureCategory;
  /**
   * Whether a failed poll can ever succeed on retry. "permanent" covers
   * provider rejections and malformed responses; "transient" covers timeouts,
   * transport failures, and server/rate-limit outages. Undefined on success.
   */
  errorCategory?: "permanent" | "transient";
  /** Anchor-provided transaction JSON for debugging (sanitized). */
  transaction?: Record<string, unknown>;
  /** SEP-24 amount_in / amount_out / amount_fee if available. */
  amountIn?: string;
  amountOut?: string;
  amountFee?: string;
  /** SEP-24 stellar_transaction_hash if available. */
  stellarTransactionHash?: string;
  /**
   * False when the anchor returned a status string outside the known SEP-24
   * set. `status` is then only a display placeholder ("pending_anchor") and
   * must not be persisted — see `resolveSep24Status`. Undefined on failed
   * polls.
   */
  recognized?: boolean;
  /** The typed error behind a failed poll. Undefined on success. */
  error?: AnchorError;
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

// The SEP-24 `GET /transaction` schema lives in ./anchor-schemas.

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

const PROVIDER = "anchor";

/** Classify a non-OK anchor HTTP status into a provider failure category. */
function httpFailureCategory(status: number): ProviderFailureCategory {
  if (status === 429) return "rate_limited";
  if (status >= 500) return "unavailable";
  return "rejected";
}

/**
 * Convert whatever `fetchReadWithRetry` threw into a typed anchor error. The
 * retry wrapper maps every failure onto a generic upstream error, so the
 * originating failure is read back off its preserved cause.
 */
function toAnchorError(err: unknown, operation: string): AnchorError {
  if (err instanceof AnchorError) return err;
  const cause = upstreamCauseOf(err) ?? err;
  if (cause instanceof AnchorHttpError) return anchorErrorForStatus(operation, cause.status);

  const kind = classifyUpstreamFailure(cause);
  if (kind === "timeout") return new AnchorTimeoutError(operation);
  if (kind === "transport") return new AnchorNetworkError(operation);
  return new AnchorUpstreamError(operation, null);
}

/**
 * Read and validate a `GET /transaction` body. The anchor must answer with the
 * transaction that was asked for; a different id means the response cannot be
 * attributed to the session being polled.
 */
async function readSep24Transaction(
  operation: string,
  requestedId: string,
  res: Response
): Promise<Sep24AnchorTransaction> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new AnchorValidationError(operation, "invalid_json");
  }

  const parsed = parseSep24TransactionResponse(body);
  if (!parsed.success) {
    throw new AnchorValidationError(operation, "schema", parsed.fields);
  }
  if (parsed.droppedFields.length > 0) {
    retryLog.warn(
      { operation, transactionId: requestedId, droppedFields: parsed.droppedFields },
      "SEP-24 transaction had invalid optional fields; they were ignored"
    );
  }
  if (parsed.transaction.id !== requestedId) {
    throw new AnchorValidationError(operation, "id_mismatch", ["transaction.id"]);
  }
  return parsed.transaction;
}

/**
 * The one place `GET /transaction` is called. Throws a typed `AnchorError`
 * for every failure; the public methods decide how to surface it.
 *
 * A read, so transient failures (timeout, transport, 5xx except 501/505) are
 * retried inside `fetchReadWithRetry`, each attempt bounded by `timeoutMs`.
 * The circuit breaker counts one failure per exhausted attempt budget, or per
 * unusable response — never one per attempt.
 */
async function fetchSep24Transaction(
  operation: string,
  params: { transferServer: string; token: string; id: string; timeoutMs?: number }
): Promise<Sep24AnchorTransaction> {
  const provider = `tx:${params.transferServer}`;
  if (anchorCircuit.isOpen(provider)) throw new AnchorUnavailableError(operation);

  const url = `${params.transferServer}/transaction?id=${encodeURIComponent(params.id)}`;
  let res: Response;
  try {
    res = await fetchReadWithRetry(url, operation, params.timeoutMs ?? config.ANCHOR_POLL_TIMEOUT_MS, {
      headers: { Authorization: `Bearer ${params.token}` },
    });
  } catch (err: unknown) {
    anchorCircuit.recordFailure(provider);
    throw toAnchorError(err, operation);
  }

  try {
    const transaction = await readSep24Transaction(operation, params.id, res);
    anchorCircuit.recordSuccess(provider);
    return transaction;
  } catch (err: unknown) {
    anchorCircuit.recordFailure(provider);
    throw err;
  }
}

/** The worker-facing message for a failed poll. Never includes anchor body text. */
function pollFailureMessage(err: AnchorError): string {
  if (err instanceof AnchorUnavailableError) return "Anchor circuit is open";
  if (err instanceof AnchorValidationError) {
    if (err.reason === "invalid_json") return "Anchor returned malformed (non-JSON) response";
    const detail =
      err.reason === "id_mismatch"
        ? "transaction id does not match the request"
        : err.fields.includes("transaction.status")
          ? "missing transaction status"
          : err.fields.some((field) => field === "transaction" || field === "(root)")
            ? "missing 'transaction'"
            : `invalid fields (${err.fields.join(", ")})`;
    return `Anchor returned invalid or malformed response: ${detail}`;
  }
  if (err.httpStatus !== null) return `Anchor returned HTTP ${err.httpStatus}`;
  return `Anchor poll failed: ${err.message}`;
}

function pollFailure(err: AnchorError): PollResult {
  return {
    rawStatus: null,
    status: "pending_anchor",
    message: pollFailureMessage(err),
    isError: true,
    category: err.category,
    errorCategory: errorCategoryOf(err.category),
    error: err,
  };
}

/** Whether a provider category is a permanent rejection vs a transient outage. */
function errorCategoryOf(
  category: ProviderFailureCategory
): "permanent" | "transient" {
  return category === "rejected" || category === "malformed" ? "permanent" : "transient";
}

/**
 * fetchWithTimeout with its typed failures converted to ProviderError.
 * The original error never escapes — timeout/transport details stay in the
 * category, not in client-visible text.
 */
async function fetchAnchor(
  operation: string,
  url: string,
  timeoutMs: number,
  init?: RequestInit
): Promise<Response> {
  try {
    return await fetchWithTimeout(url, operation, timeoutMs, init);
  } catch (err) {
    throw toProviderError(err, {
      provider: PROVIDER,
      operation,
      fallbackMessage: `Anchor request failed (${operation})`,
    });
  }
}

/** Parse an anchor response body as JSON, mapping non-JSON to malformed. */
async function readAnchorJson(operation: string, res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new ProviderError({
      category: "malformed",
      provider: PROVIDER,
      operation,
      message: "Anchor returned a malformed (non-JSON) response",
    });
  }
}

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
      throw new ProviderError({
        category: "unavailable",
        provider: PROVIDER,
        operation: "Anchor.getToml",
        message: `Circuit open for anchor ${homeDomain}`,
      });
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
    } catch (err) {
      anchorCircuit.recordFailure(provider);
      if (err instanceof AppError) throw err;
      throw new ProviderError({
        category: "malformed",
        provider: PROVIDER,
        operation: "Anchor.getToml",
        message: "Anchor returned invalid stellar.toml",
      });
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
      throw new ProviderError({
        category: "malformed",
        provider: PROVIDER,
        operation: "Anchor.getToml",
        message: "Anchor stellar.toml is missing required SEP-24 fields",
      });
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
    const operation = "Anchor.getChallenge";
    const url = `${webAuthEndpoint}?account=${encodeURIComponent(account)}`;
    let res: Response;
    try {
      // A single attempt, not the bounded retry wrapper: the challenge is
      // issued fresh per request and an abandoned one expires unused, so the
      // timeout/transport error is converted straight into a typed
      // ProviderError (never leaking the endpoint URL).
      res = await fetchWithTimeout(url, operation, config.ANCHOR_CHALLENGE_TIMEOUT_MS);
    } catch (err) {
      throw toProviderError(err, {
        provider: PROVIDER,
        operation,
        fallbackMessage: "Anchor SEP-10 challenge request failed",
      });
    }
    if (!res.ok) {
      throw new ProviderError({
        category: httpFailureCategory(res.status),
        provider: PROVIDER,
        operation,
        message: "Anchor SEP-10 challenge request failed",
      });
    }
    const data = parseJson(operation, challengeResponseSchema, await readAnchorJson(operation, res));
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
    const operation = "Anchor.getToken";
    const res = await fetchAnchor(operation, webAuthEndpoint, config.ANCHOR_TOKEN_TIMEOUT_MS, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transaction: signedXdr }),
    });
    if (!res.ok) {
      throw new ProviderError({
        category: httpFailureCategory(res.status),
        provider: PROVIDER,
        operation,
        message: "Anchor SEP-10 token exchange failed",
      });
    }
    return parseJson(operation, tokenResponseSchema, await readAnchorJson(operation, res)).token;
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
    const operation = "Anchor.startInteractive";
    const path = params.kind === "deposit" ? "deposit" : "withdraw";
    const url = `${params.transferServer}/transactions/${path}/interactive`;
    const res = await fetchAnchor(operation, url, config.ANCHOR_INTERACTIVE_TIMEOUT_MS, {
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
    if (!res.ok) {
      throw new ProviderError({
        category: httpFailureCategory(res.status),
        provider: PROVIDER,
        operation,
        message: "Anchor interactive flow request failed",
      });
    }
    return parseJson(operation, interactiveResponseSchema, await readAnchorJson(operation, res));
  },

  /**
   * Fetch one SEP-24 transaction (`GET /transaction?id=`) as a validated,
   * typed object.
   *
   * This is the typed entry point for status tracking: it throws an
   * `AnchorError` subclass for every failure — `AnchorTimeoutError`,
   * `AnchorNetworkError`, `AnchorAuthError` (401/403, usually an expired
   * SEP-10 token), `AnchorNotFoundError` (404), `AnchorUpstreamError` (other
   * non-OK statuses), `AnchorValidationError` (non-JSON body, schema
   * mismatch, or a different transaction id), and `AnchorUnavailableError`
   * (circuit open). `status` on the result is the anchor's raw string; pass
   * it through `resolveSep24Status` before acting on it.
   */
  async getTransaction(params: {
    transferServer: string;
    token: string;
    id: string;
    timeoutMs?: number;
  }): Promise<Sep24AnchorTransaction> {
    return fetchSep24Transaction("Anchor.getTransaction", params);
  },

  /**
   * Poll a single SEP-24 transaction's status.
   *
   * Returns the anchor's normalized (trimmed, lower-cased) status string, or
   * null for any failure. Callers that need to know *why* a read failed use
   * `getTransaction` instead.
   */
  async getTransactionStatus(params: {
    transferServer: string;
    token: string;
    id: string;
  }): Promise<string | null> {
    try {
      const transaction = await fetchSep24Transaction("Anchor.getTransactionStatus", params);
      return transaction.status;
    } catch (err: unknown) {
      if (err instanceof AnchorError) return null;
      throw err;
    }
  },

  /**
   * Full SEP-24 poll returning a normalized `PollResult` instead of throwing.
   *
   * This is the method the worker calls. A failure becomes a result with
   * `isError`, its provider `category`, whether it is `permanent` or
   * `transient`, and the typed `error` itself. Transient failures have
   * already been retried inside the call, so the worker's own retry schedule
   * governs genuinely unavailable anchors rather than momentary blips.
   *
   * An unrecognized status is not an error: the result carries
   * `recognized: false` and the worker keeps the session's current state.
   */
  async pollTransaction(params: {
    transferServer: string;
    token: string;
    id: string;
    timeoutMs?: number;
  }): Promise<PollResult> {
    let tx: Sep24AnchorTransaction;
    try {
      tx = await fetchSep24Transaction("Anchor.pollTransaction", params);
    } catch (err: unknown) {
      if (err instanceof AnchorError) return pollFailure(err);
      throw err;
    }

    const resolved = resolveSep24Status(tx.status);
    const mappedStatus = resolved.recognized ? resolved.status : "pending_anchor";
    const anchorMessage = tx.message ? safeFailureMessage(tx.message) : undefined;

    // Sanitise — only carry forward benign fields for debugging.
    const sanitizedTx: Record<string, unknown> = {
      id: tx.id,
      status: tx.status,
      kind: tx.kind,
      amount_in: tx.amount_in ?? undefined,
      amount_out: tx.amount_out ?? undefined,
      amount_fee: tx.amount_fee ?? undefined,
      started_at: tx.started_at ?? undefined,
      completed_at: tx.completed_at ?? undefined,
      stellar_transaction_id: tx.stellar_transaction_id ?? undefined,
      external_transaction_id: tx.external_transaction_id ?? undefined,
      message: anchorMessage,
      refunds: tx.refunds ?? undefined,
    };

    if (!resolved.recognized) {
      retryLog.warn(
        { rawStatus: tx.status, externalTransactionId: params.id, kind: tx.kind },
        `SEP-24 transaction reported an unknown status: ${tx.status} — keeping the current state and will keep polling`
      );
    }

    return {
      rawStatus: tx.status,
      status: mappedStatus,
      message:
        mappedStatus === "error" && anchorMessage
          ? anchorMessage
          : `SEP-24 status: ${tx.status} → ${mappedStatus}`,
      isError: false,
      recognized: resolved.recognized,
      transaction: sanitizedTx,
      amountIn: tx.amount_in ?? undefined,
      amountOut: tx.amount_out ?? undefined,
      amountFee: tx.amount_fee ?? undefined,
      stellarTransactionHash: tx.stellar_transaction_id ?? undefined,
    };
  },
};

// ─── Status mapping ─────────────────────────────────────────────────────────

/**
 * The exhaustive set of SEP-24 transaction statuses (lowercased) that we
 * understand and map explicitly. Re-exported from ./sep24-types — the single
 * source of truth shared with the anchor-session state machine and both
 * callback handlers — so it can no longer drift from the type union.
 *
 * See: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md#transaction-history
 */
export {
  KNOWN_SEP24_STATUSES,
  isSep24TransactionStatus as isKnownSep24Status,
} from "./sep24-types";

/**
 * Map a raw SEP-24 status string to Mergepay's internal status.
 *
 * Every status in the canonical union maps to itself. An unrecognised status
 * (including the deprecated `pending_external` /
 * `pending_user_transfer_complete`, which `isRecognisedSep24Status` still
 * accepts) is mapped to "pending_anchor" — a safe intermediate — instead of
 * erroring out, because a future anchor deployment might introduce new
 * intermediate states. `isKnownSep24Status` lets callers tell a genuine
 * pending state from a foreign one.
 *
 * Terminal states (completed, error, refunded, expired, no_market, too_small,
 * too_large) are idempotent — the worker must never overwrite them once set.
 */
export function mapAnchorStatus(raw: string): string {
  const normalized = raw ? raw.trim().toLowerCase() : "";

  if (isSep24TransactionStatus(normalized)) return normalized;

  retryLog.warn(
    { rawStatus: raw, mappedStatus: "pending_anchor" },
    `Unknown SEP-24 status received: ${raw} — mapping to pending_anchor`
  );
  return "pending_anchor";
}

/** Whether a normalized status is terminal and no longer needs polling. */
export function isTerminalAnchorStatus(status: string): boolean {
  return status === "completed" || status === "error" || status === "refunded";
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function parseJson<T>(operation: string, schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ProviderError({
      category: "malformed",
      provider: PROVIDER,
      operation,
      message: "Anchor returned an unexpected response format",
    });
  }
  return result.data;
}