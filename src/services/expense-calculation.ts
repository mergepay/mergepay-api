/**
 * Group expense calculation service — pure functions, no I/O.
 *
 * A group can record expenses in more than one Stellar asset (XLM and USDC are
 * both 7-decimal assets, but a stroop of one is worth nothing in the other).
 * This module owns the arithmetic that turns a set of expenses into:
 *
 *   1. exact per-participant shares for a new expense (`splitExpense`), and
 *   2. a per-asset, per-participant breakdown of what each member paid and owes
 *      (`calculateGroupExpenseBreakdown`), optionally normalized into a single
 *      target asset so the numbers can be compared before settlement
 *      transaction construction.
 *
 * Every amount is handled as a BigInt number of stroops (10^7 per unit), never
 * as a JavaScript number. Currency conversion uses an integer rate scaled to
 * the same 7 decimals, so a rate of `0.1` is exactly ten millionths and no
 * binary floating-point drift can enter the ledger.
 *
 * Rounding contract:
 *   - Splits never create or destroy value: the shares always sum *exactly* to
 *     the expense total. Each participant gets the floor of their weighted
 *     allocation, and the tail stroops (fewer than the participant count) are
 *     distributed one each by largest fractional remainder.
 *   - A converted breakdown preserves each asset's total exactly. The asset
 *     total is floored once, then allocated across participants by largest
 *     fractional remainder, so `sum(participant amounts) == converted total`.
 *
 * The functions are deliberately free of Prisma calls and route concerns; they
 * accept plain records shaped like the persisted `Expense`/`ExpenseShare` rows
 * (including `Prisma.Decimal`-like values) so callers can pass query results
 * straight through after adding the shares relation.
 */

import { MAX_STROOPS, fromStroops, toStroops, validateAsset } from "./money";
import { balanceAssetKey } from "./settlement";

/** Stellar's precision: 7 decimal places, shared by every supported asset. */
const RATE_SCALE = 10_000_000n;

/** Percentages are accepted with at most 6 decimal places. */
const PERCENT_SCALE = 1_000_000n;
const PERCENT_TOTAL = 100n * PERCENT_SCALE;

/**
 * A decimal value as it arrives from the database or a request.
 *
 * Strings are preferred. Objects with a `toString()` are accepted so a
 * `Prisma.Decimal` column can be passed without an intermediate mapping.
 * JavaScript numbers are intentionally *not* accepted for amounts: a float
 * that has already lost precision cannot be repaired here.
 */
export type DecimalLike = string | { toString(): string };

export type ExpenseSplitMode = "equal" | "percentage" | "custom";

/** How a converted result is rounded when an amount does not divide evenly. */
export type ConversionRounding = "down" | "up" | "half-up";

/**
 * Stable machine-readable codes for errors raised by this module.
 *
 * The service is pure and has no HTTP opinion, so callers map these codes onto
 * responses rather than parsing prose. They are exported for that purpose.
 */
export const EXPENSE_CALCULATION_ERROR_CODES = {
  /** An amount was missing, malformed, negative, or out of Stellar's range. */
  INVALID_AMOUNT: "INVALID_AMOUNT",
  /** A conversion rate was malformed, zero, negative, or too precise. */
  INVALID_RATE: "INVALID_RATE",
  /** A percentage was missing, malformed, too precise, or did not total 100. */
  INVALID_PERCENT: "INVALID_PERCENT",
  /** A split or expense had no participants/shares. */
  INVALID_PARTICIPANTS: "INVALID_PARTICIPANTS",
  /** The same participant appeared more than once. */
  DUPLICATE_PARTICIPANT: "DUPLICATE_PARTICIPANT",
  /** The requested split mode is not supported. */
  INVALID_SPLIT: "INVALID_SPLIT",
  /** A stored expense's amount disagrees with the sum of its shares. */
  INCONSISTENT_EXPENSE: "INCONSISTENT_EXPENSE",
  /** No conversion rate was supplied for an asset in the breakdown. */
  MISSING_RATE: "MISSING_RATE",
  /** The asset is outside Mergepay's supported settlement registry. */
  UNSUPPORTED_ASSET: "UNSUPPORTED_ASSET",
  /** A converted amount would exceed Stellar's Int64 stroop range. */
  AMOUNT_OVERFLOW: "AMOUNT_OVERFLOW",
  /** The requested rounding mode is not one of `ConversionRounding`. */
  INVALID_ROUNDING: "INVALID_ROUNDING",
} as const;

export type ExpenseCalculationErrorCode =
  (typeof EXPENSE_CALCULATION_ERROR_CODES)[keyof typeof EXPENSE_CALCULATION_ERROR_CODES];

/**
 * An error raised by the expense calculation service, carrying a stable code.
 *
 * Deliberately not an `AppError`: the service has no HTTP opinion. Message text
 * names the caller's own fields and is safe to forward once the code has been
 * mapped.
 */
