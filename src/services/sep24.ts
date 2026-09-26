/**
 * SEP-24 anchor callback verification and state application.
 *
 * Anchors report deposit and withdrawal progress asynchronously: instead of
 * Mergepay polling `GET /transaction` on every session, the anchor POSTs a
 * status update whenever a transfer moves. Those callbacks arrive from the
 * public internet with no session and no bearer token, so the only thing that
 * distinguishes a real anchor from an attacker is an HMAC-SHA256 signature
 * computed over the *exact bytes* the anchor sent.
 *
 * ## Why the raw body matters
 *
 * The signature covers the serialized payload, not the parsed object. Once
 * Fastify has parsed JSON, key order, whitespace, and numeric formatting are
 * all lost, and re-serializing produces different bytes than the anchor
 * signed — every signature would fail. The route therefore buffers the raw
 * body (see `src/routes/webhooks.ts`) and hands it here untouched.
 *
 * ## Verification rules
 *
 *  - The signature header is parsed leniently (`sha256=<hex>` or bare hex) but
 *    compared strictly, in constant time, against an HMAC of the raw body
 *    keyed by the configured per-anchor secret.
 *  - A missing, malformed, or non-matching signature is rejected *before* the
 *    body is parsed or any database work happens. Nothing about which check
 *    failed is returned to the caller.
 *  - A timestamp header, when the anchor sends one, bounds replay: a signature
 *    is only accepted inside `SEP24_WEBHOOK_TOLERANCE_MS` of now. Anchors that
 *    do not send one are unaffected.
 *
 * ## State application
 *
 * Applying the update is delegated to `applyAnchorSessionTransition`, which
 * validates the transition against the finite state map and writes its audit
 * record inside the same database transaction as the status change. That makes
 * duplicate and out-of-order deliveries no-ops rather than regressions, which
 * matters because anchors retry aggressively and give no ordering guarantee.
 */
import crypto from "node:crypto";
import { z } from "zod";
import { config } from "../config";
import { prisma } from "../db";
import { audit } from "./audit";
import { mapAnchorStatus } from "./anchor";
import { applyAnchorSessionTransition } from "./anchor-status";

/** Header carrying the anchor's HMAC-SHA256 signature over the raw body. */
export const SEP24_SIGNATURE_HEADER = "x-sep24-signature";

/**
 * Optional header carrying the signing timestamp (seconds or milliseconds
 * since the epoch). Present, it bounds how long a captured request stays
 * replayable; absent, signature verification alone is the gate.
 */
export const SEP24_TIMESTAMP_HEADER = "x-sep24-timestamp";

/** Signature encodings anchors are known to emit. */
const SIGNATURE_PREFIX = "sha256=";

/**
 * The SEP-24 transaction object, in both shapes anchors send it: wrapped in a
 * `transaction` envelope (the SEP-24 `GET /transaction` response shape, which
 * most anchors reuse for callbacks) or flattened at the top level.
 *
 * `passthrough` is deliberate — anchors add fields freely and an unrecognized
 * one must never reject an otherwise valid callback. Only what Mergepay reads
 * is validated.
 */
const transactionFields = z.object({
  id: z.string().min(1).max(255),
  status: z.string().min(1).max(64),
  kind: z.string().max(64).optional(),
  amount_in: z.string().max(64).nullish(),
  amount_out: z.string().max(64).nullish(),
  amount_fee: z.string().max(64).nullish(),
  stellar_transaction_id: z.string().max(128).nullish(),
  external_transaction_id: z.string().max(255).nullish(),
  message: z.string().max(1024).nullish(),
});

export const sep24CallbackSchema = z
  .object({
    transaction: transactionFields.passthrough().optional(),
    id: z.string().min(1).max(255).optional(),
    status: z.string().min(1).max(64).optional(),
  })
  .passthrough()
  .transform((body, ctx) => {
    const transaction = body.transaction;
    const id = transaction?.id ?? body.id;
    const status = transaction?.status ?? body.status;

    if (!id || !status) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "SEP-24 callback must carry a transaction id and status, either at the top level or under `transaction`",
      });
      return z.NEVER;
    }

    return {
      externalTransactionId: id,
      rawStatus: status,
      message: transaction?.message ?? null,
      stellarTransactionId: transaction?.stellar_transaction_id ?? null,
      amountIn: transaction?.amount_in ?? null,
      amountOut: transaction?.amount_out ?? null,
      amountFee: transaction?.amount_fee ?? null,
    };
  });

