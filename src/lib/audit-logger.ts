/**
 * Structured audit-event logger — dedicated Pino output for state changes.
 *
 * Every significant state transition (group creation, membership changes,
 * expense and settlement mutations, treasury actions) is mirrored here as one
 * structured JSON line with a standardized schema:
 *
 *   {
 *     "level": 30,
 *     "time": 1735689600000,           // epoch ms, emitted by Pino
 *     "event": "audit",
 *     "timestamp": "2026-01-01T00:00:00.000Z",
 *     "actor": { "type": "user", "id": "user_1" },
 *     "action": "group.create",
 *     "target": { "type": "group", "id": "group_1" },
 *     "groupId": "group_1",            // null when not group-scoped
 *     "outcome": "success",            // success | failure
 *     "metadata": { ... }              // sanitized — see AUDIT_REDACTED_KEYS
 *   }
 *
 * The schema is deliberately flat and stable so log-based alerting can filter
 * on `event = "audit"`, aggregate on `action`, and attribute on `actor.id`
 * without parsing free-form payloads.
 *
 * Sensitive information (private keys, bearer tokens, signed XDRs, session
 * material) is never logged: caller metadata passes through `sanitize` and
 * any key in `AUDIT_REDACTED_KEYS` is replaced with "[REDACTED]" rather than
 * dropped, so the shape of a payload is still visible during incident review.
 *
 * Emission is strictly best-effort — a logging failure must never fail (or
 * roll back) the operation the event documents.
 */
import pino from "pino";
import { createLogger } from "./logger";

/** The event discriminator present on every audit line. */
export const AUDIT_EVENT_NAME = "audit";

/**
 * Keys that never appear verbatim in audit output. Matching is
 * case-insensitive against the exact key name. Values are replaced, not
 * dropped, so reviewers can still see that a field existed.
 */
export const AUDIT_REDACTED_KEYS = new Set([
  "privatekey",
  "secretkey",
  "seed",
  "mnemonic",
  "signedxdr",
  "transactionxdr",
  "xdr",
  "token",
  "accesstoken",
  "refreshtoken",
  "sessiontoken",
  "idtoken",
  "jwt",
  "authorization",
  "cookie",
  "password",
  "secret",
  "clientsecret",
  "apikey",
  "credentials",
  "credential",
]);

/** Placeholder written in place of any redacted value. */
export const AUDIT_REDACTED = "[REDACTED]";

/**
 * Strip or redact sensitive fields from arbitrary caller-supplied metadata.
 * Recurses into plain objects and arrays; other value types (Date, Map,
 * class instances, primitives) pass through untouched so callers can attach
 * timestamps and ids without them being mangled.
 */
export function sanitizeAuditMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeAuditMetadata);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (AUDIT_REDACTED_KEYS.has(key.toLowerCase())) {
        return [key, AUDIT_REDACTED];
      }
      return [key, sanitizeAuditMetadata(item)];
    })
  );
}

/** True for plain object literals (and Object.create(null)) only. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Who performed the audited action. */
export interface AuditActor {
  /** "user" for authenticated callers; "worker" | "system" for automation. */
  type: "user" | "worker" | "system";
  /** Authenticated user id when `type` is "user", otherwise omitted. */
  id?: string | null;
}

/** The resource the action acted upon. */
export interface AuditTarget {
  /** e.g. "group", "group_member", "expense", "settlement", "treasury_transaction". */
  type: string;
  /** The target row's id. */
  id: string;
}

/** Input accepted by {@link emitAuditEvent}. */
export interface AuditEventInput {
  action: string;
  actorType?: "user" | "worker" | "system";
  /** Authenticated user id, when the actor is a user. */
  userId?: string | null;
  /** Public Stellar key of the actor — safe; private key material is not accepted. */
  actorPublicKey?: string | null;
  groupId?: string | null;
  entityType: string;
  entityId: string;
  outcome?: "success" | "failure";
  /** Safe structured detail only — never private keys, tokens, or signed XDRs. */
  metadata?: Record<string, unknown>;
  /** Correlation id linking the event to the request or worker job that caused it. */
  correlationId?: string | null;
}

/** Internal logger. Created lazily so tests can replace the destination. */
let auditEventLogger: pino.Logger | null = null;

function getLogger(): pino.Logger {
  if (!auditEventLogger) {
    auditEventLogger = createLogger({ name: "audit-event", level: "info" });
  }
  return auditEventLogger;
}

/**
 * Point the audit-event logger at a specific Pino instance. Intended for
 * tests (an in-memory stream) and for hosts that want to route audit lines
 * into their own transport; production code never needs to call this.
 */
export function setAuditEventLogger(logger: pino.Logger | null): void {
  auditEventLogger = logger;
}

/**
 * Emit one structured audit line. Best-effort: never throws, so callers can
 * fire it inside request paths, transactions, and worker jobs alike.
 */
export function emitAuditEvent(input: AuditEventInput): void {
  try {
    const actorType = input.actorType ?? (input.userId ? "user" : "system");
    const actor: AuditActor = {
      type: actorType,
      ...(input.userId ? { id: input.userId } : {}),
    };

    // The durable writer records outcome only when the caller supplies one, so
    // "success" stays implicit there. For the operator-facing stream, though,
    // every line carries an explicit outcome — defaulting to "success" for
    // normal transitions and to "failure" for actions that are failures by
    // name (e.g. "settlement.confirm.validation_failed"), so an alert on
    // `outcome = "failure"` never misses an explicitly-unmarked failure event.
    const failureByActionName = input.action.endsWith(".failed") || input.action.endsWith("_failed") || input.action.includes("validation_failed");
    const outcome = input.outcome ?? (failureByActionName ? "failure" : "success");

    getLogger().info(
      {
        event: AUDIT_EVENT_NAME,
        timestamp: new Date().toISOString(),
        actor,
        action: input.action,
        target: { type: input.entityType, id: input.entityId },
        groupId: input.groupId ?? null,
        outcome,
        ...(input.actorPublicKey ? { actorPublicKey: input.actorPublicKey } : {}),
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
        metadata: sanitizeAuditMetadata(input.metadata ?? {}),
      } as Record<string, unknown>,
      AUDIT_EVENT_NAME
    );
  } catch {
    // Audit telemetry never breaks the audited operation.
  }
}