export class ExpenseCalculationError extends Error {
  readonly code: ExpenseCalculationErrorCode;

  constructor(code: ExpenseCalculationErrorCode, message: string) {
    super(message);
    this.name = "ExpenseCalculationError";
    this.code = code;
  }
}

/** Narrow an unknown thrown value to an expense calculation error. */
export function isExpenseCalculationError(
  error: unknown
): error is ExpenseCalculationError {
  return error instanceof ExpenseCalculationError;
}

function fail(code: ExpenseCalculationErrorCode, message: string): never {
  throw new ExpenseCalculationError(code, message);
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function readDecimal(value: DecimalLike | undefined, field: string): string {
  if (typeof value === "string") return value;
  if (
    value !== null &&
    typeof value === "object" &&
    typeof value.toString === "function"
  ) {
    return value.toString();
  }
  return fail(
    EXPENSE_CALCULATION_ERROR_CODES.INVALID_AMOUNT,
    `${field} must be a decimal string`
  );
}

/**
 * Parse a decimal amount into stroops.
 *
 * The shared `toStroops` utility performs the strict 7-decimal validation, so
 * this service cannot disagree with the rest of the codebase about what a
 * valid amount is. Its generic errors are re-wrapped with this module's code.
 */
function parseAmount(
  value: DecimalLike | undefined,
  field: string,
  options: { allowZero: boolean } = { allowZero: true }
): bigint {
  const raw = readDecimal(value, field);
  let stroops: bigint;
  try {
    stroops = toStroops(raw);
  } catch (error) {
    return fail(
      EXPENSE_CALCULATION_ERROR_CODES.INVALID_AMOUNT,
      `${field}: ${error instanceof Error ? error.message : "invalid amount"}`
    );
  }
  if (stroops < 0n) {
    fail(
      EXPENSE_CALCULATION_ERROR_CODES.INVALID_AMOUNT,
      `${field} must not be negative`
    );
  }
  if (!options.allowZero && stroops === 0n) {
    fail(
      EXPENSE_CALCULATION_ERROR_CODES.INVALID_AMOUNT,
      `${field} must be greater than zero`
    );
  }
  return stroops;
}

/**
 * Parse a conversion rate into an integer scaled by 10^7.
 *
 * Rates are limited to Stellar's 7-decimal precision: a rate that needs more
 * digits is rejected rather than silently truncated, because truncation would
 * skew every amount converted with it. Callers that hold a longer quote should
 * round it explicitly before passing it in.
 */
function parseRate(rate: string): bigint {
  if (typeof rate !== "string") {
    fail(
      EXPENSE_CALCULATION_ERROR_CODES.INVALID_RATE,
      "Rate must be a decimal string"
    );
  }
  if (!/^\d+(?:\.\d+)?$/.test(rate)) {
    fail(
      EXPENSE_CALCULATION_ERROR_CODES.INVALID_RATE,
      `Rate "${rate}" is not a valid non-negative decimal`
    );
  }
  const [whole, fraction = ""] = rate.split(".");
  if (fraction.length > 7) {
    fail(
      EXPENSE_CALCULATION_ERROR_CODES.INVALID_RATE,
      `Rate "${rate}" exceeds 7-decimal precision`
    );
  }
  const scaled =
    BigInt(whole) * RATE_SCALE + BigInt((fraction + "0000000").slice(0, 7));
  if (scaled <= 0n) {
    fail(
      EXPENSE_CALCULATION_ERROR_CODES.INVALID_RATE,
      "Rate must be greater than zero"
    );
  }
  return scaled;
}

/** Parse a percentage (string or number) into millionths of a percent. */
function parsePercent(
  percent: string | number | undefined,
  userId: string
): bigint {
  if (percent === undefined) {
    fail(
      EXPENSE_CALCULATION_ERROR_CODES.INVALID_PERCENT,
      `Percentage split requires a percent for every participant (missing for "${userId}")`
    );
  }
  const raw =
    typeof percent === "number"
      ? Number.isFinite(percent)
        ? String(percent)
        : fail(
            EXPENSE_CALCULATION_ERROR_CODES.INVALID_PERCENT,
            `Percent for "${userId}" must be a finite number`
          )
      : percent;
  if (typeof raw !== "string") {
    fail(
      EXPENSE_CALCULATION_ERROR_CODES.INVALID_PERCENT,
      `Percent for "${userId}" must be a decimal string or number`
    );
  }
  if (!/^\d+(?:\.\d+)?$/.test(raw)) {
    fail(
      EXPENSE_CALCULATION_ERROR_CODES.INVALID_PERCENT,
      `Percent "${raw}" for "${userId}" is not a valid non-negative decimal`
    );
  }
  const [whole, fraction = ""] = raw.split(".");
  if (fraction.length > 6) {
    fail(
      EXPENSE_CALCULATION_ERROR_CODES.INVALID_PERCENT,
      `Percent "${raw}" for "${userId}" exceeds 6-decimal precision`
    );
  }
  return (
    BigInt(whole) * PERCENT_SCALE +
    BigInt((fraction + "000000").slice(0, 6))
  );
}

function formatPercent(value: bigint): string {
  const whole = value / PERCENT_SCALE;
  const fraction = (value % PERCENT_SCALE)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : `${whole}`;
}

function assertWithinStroopRange(
  amount: bigint,
  code: ExpenseCalculationErrorCode,
  message: string
): void {
  const magnitude = amount < 0n ? -amount : amount;
  if (magnitude > MAX_STROOPS) {
    fail(code, message);
  }
}

function normalizeAsset(
  assetCode: string,
  assetIssuer: string | null | undefined
): AssetRef {
  if (typeof assetCode !== "string" || assetCode.trim() === "") {
    fail(
      EXPENSE_CALCULATION_ERROR_CODES.UNSUPPORTED_ASSET,
      "Asset code is required"
    );
  }
  try {
    // The central registry canonicalizes the code and fills in the configured
    // issuer for an issued asset. That keeps `USDC` and
    // `USDC + configured issuer` in one bucket instead of two.
    const validated = validateAsset(assetCode, assetIssuer ?? null);
    return {
      assetCode: validated.assetCode,
      assetIssuer: validated.assetIssuer,
    };
  } catch (error) {
    return fail(
      EXPENSE_CALCULATION_ERROR_CODES.UNSUPPORTED_ASSET,
      error instanceof Error ? error.message : `Unsupported asset "${assetCode}"`
    );
  }
}

function divideRounded(
  numerator: bigint,
  denominator: bigint,
  rounding: ConversionRounding
): bigint {
  if (
    rounding !== "down" &&
    rounding !== "up" &&
    rounding !== "half-up"
  ) {
    return fail(
      EXPENSE_CALCULATION_ERROR_CODES.INVALID_ROUNDING,
      `Unsupported rounding mode "${rounding}"`
    );
  }
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return quotient;
  switch (rounding) {
    case "down":
      return quotient;
    case "up":
      return quotient + 1n;
    case "half-up":
      return remainder * 2n >= denominator ? quotient + 1n : quotient;
    default:
      return fail(
        EXPENSE_CALCULATION_ERROR_CODES.INVALID_ROUNDING,
        `Unsupported rounding mode "${rounding}"`
      );
  }
}

/**
 * Distribute a total across non-negative integer weights using the
 * largest-remainder method.
 *
 * Each participant first receives the floor of `total * weight / weightSum`.
 * The leftover (always fewer than `weights.length` stroops) is then handed out
 * one stroop at a time, highest fractional remainder first, with the original
 * order as a deterministic tie-break. The returned amounts therefore sum
 * *exactly* to `total`.
 */
function allocateByWeights(
  total: bigint,
  weights: bigint[]
): { amounts: bigint[]; remainderStroops: bigint } {
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0n);
  if (weightSum <= 0n) {
    return fail(
      EXPENSE_CALCULATION_ERROR_CODES.INVALID_SPLIT,
      "Split weights must sum to a positive value"
    );
  }

  const amounts: bigint[] = [];
  const remainders: bigint[] = [];
  for (const weight of weights) {
    if (weight < 0n) {
      fail(
        EXPENSE_CALCULATION_ERROR_CODES.INVALID_SPLIT,
        "Split weights must not be negative"
      );
    }
    const numerator = total * weight;
    amounts.push(numerator / weightSum);
    remainders.push(numerator % weightSum);
  }

  const distributed = total - amounts.reduce((sum, amount) => sum + amount, 0n);
  if (distributed > 0n) {
    const order = amounts
      .map((_, index) => index)
      .sort((left, right) => {
        if (remainders[left] !== remainders[right]) {
          return remainders[left] > remainders[right] ? -1 : 1;
        }
        return left - right;
      });
    let remaining = distributed;
    for (const index of order) {
      if (remaining === 0n) break;
      amounts[index] += 1n;
      remaining -= 1n;
    }
  }

  return { amounts, remainderStroops: distributed };
}