export type Sep24Callback = z.infer<typeof sep24CallbackSchema>;

/** Why a callback was rejected. Never returned to the caller — logs only. */
export type Sep24RejectionReason =
  | "missing_signature"
  | "malformed_signature"
  | "invalid_signature"
  | "stale_timestamp";

export interface Sep24VerificationResult {
  valid: boolean;
  reason?: Sep24RejectionReason;
}

function constantTimeEqualHex(a: string, b: string): boolean {
  // timingSafeEqual throws on length mismatch, which would itself leak length
  // through an exception path, so the lengths are compared first and the
  // comparison is skipped rather than attempted.
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/** Normalize `sha256=<hex>` / bare hex to lowercase hex, or null if unusable. */
function normalizeSignature(raw: unknown): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  const hex = trimmed.toLowerCase().startsWith(SIGNATURE_PREFIX)
    ? trimmed.slice(SIGNATURE_PREFIX.length)
    : trimmed;

  // A SHA-256 HMAC is always 64 hex characters. Anything else is malformed
  // input, not a failed comparison, and is rejected without touching the key.
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return hex.toLowerCase();
}

/** Parse a seconds- or milliseconds-precision epoch header. */
function parseTimestamp(raw: unknown): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" && typeof value !== "number") return null;

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;

  // Values below ~1e12 are seconds; anchors differ, and guessing wrong by a
  // factor of 1000 would make every callback look stale.
  return numeric < 1e12 ? numeric * 1000 : numeric;
}

