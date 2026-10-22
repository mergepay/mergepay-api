/**
 * Transaction memo helpers for on-chain expense settlements.
 *
 * Mergepay stamps every outgoing payment with a Stellar `MEMO_TEXT` of the
 * form `MP:<code>` so a ledger transaction can be reconciled back to a
 * database record. This module is the single home for that convention:
 *
 *  - `buildMemo` / `buildMemoOrThrow` / `generateMemo` **generate** a memo
 *    from a code, rejecting anything that would not survive Stellar's
 *    28-byte `MEMO_TEXT` limit or fail to parse again — no silent truncation;
 *  - `parseMemo` (re-exported from `src/lib/memo.ts`) **parses** a raw memo
 *    back into its code;
 *  - `validateMemoAgainstActiveExpense` resolves a parsed memo code against an
 *    active expense record. The settlement verification worker runs it before
 *    it is allowed to confirm a settlement, so a payment can never be marked
 *    complete while the expense it pays off is missing or already settled.
 *
 * Error handling follows the `src/lib/money.ts` / `src/lib/memo.ts`
 * convention: the parsing and validation entry points return a discriminated
 * result instead of throwing. Only the `*OrThrow` / `generate*` helpers
 * throw, and they throw on inputs that were built by this module's callers.
 */
import { prisma } from "../db";
import {
  MAX_MEMO_BYTES,
  MP_PREFIX,
  isValidMemoCode,
  parseMemo,
  type MemoParseResult,
} from "../lib/memo";
import { shortCode } from "./codes";

export { MAX_MEMO_BYTES, MP_PREFIX, isValidMemoCode, parseMemo };
export type { MemoParseResult };

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** A memo built from a code, or the reason the code cannot become a memo. */
export type MemoBuildResult =
  | { ok: true; memo: string; code: string }
  | { ok: false; message: string };

/**
 * Build an `MP:<code>` memo, validating the code instead of truncating it.
 *
 * The result mirrors `parseMemo`: callers inspect `ok` and read `message` on
 * failure. A code is rejected when it is not a string, is empty, contains
 * characters outside the approved short-code alphabet (uppercase A-Z minus
 * I/O, plus 2-9), or would push the memo past Stellar's 28-byte limit.
 *
 * ```ts
 * buildMemo("ABC123"); // => { ok: true, memo: "MP:ABC123", code: "ABC123" }
 * buildMemo("abc");    // => { ok: false, message: "Memo code contains invalid..." }
 * ```
 *
 * Guaranteed round trip: `parseMemo(buildMemo(c).memo)` returns `c`.
 */
export function buildMemo(code: string): MemoBuildResult {
  if (typeof code !== "string") {
    return { ok: false, message: "Memo code must be a string." };
  }
  if (code.length === 0) {
    return { ok: false, message: "Memo code must not be empty." };
  }
  if (!isValidMemoCode(code)) {
    return {
      ok: false,
      message:
        "Memo code contains invalid characters. Only uppercase A-Z (excluding I, O) and 2-9 are allowed.",
    };
  }

  const memo = `${MP_PREFIX}${code}`;
  if (Buffer.byteLength(memo, "utf8") > MAX_MEMO_BYTES) {
    return {
      ok: false,
      message: `Memo must be ${MAX_MEMO_BYTES} UTF-8 bytes or fewer to fit in a Stellar MEMO_TEXT.`,
    };
  }

  return { ok: true, memo, code };
}

/**
 * Throwing variant of {@link buildMemo} for call sites where an invalid code
 * is a programming error (the code came from `shortCode()`, the database, or
 * another already-validated source).
 */
export function buildMemoOrThrow(code: string): string {
  const built = buildMemo(code);
  if (!built.ok) throw new Error(built.message);
  return built.memo;
}

/**
 * Generate a fresh `MP:<code>` memo — with an explicit `code`, or with a new
 * 10-character settlement short code when `code` is omitted.
 *
 * Throws only when the caller passes an invalid explicit code.
 */
export function generateMemo(code?: string): string {
  return buildMemoOrThrow(code ?? shortCode());
}