/**
 * Convert a list of non-negative stroop amounts at a fixed rate while
 * preserving their total exactly.
 *
 * The aggregate is floored once (`floor(sum * rate)`), then allocated across
 * entries by largest fractional remainder. Per-entry results are therefore
 * within one stroop of the exact conversion, while the sum of the returned
 * amounts always equals the converted asset total — no stroops appear or
 * disappear when a currency is normalized.
 */
function convertAllocations(amounts: bigint[], rate: bigint): bigint[] {
  if (amounts.length === 0) return [];

  const total = amounts.reduce((sum, amount) => sum + amount, 0n);
  const targetTotal = (total * rate) / RATE_SCALE;
  assertWithinStroopRange(
    targetTotal,
    EXPENSE_CALCULATION_ERROR_CODES.AMOUNT_OVERFLOW,
    "Converted amount exceeds the maximum representable Stellar value"
  );

  const numerators = amounts.map((amount) => amount * rate);
  const converted = numerators.map(
    (numerator) => numerator / RATE_SCALE
  );
  const remainders = numerators.map(
    (numerator) => numerator % RATE_SCALE
  );

  let residual =
    targetTotal - converted.reduce((sum, amount) => sum + amount, 0n);
  if (residual > 0n) {
    const order = converted
      .map((_, index) => index)
      .sort((left, right) => {
        if (remainders[left] !== remainders[right]) {
          return remainders[left] > remainders[right] ? -1 : 1;
        }
        return left - right;
      });
    for (const index of order) {
      if (residual === 0n) break;
      converted[index] += 1n;
      residual -= 1n;
    }
  }

  return converted;
}

