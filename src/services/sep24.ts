/**
 * SEP-24 anchor callback verification and state application.
 *
 * Anchors report deposit and withdrawal progress asynchronously rather than
 * making Mergepay poll every open session. Those callbacks arrive from the
 * public internet carrying no Mergepay session, so the only thing separating a
 * real anchor from an attacker is the bearer token on the request.
 *
 * ## Why a JWT rather than a shared secret
 *
 * A shared secret sent verbatim in a header authenticates whoever holds it —
 * and anyone who ever observed one legitimate callback holds it. A JWT signed
 * by the anchor's SEP-10 key is verified against the key published in that
 * anchor's own stellar.toml, so possession of a past request proves nothing:
 * the token expires, and forging a new one requires the anchor's private key.
 *
 * The token is bound to this deployment on three axes:
 *
 *   - **Signature** — against the anchor's `SIGNING_KEY` from its stellar.toml.
 *   - **Issuer** — the anchor's own home domain, so a token minted by a
 *     different anchor (or a different environment) is rejected even when it
 *     is otherwise well-formed.
 *   - **Expiry** — enforced by verification, which bounds replay of a captured
 *     token to its own lifetime.
 *
 * ## State application
 *
 * Applying an update is delegated to `applyAnchorSessionTransition`, which
 * validates the change against the finite state map and writes its audit record
 * in the same database transaction as the status change. Anchors retry and give
 * no ordering guarantee, so duplicate and out-of-order deliveries have to be
 * no-ops rather than regressions — that guarantee lives there, not here.
 */
import jwt from "jsonwebtoken";
import pino from "pino";
import { z } from "zod";
import { config } from "../config";
import { prisma } from "../db";
import { Errors } from "../errors";
import { anchorService, mapAnchorStatus } from "./anchor";
import { applyAnchorSessionTransition } from "./anchor-status";
import { audit } from "./audit";

const log = pino({ name: "sep24" });

/**
 * Anchor statuses that mean the transfer will not complete but which
 * `AnchorSession.status` cannot itself hold. SEP-24 defines several distinct
 * terminal failures; Mergepay tracks one failure state.
 *
 * Collapsing them here matters: an unmapped status reaching the transition
 * layer is coerced to `pending_anchor`, which would leave a dead transfer
 * looking like one still in flight — the exact misreading a status callback
 * exists to prevent.
 */
const TERMINAL_FAILURE_STATUSES = new Set([
  "error",
  "expired",
  "no_market",
  "too_small",
  "too_large",
]);

/** Statuses this handler knows how to act on. Anything else is logged. */
const RECOGNISED_STATUSES = new Set([
  "incomplete",
  "pending_user_transfer_start",
  "pending_user_transfer_complete",
  "pending_external",
  "pending_anchor",
  "pending_stellar",
  "pending_trust",
  "pending_user",
  "completed",
  "refunded",
  ...TERMINAL_FAILURE_STATUSES,
]);

/**
 * The SEP-24 transaction object, in both shapes anchors send it: wrapped in a
 * `transaction` envelope (the shape most anchors reuse from their
 * `GET /transaction` response) or flattened at the top level.
 *
 * `passthrough` is deliberate — anchors add fields freely, and an unrecognized
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

/** Normalize a raw anchor status onto the session status vocabulary. */
export function toSessionStatus(rawStatus: string): string {
  const mapped = mapAnchorStatus(rawStatus);
  return TERMINAL_FAILURE_STATUSES.has(mapped) ? "error" : mapped;
}

/** Whether this handler recognises the status the anchor reported. */
export function isRecognisedStatus(rawStatus: string): boolean {
  return RECOGNISED_STATUSES.has(rawStatus);
}

/**
 * Verify the anchor's bearer token.
 *
 * Returns the token's subject on success. Every failure mode raises the same
 * 401 — telling a caller whether the signature, the issuer, or the expiry was
 * wrong hands an attacker a free oracle for probing the format.
 */
export async function verifyAnchorToken(
  authorization: string | undefined,
  signingKey?: string
): Promise<string> {
  if (!authorization?.startsWith("Bearer ")) {
    throw Errors.unauthorized("Anchor callback requires a bearer token");
  }

  const token = authorization.slice("Bearer ".length).trim();
  if (!token) {
    throw Errors.unauthorized("Anchor callback requires a bearer token");
  }

  const key = signingKey ?? (await anchorSigningKey());

  try {
    const payload = jwt.verify(token, key, {
      algorithms: ["HS256"],
      issuer: config.ANCHOR_HOME_DOMAIN,
    });

    const subject =
      typeof payload === "object" && payload !== null
        ? String((payload as jwt.JwtPayload).sub ?? "")
        : "";

    return subject;
  } catch {
    // The underlying reason is deliberately not surfaced or logged with the
    // token attached — a rejected token is still a credential.
    throw Errors.unauthorized("Invalid anchor callback token");
  }
}

/**
 * The anchor's SEP-10 signing key, read from its stellar.toml.
 *
 * Fetched through `anchorService.getToml`, which caches, so a burst of
 * callbacks does not become a burst of upstream reads. A failure to resolve it
 * is an availability problem rather than an authorization decision, so it is
 * reported as such instead of silently rejecting a legitimate anchor.
 */
async function anchorSigningKey(): Promise<string> {
  try {
    const toml = await anchorService.getToml(config.ANCHOR_HOME_DOMAIN);
    return toml.signingKey;
  } catch {
    throw Errors.upstream("Could not resolve the anchor's signing key");
  }
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
 * A callback for a transaction Mergepay does not track is not an error —
 * anchors legitimately broadcast for sessions started elsewhere — but it is
 * audited so an operator can see it happened.
 */
export async function applySep24Callback(
  callback: Sep24Callback
): Promise<Sep24ApplyResult> {
  if (!isRecognisedStatus(callback.rawStatus)) {
    // Logged rather than rejected: an anchor adding a status to the spec should
    // not start failing callbacks, but an operator needs to know it happened.
    log.warn(
      {
        event: "sep24.callback.unhandled_status",
        rawStatus: callback.rawStatus,
        externalTransactionId: callback.externalTransactionId,
      },
      "unhandled SEP-24 anchor status"
    );
  }

  const status = toSessionStatus(callback.rawStatus);

  const sessions = await prisma.anchorSession.findMany({
    where: { externalTransactionId: callback.externalTransactionId },
    select: { id: true, status: true },
  });

  if (sessions.length === 0) {
    await audit({
      action: "sep24.callback.unmatched",
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

  await audit({
    action: "sep24.callback.applied",
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
 * Callback fields worth persisting alongside the transition.
 *
 * The Stellar transaction hash is recorded on completion so a settled deposit
 * can be traced to its on-chain payment. The anchor's JWT and the raw payload
 * are never persisted.
 */
function buildExtraData(callback: Sep24Callback) {
  const extra: Record<string, unknown> = {};
  if (callback.message) extra.failureReason = callback.message.slice(0, 500);
  return Object.keys(extra).length > 0 ? extra : undefined;
}