// ---------------------------------------------------------------------------
// Validation against expense records (settlement verification worker)
// ---------------------------------------------------------------------------

/** Why a memo could not be resolved to an active expense record. */
export type MemoExpenseFailureReason =
  | "invalid_memo"
  | "code_mismatch"
  | "expense_not_found"
  | "expense_settled";

export interface MemoExpenseValidationOk {
  ok: true;
  /** The code parsed out of the memo. */
  code: string;
  /** The original memo string. */
  memo: string;
  /** The active expense record the code resolved to. */
  expenseId: string;
}

export interface MemoExpenseValidationErr {
  ok: false;
  reason: MemoExpenseFailureReason;
  /** Present whenever the memo itself parsed but resolution failed. */
  code?: string;
  /** Human-readable reason, safe to record as a verification failure. */
  message: string;
}

export type MemoExpenseValidation = MemoExpenseValidationOk | MemoExpenseValidationErr;

export interface MemoExpenseValidationOptions {
  /**
   * Expense to resolve through when known (the settlement's own link). The
   * on-chain memo carries the *settlement's* code, not the expense's memo, so
   * a linked settlement is validated through this id rather than by matching
   * `expense.memo`.
   */
  expenseId?: string | null;
  /**
   * Code the memo must carry (e.g. the settlement short code). When omitted,
   * any code that parses is accepted.
   */
  expectedCode?: string;
}

/**
 * Parse a raw `MP:<code>` memo and resolve it to an active expense record.
 *
 * Steps, each returning a typed failure instead of throwing:
 *
 *  1. `parseMemo` — rejects missing prefixes, malformed codes, non-strings,
 *     and memos over Stellar's 28-byte limit (`invalid_memo`);
 *  2. optional `expectedCode` comparison (`code_mismatch`);
 *  3. resolve the record — by `expenseId` when the caller has the link,
 *     otherwise by matching `expense.memo` against the parsed code
 *     (`expense_not_found`);
 *  4. confirm the record is still active, i.e. it has at least one share that
 *     is not `settled` (`expense_settled`).
 *
 * "Active" matters for settlement verification: a payment must not confirm
 * against an expense whose shares are all settled, because that means the
 * debt it pays off is already discharged.
 *
 * Runs from `reconcileSingleSettlement` during settlement verification worker
 * cycles (see `src/worker/index.ts` → `reconcilePendingSettlements`).
 */
export async function validateMemoAgainstActiveExpense(
  memo: string,
  opts: MemoExpenseValidationOptions = {}
): Promise<MemoExpenseValidation> {
  const parsed = parseMemo(memo);
  if (!parsed.ok) {
    return { ok: false, reason: "invalid_memo", message: parsed.message };
  }

  if (opts.expectedCode !== undefined && parsed.code !== opts.expectedCode) {
    return {
      ok: false,
      reason: "code_mismatch",
      code: parsed.code,
      message: `Memo code "${parsed.code}" does not match the expected code "${opts.expectedCode}".`,
    };
  }

  const expense = opts.expenseId
    ? await prisma.expense.findFirst({
        where: { id: opts.expenseId },
        select: { id: true, memo: true },
      })
    : await prisma.expense.findFirst({
        where: { memo: parsed.code },
        select: { id: true, memo: true },
      });

  if (!expense) {
    return {
      ok: false,
      reason: "expense_not_found",
      code: parsed.code,
      message: opts.expenseId
        ? `Expense ${opts.expenseId} linked to memo ${memo} was not found.`
        : `No expense record matches memo code "${parsed.code}".`,
    };
  }

  const outstandingShares = await prisma.expenseShare.count({
    where: { expenseId: expense.id, status: { not: "settled" } },
  });
  if (outstandingShares === 0) {
    return {
      ok: false,
      reason: "expense_settled",
      code: parsed.code,
      message: `Expense ${expense.id} has no outstanding shares, so memo ${memo} no longer maps to an active expense.`,
    };
  }

  return { ok: true, code: parsed.code, memo, expenseId: expense.id };
}