// ---------------------------------------------------------------------------
// Currency conversion
// ---------------------------------------------------------------------------

/**
 * Convert a signed stroop amount at `rate` using exact integer arithmetic.
 *
 * `rate` is the number of target-asset units per one source-asset unit,
 * expressed as a decimal string with at most 7 decimal places (e.g. `"0.1"`
 * for 1 XLM -> 0.1 USDC). Signed input is supported because net balances are
 * signed; the magnitude is rounded and the sign re-applied.
 *
 * @param stroops - Amount in source-asset stroops.
 * @param rate - Positive conversion rate with at most 7 decimals.
 * @param rounding - `"half-up"` (default), `"down"`, or `"up"`.
 * @returns Amount in target-asset stroops.
 * @throws {ExpenseCalculationError} `INVALID_RATE` for a malformed or
 *   non-positive rate, `INVALID_ROUNDING` for an unknown rounding mode, and
 *   `AMOUNT_OVERFLOW` when the result exceeds Stellar's Int64 range.
 */
export function convertStroops(
  stroops: bigint,
  rate: string,
  rounding: ConversionRounding = "half-up"
): bigint {
  if (typeof stroops !== "bigint") {
    return fail(
      EXPENSE_CALCULATION_ERROR_CODES.INVALID_AMOUNT,
      "Stroops must be a bigint"
    );
  }
  const scaledRate = parseRate(rate);
  const negative = stroops < 0n;
  const magnitude = negative ? -stroops : stroops;
  const converted = divideRounded(
    magnitude * scaledRate,
    RATE_SCALE,
    rounding
  );
  assertWithinStroopRange(
    converted,
    EXPENSE_CALCULATION_ERROR_CODES.AMOUNT_OVERFLOW,
    "Converted amount exceeds the maximum representable Stellar value"
  );
  return negative ? -converted : converted;
}

/**
 * Convert a non-negative decimal amount at `rate`.
 *
 * @example
 * convertAmount("10", "0.1") // "1"
 * convertAmount("0.0000005", "0.1", "down") // "0"
 *
 * @throws {ExpenseCalculationError} `INVALID_AMOUNT` for a malformed or
 *   negative amount, plus everything {@link convertStroops} can throw.
 */
export function convertAmount(
  amount: DecimalLike,
  rate: string,
  rounding: ConversionRounding = "half-up"
): string {
  const stroops = parseAmount(amount, "amount");
  return fromStroops(convertStroops(stroops, rate, rounding));
}

// ---------------------------------------------------------------------------
// Expense splitting
// ---------------------------------------------------------------------------

export interface SplitParticipant {
  userId: string;
  /** Percentage weight, required for a `percentage` split. */
  percent?: string | number;
  /** Exact amount, required for a `custom` split. */
  amount?: DecimalLike;
}

export interface ExpenseSplitShare {
  userId: string;
  /** Share amount as a canonical decimal string. */
  amount: string;
  /** Percent supplied by the caller, echoed for percentage splits. */
  percent?: string;
}

export interface ExpenseSplitResult {
  /** The expense total as a canonical decimal string. */
  amount: string;
  splitType: ExpenseSplitMode;
  shares: ExpenseSplitShare[];
  /**
   * Number of stroops that did not divide evenly and were assigned one-by-one
   * by largest fractional remainder. Always `"0"` for an exact or custom split.
   * The shares above already include these stroops.
   */
  remainderStroops: string;
}