/** Compute the expected signature for a payload. Exported for tests. */
export function signSep24Payload(rawBody: string | Buffer, secret: string): string {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

/**
 * Verify an anchor callback's HMAC-SHA256 signature over the raw request body.
 *
 * The secret is resolved per anchor so a compromised anchor credential cannot
 * be used to forge updates attributed to another.
 */
export function verifySep24Signature(params: {
  rawBody: string | Buffer;
  headers: Record<string, unknown>;
  secret?: string;
  now?: number;
}): Sep24VerificationResult {
  const { rawBody, headers, now = Date.now() } = params;
  const secret = params.secret ?? resolveAnchorSecret();

  const provided = normalizeSignature(headers[SEP24_SIGNATURE_HEADER]);
  if (provided === null) {
    const present = headers[SEP24_SIGNATURE_HEADER] !== undefined;
    return { valid: false, reason: present ? "malformed_signature" : "missing_signature" };
  }

  // Replay bound. Checked before the HMAC so a captured-and-replayed request
  // is rejected on age even though its signature is, by construction, valid.
  const timestamp = parseTimestamp(headers[SEP24_TIMESTAMP_HEADER]);
  if (timestamp !== null) {
    if (Math.abs(now - timestamp) > config.SEP24_WEBHOOK_TOLERANCE_MS) {
      return { valid: false, reason: "stale_timestamp" };
    }
  }

  const expected = signSep24Payload(rawBody, secret);
  if (!constantTimeEqualHex(provided, expected)) {
    return { valid: false, reason: "invalid_signature" };
  }

  return { valid: true };
}

/**
 * The signing secret for an anchor.
 *
 * Secrets live in configuration, never in the database, so rotating one is a
 * deploy rather than a migration. `SEP24_WEBHOOK_SECRETS` holds the per-anchor
 * map (`name:secret,name:secret`); `ANCHOR_WEBHOOK_SECRET` remains the default
 * for single-anchor deployments, which is every deployment today.
 */
export function resolveAnchorSecret(anchorName?: string): string {
  if (anchorName) {
    const perAnchor = anchorWebhookSecrets().get(anchorName);
    if (perAnchor) return perAnchor;
  }
  return config.ANCHOR_WEBHOOK_SECRET;
}

let secretMapCache: Map<string, string> | null = null;

function anchorWebhookSecrets(): Map<string, string> {
  if (secretMapCache) return secretMapCache;

  const map = new Map<string, string>();
  for (const entry of config.SEP24_WEBHOOK_SECRETS.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    // Split on the first separator only: a secret may legitimately contain ':'.
    const separator = trimmed.indexOf(":");
    if (separator <= 0) continue;

    const name = trimmed.slice(0, separator).trim();
    const secret = trimmed.slice(separator + 1).trim();
    if (name && secret) map.set(name, secret);
  }

  secretMapCache = map;
  return map;
}

/** Drop the parsed secret map. Tests mutate config between cases. */
export function resetAnchorSecretCache(): void {
  secretMapCache = null;
}

/**
 * Anchor statuses that mean the transfer will not complete, but which are not
 * themselves values `AnchorSession.status` can hold. SEP-24 defines several
 * distinct terminal failures (`no_market`, `too_small`, `too_large`,
 * `expired`); Mergepay tracks one failure state.
 *
 * Collapsing them here rather than at the session layer matters: an unmapped
 * status reaching `applyAnchorSessionTransition` is coerced to
 * `pending_anchor`, which would leave a dead transfer looking like one still
 * in flight — the exact misreading a status callback exists to prevent. The
 * anchor's own wording is preserved separately in the audit metadata.
 */
const TERMINAL_FAILURE_STATUSES = new Set([
  "error",
  "expired",
  "no_market",
  "too_small",
  "too_large",
]);

/** Normalize a raw anchor status onto the session status vocabulary. */
export function toSessionStatus(rawStatus: string): string {
  const mapped = mapAnchorStatus(rawStatus);
  return TERMINAL_FAILURE_STATUSES.has(mapped) ? "error" : mapped;
}

export interface Sep24ApplyResult {
  /** Sessions matched by the callback's external transaction id. */
  matched: number;
  /** Sessions whose status actually advanced. */
  updated: number;
  /** The normalized Mergepay status the callback mapped to. */
  status: string;
}

/**
 * Apply a verified callback to every anchor session tracking its transaction.
 *
 * Each session transitions through `applyAnchorSessionTransition`, so the
 * finite state map decides whether the update applies and the audit record is
 * written atomically with the status change. A callback for a transaction
 * Mergepay does not track is not an error — anchors legitimately broadcast for
 * sessions started elsewhere — but it is audited so operators can see it.
 */
export async function applySep24Callback(
  callback: Sep24Callback
): Promise<Sep24ApplyResult> {
  const status = toSessionStatus(callback.rawStatus);

  const sessions = await prisma.anchorSession.findMany({
    where: { externalTransactionId: callback.externalTransactionId },
    select: { id: true, status: true },
  });

  if (sessions.length === 0) {
    await audit({
      action: "sep24.webhook.unmatched",
      entityType: "anchor_session",
      entityId: callback.externalTransactionId,
      outcome: "failure",
      metadata: { rawStatus: callback.rawStatus, status },
    });
    return { matched: 0, updated: 0, status };
  }

  let updated = 0;
  for (const session of sessions) {
    const result = await applyAnchorSessionTransition({
      sessionId: session.id,
      nextStatus: status,
      source: "webhook",
      extraData: buildExtraData(callback),
    });
    if (result.changed) updated += 1;
  }

  // The per-session audit rows written inside the transition transaction record
  // *what* changed. This one records that a signed callback was accepted at
  // all, which is the record an operator needs when a status did not move
  // because the transition was disallowed rather than because nothing arrived.
  await audit({
    action: "sep24.webhook.applied",
    entityType: "anchor_session",
    entityId: callback.externalTransactionId,
    metadata: {
      rawStatus: callback.rawStatus,
      status,
      matched: sessions.length,
      updated,
    },
  });

  return { matched: sessions.length, updated, status };
}

/**
 * Callback fields worth persisting alongside the transition. Only fields the
 * schema already carries — never the anchor JWT, and never the raw payload.
 */
function buildExtraData(callback: Sep24Callback) {
  const extra: Record<string, unknown> = {};
  if (callback.message) extra.failureReason = callback.message.slice(0, 500);
  return Object.keys(extra).length > 0 ? extra : undefined;
}
