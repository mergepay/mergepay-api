/**
 * SEP-24 transaction status views (#651).
 *
 * The stored anchor session and the SEP-24 wire shape are two different things,
 * and conflating them is what made status tracking unreliable: `status` is
 * persisted as a plain string, the lifecycle rules live in `sep24-types.ts`,
 * and the human-readable reason an anchor gave for a transition is recorded on
 * the `status_history` row rather than on the session. A client polling for
 * "where is my deposit?" therefore got a bare status code, no message, no
 * timestamps, and a `statusHistory` that was always empty because nothing ever
 * read the rows back.
 *
 * This module is the single place that turns a session plus its history rows
 * into a SEP-24 transaction object, and that decides what an anchor's free-text
 * `message` may contribute to it. It is pure — no database, no Horizon — so the
 * formatting rules can be asserted directly, and both the SEP-24 status route
 * and the anchor-session routes render through it.
 *
 * Field names follow the spec's `GET /transaction` response exactly: the three
 * required fields (`id`, `kind`, `status`) plus the optional ones Mergepay can
 * answer from stored state. Optional fields the API does not track
 * (`status_eta`, `amount_in`, `fee_details`, …) are omitted rather than
 * invented. `session_id` and `status_history` are Mergepay's own additions and
 * are named so they cannot be mistaken for spec fields.
 *
 * Spec: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md#request-transaction
 */
import { safeFailureMessage } from "./job-retry";
import { isTerminalSep24Status, type Sep24TransactionKind } from "./sep24-types";

/**
 * The anchor's own words for a status, ready to record on the `status_history`
 * row a transition writes.
 *
 * `failureReason` on the session is the freshest message, but it is a single
 * column overwritten by every later callback — so the message that explained a
 * transition a user is looking at has usually been replaced by the time they
 * ask. History is append-only, which makes it where each transition's own
 * message belongs.
 *
 * Sanitized rather than stored verbatim: these values are rendered to clients,
 * and an anchor's message is untrusted text that a buggy or hostile deployment
 * can fill with a bearer token or an envelope. The bound matches the session
 * column's, so one message is never truncated in one place and not the other.
 */
export function sanitizeStatusReason(
  message: string | null | undefined
): string | undefined {
  if (!message) return undefined;
  const safe = safeFailureMessage(message, 500);
  return safe.length > 0 ? safe : undefined;
}

/** The session fields a status view needs. Structural, so Prisma rows fit. */
export interface Sep24StatusSession {
  id: string;
  kind: string;
  status: string;
  externalTransactionId: string | null;
  interactiveUrl?: string | null;
  failureReason?: string | null;
  createdAt: Date | string;
  updatedAt?: Date | string | null;
}

/** A `status_history` row as written by src/services/anchor-status.ts. */
export interface Sep24StatusHistoryRow {
  status: string;
  reason?: string | null;
  source?: string | null;
  createdAt: Date | string;
}

/**
 * One transition of Mergepay's own timeline for this transaction. Not a SEP-24
 * field — the spec describes a single `message`, which cannot represent more
 * than the latest status — so it is exposed alongside the spec fields under a
 * name that says so.
 */
export interface Sep24StatusHistoryEntry {
  status: string;
  /** When the session entered `status`, ISO-8601. */
  at: string;
  source: string | null;
  reason: string | null;
}

/**
 * The SEP-24 transaction object for a session, as returned by
 * `GET /api/sep24/transaction`.
 */
export interface Sep24TransactionView {
  /** The anchor's transaction id when known, else Mergepay's own. */
  id: string;
  kind: Sep24TransactionKind;
  status: string;
  /**
   * Mergepay's session id. The spec has no field for it — an anchor is only
   * ever asked about its own id — but a client that also reads
   * `/anchors/sessions` needs the two correlated, and `id` can hold either.
   */
  session_id: string;
  more_info_url?: string;
  started_at: string;
  updated_at?: string;
  /** Only once the transaction has reached a terminal status. */
  completed_at?: string;
  message?: string;
  status_history: Sep24StatusHistoryEntry[];
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Normalize the free-text `kind` column. The API only ever writes the two
 * SEP-24 transfer directions; anything else is reported as a deposit rather
 * than inventing a third kind, because the distinction that matters to a
 * client (funding vs. cashing out) cannot be recovered from a corrupt value.
 */
function toSep24Kind(kind: string): Sep24TransactionKind {
  return kind === "withdrawal" ? "withdrawal" : "deposit";
}

/**
 * Render history oldest-first: a timeline reads as a sequence of states, and
 * `getStatusHistory` returns newest-first for callers that only want the last
 * entry. Rows sharing a timestamp keep the order they were read in, so the
 * sort is stable and the answer is deterministic.
 */
function toHistoryEntries(
  history: readonly Sep24StatusHistoryRow[]
): Sep24StatusHistoryEntry[] {
  return [...history]
    .sort((a, b) => toIso(a.createdAt).localeCompare(toIso(b.createdAt)))
    .map((row) => ({
      status: row.status,
      at: toIso(row.createdAt),
      source: row.source ?? null,
      reason: row.reason ?? null,
    }));
}

/**
 * Build the SEP-24 transaction view of a session.
 *
 * `history` is whatever the caller read from `status_history` for this session
 * (see src/services/status-history.ts); passing none yields an empty timeline
 * rather than a fabricated one.
 *
 * `message` is the freshest thing the anchor said about this session:
 * `failureReason` is rewritten on every callback and poll — including a
 * re-delivery of the status the session already has, which records no history
 * row — so it is the only field that can still be current. The per-transition
 * messages are not lost; they are each entry's `reason` in `status_history`.
 */
export function toSep24TransactionView(
  session: Sep24StatusSession,
  history: readonly Sep24StatusHistoryRow[] = []
): Sep24TransactionView {
  const entries = toHistoryEntries(history);
  const newest = entries[entries.length - 1];
  const message = sanitizeStatusReason(
    session.failureReason ?? newest?.reason ?? null
  );

  const view: Sep24TransactionView = {
    id: session.externalTransactionId ?? session.id,
    kind: toSep24Kind(session.kind),
    status: session.status,
    session_id: session.id,
    started_at: toIso(session.createdAt),
    status_history: entries,
  };

  if (session.interactiveUrl) view.more_info_url = session.interactiveUrl;
  if (session.updatedAt) view.updated_at = toIso(session.updatedAt);
  // The session row has no completion column; the transition into a terminal
  // status is when it completed, and that is exactly what history records.
  if (isTerminalSep24Status(session.status) && newest) {
    view.completed_at = newest.at;
  }
  if (message) view.message = message;

  return view;
}