function assertParticipants(participants: SplitParticipant[]): void {
  if (!Array.isArray(participants) || participants.length === 0) {
    fail(
      EXPENSE_CALCULATION_ERROR_CODES.INVALID_PARTICIPANTS,
      "At least one participant is required"
    );
  }
  const seen = new Set<string>();
  for (const participant of participants) {
    if (
      !participant ||
      typeof participant.userId !== "string" ||
      participant.userId.trim() === ""
    ) {
      fail(
        EXPENSE_CALCULATION_ERROR_CODES.INVALID_PARTICIPANTS,
        "Every participant requires a non-empty userId"
      );
    }
    if (seen.has(participant.userId)) {
      fail(
        EXPENSE_CALCULATION_ERROR_CODES.DUPLICATE_PARTICIPANT,
        `Participant "${participant.userId}" appears more than once`
      );
    }
    seen.add(participant.userId);
  }
}

/**
 * Split an expense total across participants without losing a stroop.
 *
 * Supported modes:
 *   - `"equal"` — every participant carries the same weight. The tail stroops
 *     go to the first participants by largest remainder, so a 2-stroop tail on
 *     seven equal shares is spread over two participants rather than dumped on
 *     one.
 *   - `"percentage"` — weights are percentages that must sum to exactly 100,
 *     with at most 6 decimal places each.
 *   - `"custom"` — each participant supplies an exact amount; those amounts
 *     must sum to the expense total exactly.
 *
 * @throws {ExpenseCalculationError} `INVALID_AMOUNT`, `INVALID_PARTICIPANTS`,
 *   `DUPLICATE_PARTICIPANT`, `INVALID_SPLIT`, `INVALID_PERCENT`, or
 *   `AMOUNT_OVERFLOW`.
 */
export function splitExpense(
  amount: DecimalLike,
  splitType: ExpenseSplitMode,
  participants: SplitParticipant[]
): ExpenseSplitResult {
  const total = parseAmount(amount, "amount", { allowZero: false });
  assertParticipants(participants);

  if (splitType === "custom") {
    const amounts = participants.map((participant) => {
      if (participant.amount === undefined) {
        fail(
          EXPENSE_CALCULATION_ERROR_CODES.INVALID_SPLIT,
          `Custom split requires an amount for every participant (missing for "${participant.userId}")`
        );
      }
      return parseAmount(participant.amount, `amount for "${participant.userId}"`);
    });
    const sum = amounts.reduce((acc, share) => acc + share, 0n);
    if (sum !== total) {
      fail(
        EXPENSE_CALCULATION_ERROR_CODES.INVALID_SPLIT,
        `Custom amounts must sum to ${fromStroops(total)} (got ${fromStroops(sum)})`
      );
    }
    return {
      amount: fromStroops(total),
      splitType,
      shares: participants.map((participant, index) => ({
        userId: participant.userId,
        amount: fromStroops(amounts[index]),
      })),
      remainderStroops: "0",
    };
  }

  let weights: bigint[];
  if (splitType === "equal") {
    weights = participants.map(() => 1n);
  } else if (splitType === "percentage") {
    weights = participants.map((participant) =>
      parsePercent(participant.percent, participant.userId)
    );
    const percentSum = weights.reduce((sum, weight) => sum + weight, 0n);
    if (percentSum !== PERCENT_TOTAL) {
      fail(
        EXPENSE_CALCULATION_ERROR_CODES.INVALID_PERCENT,
        `Percentages must sum to exactly 100 (got ${formatPercent(percentSum)})`
      );
    }
  } else {
    return fail(
      EXPENSE_CALCULATION_ERROR_CODES.INVALID_SPLIT,
      `Unsupported split type "${splitType}"`
    );
  }

  const { amounts, remainderStroops } = allocateByWeights(total, weights);
  return {
    amount: fromStroops(total),
    splitType,
    shares: participants.map((participant, index) => ({
      userId: participant.userId,
      amount: fromStroops(amounts[index]),
      ...(splitType === "percentage" && participant.percent !== undefined
        ? { percent: String(participant.percent) }
        : {}),
    })),
    remainderStroops: remainderStroops.toString(),
  };
}

// ---------------------------------------------------------------------------
// Group expense breakdown
// ---------------------------------------------------------------------------

export interface AssetRef {
  assetCode: string;
  assetIssuer: string | null;
}

export interface ExpenseShareRecord {
  userId: string;
  shareAmount: DecimalLike;
  /**
   * Recorded settlement state. The gross breakdown does not use it — a share
   * is part of what its owner consumed whether or not it has been paid — but
   * it is accepted so persisted rows can be passed through unchanged.
   */
  settled?: boolean;
}

/** A persisted `Expense` with its `shares` relation. */
export interface ExpenseRecord {
  id?: string;
  payerUserId: string;
  /**
   * Stored expense total. When present it must equal the sum of the shares;
   * when omitted the shares are used as the total.
   */
  amount?: DecimalLike;
  assetCode: string;
  assetIssuer?: string | null;
  shares: ExpenseShareRecord[];
}

export interface ParticipantAmounts {
  userId: string;
  /** Total this participant fronted, in the breakdown asset. */
  paid: string;
  /** Total of this participant's shares, in the breakdown asset. */
  owed: string;
  /** `paid - owed`: positive means the group owes them, negative means they owe. */
  net: string;
}

export interface AssetExpenseBreakdown {
  assetCode: string;
  assetIssuer: string | null;
  /** Sum of every expense in this asset. Equals both the paid and owed totals. */
  total: string;
  expenseCount: number;
  participants: ParticipantAmounts[];
}

export interface ConversionRateInput {
  fromAssetCode: string;
  fromAssetIssuer?: string | null;
  /** Units of the target asset per one unit of the source asset. */
  rate: string;
}

export interface GroupBreakdownOptions {
  /**
   * When provided, every asset is normalized into this asset using `rates`.
   * Without it only the per-asset breakdown is returned.
   */
  targetAsset?: { assetCode: string; assetIssuer?: string | null };
  /**
   * Required for every non-target asset when `targetAsset` is set. Identity
   * conversions need no entry.
   */
  rates?: ConversionRateInput[];
}

export interface AppliedRate {
  fromAssetCode: string;
  fromAssetIssuer: string | null;
  rate: string;
}

export interface NormalizedExpenseBreakdown extends AssetRef {
  total: string;
  participants: ParticipantAmounts[];
  /** Non-identity rates used to produce this view, in first-seen order. */
  appliedRates: AppliedRate[];
}

export interface GroupExpenseBreakdown {
  /** One entry per asset used by the group, in first-seen order. */
  assets: AssetExpenseBreakdown[];
  /** Present only when `options.targetAsset` was supplied. */
  normalized?: NormalizedExpenseBreakdown;
}

export interface AssetAccumulator {
  asset: AssetRef;
  paid: Map<string, bigint>;
  owed: Map<string, bigint>;
  order: string[];
  seen: Set<string>;
  expenseCount: number;
}

function touch(accumulator: AssetAccumulator, userId: string): void {
  if (!accumulator.seen.has(userId)) {
    accumulator.seen.add(userId);
    accumulator.order.push(userId);
  }
}

function addAmount(
  map: Map<string, bigint>,
  userId: string,
  amount: bigint
): void {
  map.set(userId, (map.get(userId) ?? 0n) + amount);
}

function sumAmounts(amounts: bigint[]): bigint {
  return amounts.reduce((sum, amount) => sum + amount, 0n);
}

function assertNoDuplicateShares(
  shares: ExpenseShareRecord[],
  expenseId: string | undefined
): void {
  const seen = new Set<string>();
  for (const share of shares) {
    if (
      !share ||
      typeof share.userId !== "string" ||
      share.userId.trim() === ""
    ) {
      fail(
        EXPENSE_CALCULATION_ERROR_CODES.INVALID_PARTICIPANTS,
        "Every expense share requires a non-empty userId"
      );
    }
    if (seen.has(share.userId)) {
      fail(
        EXPENSE_CALCULATION_ERROR_CODES.DUPLICATE_PARTICIPANT,
        `Expense${expenseId ? ` "${expenseId}"` : ""} has more than one share for user "${share.userId}"`
      );
    }
    seen.add(share.userId);
  }
}

type RateTable = Map<string, { rate: string; rateScaled: bigint }>;

/**
 * Build the rate table up front so a malformed or duplicate rate is reported
 * even when the breakdown happens to contain no expenses in that asset.
 */
export function buildRateTable(rates: ConversionRateInput[] | undefined): RateTable {
  const table: RateTable = new Map();
  for (const entry of rates ?? []) {
    const asset = normalizeAsset(entry.fromAssetCode, entry.fromAssetIssuer);
    const key = balanceAssetKey(asset.assetCode, asset.assetIssuer);
    if (table.has(key)) {
      fail(
        EXPENSE_CALCULATION_ERROR_CODES.INVALID_RATE,
        `Duplicate conversion rate for asset "${asset.assetCode}"`
      );
    }
    table.set(key, { rate: entry.rate, rateScaled: parseRate(entry.rate) });
  }
  return table;
}

/** Structural checks: payer present, shares present, no duplicate sharer. */
export function assertExpenseShape(expense: ExpenseRecord): void {
  if (
    !expense ||
    typeof expense.payerUserId !== "string" ||
    expense.payerUserId.trim() === ""
  ) {
    fail(
      EXPENSE_CALCULATION_ERROR_CODES.INVALID_PARTICIPANTS,
      "Every expense requires a non-empty payerUserId"
    );
  }
  if (!Array.isArray(expense.shares) || expense.shares.length === 0) {
    fail(
      EXPENSE_CALCULATION_ERROR_CODES.INVALID_PARTICIPANTS,
      `Expense${expense.id ? ` "${expense.id}"` : ""} has no shares`
    );
  }
  assertNoDuplicateShares(expense.shares, expense.id);
}

/**
 * Parse and cross-check an expense's amounts; returns share amounts in stroops
 * (same order as `expense.shares`).
 */
export function parseExpenseShares(expense: ExpenseRecord): bigint[] {
  const shareStroops = expense.shares.map((share) =>
    parseAmount(share.shareAmount, `share amount for "${share.userId}"`)
  );
  const shareTotal = sumAmounts(shareStroops);
  if (shareTotal <= 0n) {
    fail(
      EXPENSE_CALCULATION_ERROR_CODES.INVALID_AMOUNT,
      `Expense${expense.id ? ` "${expense.id}"` : ""} must be greater than zero`
    );
  }

  // A stored `amount` is the payer's outlay. If it disagrees with the shares
  // the row is corrupt: netting it would report a phantom debt.
  if (expense.amount !== undefined) {
    const declared = parseAmount(
      expense.amount,
      `amount for expense${expense.id ? ` "${expense.id}"` : ""}`,
      { allowZero: false }
    );
    if (declared !== shareTotal) {
      fail(
        EXPENSE_CALCULATION_ERROR_CODES.INCONSISTENT_EXPENSE,
        `Expense${expense.id ? ` "${expense.id}"` : ""} amount ${fromStroops(declared)} does not equal the sum of its shares ${fromStroops(shareTotal)}`
      );
    }
  }
  return shareStroops;
}

/** Group expenses into one paid/owed accumulator per asset. */
export function accumulateExpensesByAsset(
  expenses: ExpenseRecord[]
): Map<string, AssetAccumulator> {
  const accumulators = new Map<string, AssetAccumulator>();

  for (const expense of expenses) {
    assertExpenseShape(expense);
    const asset = normalizeAsset(expense.assetCode, expense.assetIssuer);
    const key = balanceAssetKey(asset.assetCode, asset.assetIssuer);
    const shareStroops = parseExpenseShares(expense);
    const shareTotal = sumAmounts(shareStroops);

    let accumulator = accumulators.get(key);
    if (!accumulator) {
      accumulator = {
        asset,
        paid: new Map(),
        owed: new Map(),
        order: [],
        seen: new Set(),
        expenseCount: 0,
      };
      accumulators.set(key, accumulator);
    }

    touch(accumulator, expense.payerUserId);
    addAmount(accumulator.paid, expense.payerUserId, shareTotal);
    accumulator.expenseCount += 1;
    expense.shares.forEach((share, index) => {
      touch(accumulator, share.userId);
      addAmount(accumulator.owed, share.userId, shareStroops[index]);
    });
  }

  return accumulators;
}

/**
 * Turn per-user paid/owed stroop maps into participant rows (`net = paid -
 * owed`), range-checking every figure. `label` prefixes overflow messages.
 */
export function buildParticipantAmounts(
  order: string[],
  paidMap: Map<string, bigint>,
  owedMap: Map<string, bigint>,
  label: string
): ParticipantAmounts[] {
  const paidLabel = label ? `${label} paid total` : "Paid total";
  const owedLabel = label ? `${label} owed total` : "Owed total";
  return order.map((userId) => {
    const paid = paidMap.get(userId) ?? 0n;
    const owed = owedMap.get(userId) ?? 0n;
    assertWithinStroopRange(
      paid,
      EXPENSE_CALCULATION_ERROR_CODES.AMOUNT_OVERFLOW,
      `${paidLabel} for "${userId}" exceeds the maximum representable Stellar value`
    );
    assertWithinStroopRange(
      owed,
      EXPENSE_CALCULATION_ERROR_CODES.AMOUNT_OVERFLOW,
      `${owedLabel} for "${userId}" exceeds the maximum representable Stellar value`
    );
    return {
      userId,
      paid: fromStroops(paid),
      owed: fromStroops(owed),
      net: fromStroops(paid - owed),
    };
  });
}

/** Per-asset breakdown rows (no conversion). */
export function buildAssetBreakdowns(
  accumulators: Map<string, AssetAccumulator>
): AssetExpenseBreakdown[] {
  return [...accumulators.values()].map((accumulator) => {
    const participants = buildParticipantAmounts(
      accumulator.order,
      accumulator.paid,
      accumulator.owed,
      ""
    );
    const total = sumAmounts([...accumulator.owed.values()]);
    assertWithinStroopRange(
      total,
      EXPENSE_CALCULATION_ERROR_CODES.AMOUNT_OVERFLOW,
      "Expense total exceeds the maximum representable Stellar value"
    );
    return {
      assetCode: accumulator.asset.assetCode,
      assetIssuer: accumulator.asset.assetIssuer,
      total: fromStroops(total),
      expenseCount: accumulator.expenseCount,
      participants,
    };
  });
}

/** Convert every asset into the target asset and aggregate per participant. */
export function normalizeToTargetAsset(
  accumulators: Map<string, AssetAccumulator>,
  rates: RateTable,
  targetAsset: { assetCode: string; assetIssuer?: string | null }
): NormalizedExpenseBreakdown {
  const target = normalizeAsset(targetAsset.assetCode, targetAsset.assetIssuer);
  const targetKey = balanceAssetKey(target.assetCode, target.assetIssuer);

  const normalizedPaid = new Map<string, bigint>();
  const normalizedOwed = new Map<string, bigint>();
  const order: string[] = [];
  const seen = new Set<string>();
  const appliedRates: AppliedRate[] = [];
  let normalizedTotal = 0n;

  for (const accumulator of accumulators.values()) {
    const key = balanceAssetKey(
      accumulator.asset.assetCode,
      accumulator.asset.assetIssuer
    );
    const userIds = accumulator.order;
    const paidAmounts = userIds.map((userId) => accumulator.paid.get(userId) ?? 0n);
    const owedAmounts = userIds.map((userId) => accumulator.owed.get(userId) ?? 0n);

    let convertedPaid = paidAmounts;
    let convertedOwed = owedAmounts;
    if (key !== targetKey) {
      const conversion = rates.get(key);
      if (!conversion) {
        fail(
          EXPENSE_CALCULATION_ERROR_CODES.MISSING_RATE,
          `No conversion rate supplied for asset "${accumulator.asset.assetCode}" to "${target.assetCode}"`
        );
      }
      convertedPaid = convertAllocations(paidAmounts, conversion.rateScaled);
      convertedOwed = convertAllocations(owedAmounts, conversion.rateScaled);
      appliedRates.push({
        fromAssetCode: accumulator.asset.assetCode,
        fromAssetIssuer: accumulator.asset.assetIssuer,
        rate: conversion.rate,
      });
    }

    for (const userId of userIds) {
      if (!seen.has(userId)) {
        seen.add(userId);
        order.push(userId);
      }
    }
    userIds.forEach((userId, index) => {
      addAmount(normalizedPaid, userId, convertedPaid[index]);
      addAmount(normalizedOwed, userId, convertedOwed[index]);
    });

    // Every asset's converted paid and owed totals are identical by
    // construction; use them to keep the breakdown total exact.
    normalizedTotal += sumAmounts(convertedOwed);
  }

  assertWithinStroopRange(
    normalizedTotal,
    EXPENSE_CALCULATION_ERROR_CODES.AMOUNT_OVERFLOW,
    "Normalized expense total exceeds the maximum representable Stellar value"
  );

  return {
    assetCode: target.assetCode,
    assetIssuer: target.assetIssuer,
    total: fromStroops(normalizedTotal),
    participants: buildParticipantAmounts(order, normalizedPaid, normalizedOwed, "Normalized"),
    appliedRates,
  };
}

/**
 * Compute a group's expense breakdown, per asset and optionally normalized.
 *
 * For each asset the result records, per participant:
 *   - `paid` — the sum of expenses that participant fronted,
 *   - `owed` — the sum of that participant's shares, and
 *   - `net` — `paid - owed` (positive: the group owes them).
 *
 * Within every asset, `sum(paid) === sum(owed) === total` and the nets sum to
 * zero exactly, because each expense is validated to have shares summing to its
 * amount. This is the gross picture used to construct settlement intents; it
 * does not subtract already-confirmed settlements (see
 * `computeNetBalancesByAsset` in `services/settlement` for outstanding
 * balances).
 *
 * When `targetAsset` is supplied, each asset's per-participant paid/owed
 * allocations are converted with the integer rate for that asset (see
 * `ConversionRateInput`), preserving each asset total exactly. Participants are
 * then aggregated across assets into one net figure, so XLM and USDC amounts
 * can be compared and offset in a single settlement currency without ever
 * letting a floating-point conversion leak into the ledger.
 *
 * @throws {ExpenseCalculationError} `UNSUPPORTED_ASSET`, `INVALID_AMOUNT`,
 *   `INVALID_PARTICIPANTS`, `DUPLICATE_PARTICIPANT`, `INCONSISTENT_EXPENSE`,
 *   `INVALID_RATE`, `MISSING_RATE`, or `AMOUNT_OVERFLOW`.
 */
export function calculateGroupExpenseBreakdown(
  expenses: ExpenseRecord[],
  options: GroupBreakdownOptions = {}
): GroupExpenseBreakdown {
  if (!Array.isArray(expenses)) {
    fail(
      EXPENSE_CALCULATION_ERROR_CODES.INVALID_PARTICIPANTS,
      "Expenses must be an array"
    );
  }

  const rates = buildRateTable(options.rates);
  const accumulators = accumulateExpensesByAsset(expenses);
  const assets = buildAssetBreakdowns(accumulators);

  if (!options.targetAsset) {
    return { assets };
  }
  return {
    assets,
    normalized: normalizeToTargetAsset(accumulators, rates, options.targetAsset),
  };
}
