/**
 * Stellar asset amount formatting utilities.
 *
 * Provides safe, precision-preserving formatting for Stellar native amounts
 * (XLM, USDC, etc.) which use 7 decimal places of precision (stroops).
 * All conversions use BigInt to avoid JavaScript floating-point inaccuracies.
 */
import {
  STROOPS_PER_UNIT,
  MAX_STROOPS,
  validateAmount,
  toStroops,
  fromStroops,
  stroopsToStellarAmount,
} from "../lib/money";

/**
 * Format a Stellar amount as a fixed-precision string with exactly 7 decimal places.
 *
 * This is the canonical "wire format" used by the Stellar network and Horizon API.
 * It preserves full precision without any rounding or truncation.
 *
 * @param amount - Amount as a decimal string (e.g. "100", "10.5", "0.0000001", "0")
 *                 or as stroops (BigInt or number)
 * @returns Formatted string with exactly 7 decimal places (e.g. "100.0000000")
 *
 * @throws {Error} If the input is not a valid Stellar amount
 */
export function formatStellarAmount(amount: string | bigint | number): string {
  let stroops: bigint;

  if (typeof amount === "bigint") {
    stroops = amount;
  } else if (typeof amount === "number") {
    if (!Number.isSafeInteger(amount)) {
      throw new Error("Number amount must be a safe integer representing stroops");
    }
    stroops = BigInt(amount);
  } else {
    // Handle zero as a special case since validateAmount rejects it
    if (amount === "0" || amount === "0.0" || amount === "0.0000000") {
      stroops = 0n;
    } else {
      // Validate and parse the decimal string
      const result = validateAmount(amount);
      if (!result.ok) {
        throw new Error(result.message);
      }
      stroops = result.value.stroops;
    }
  }

  // Validate range
  if (stroops < 0n || stroops > MAX_STROOPS) {
    throw new Error("Amount out of valid Stellar range");
  }

  return stroopsToStellarAmount(stroops);
}

/**
 * Format a Stellar amount as a human-readable decimal string (trailing zeros trimmed).
 *
 * This is the preferred format for API responses and user-facing displays.
 * It removes unnecessary trailing zeros while preserving significant precision.
 *
 * @param amount - Amount as a decimal string, stroops (BigInt/number), or ValidatedAmount
 * @returns Canonical decimal string (e.g. "100", "10.5", "0.0000001", "0")
 *
 * @throws {Error} If the input is not a valid Stellar amount
 */
export function formatStellarAmountHuman(amount: string | bigint | number): string {
  let stroops: bigint;

  if (typeof amount === "bigint") {
    stroops = amount;
  } else if (typeof amount === "number") {
    if (!Number.isSafeInteger(amount)) {
      throw new Error("Number amount must be a safe integer representing stroops");
    }
    stroops = BigInt(amount);
  } else {
    // Handle zero as a special case since validateAmount rejects it
    if (amount === "0" || amount === "0.0" || amount === "0.0000000") {
      stroops = 0n;
    } else {
      const result = validateAmount(amount);
      if (!result.ok) {
        throw new Error(result.message);
      }
      stroops = result.value.stroops;
    }
  }

  if (stroops < 0n || stroops > MAX_STROOPS) {
    throw new Error("Amount out of valid Stellar range");
  }

  return fromStroops(stroops);
}

/**
 * Parse a human-readable decimal amount string into stroops (BigInt).
 *
 * This is the inverse of `formatStellarAmountHuman`. It validates the input
 * and converts to the integer stroops representation used internally.
 *
 * @param amount - Decimal string (e.g. "100", "10.5", "0.0000001", "0")
 * @returns Amount in stroops as BigInt
 *
 * @throws {Error} If the input is not a valid Stellar amount
 */
export function parseStellarAmount(amount: string): bigint {
  // Handle zero as a special case since validateAmount rejects it
  if (amount === "0" || amount === "0.0" || amount === "0.0000000") {
    return 0n;
  }

  const result = validateAmount(amount);
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.value.stroops;
}

/**
 * Check if a value is a valid Stellar amount without throwing.
 *
 * @param amount - Value to check (string, number, or BigInt)
 * @returns true if valid, false otherwise
 */
export function isValidStellarAmount(amount: string | bigint | number): boolean {
  try {
    formatStellarAmount(amount);
    return true;
  } catch {
    return false;
  }
}

/**
 * Add two Stellar amounts safely using BigInt arithmetic.
 *
 * @param a - First amount (decimal string, stroops BigInt, or number)
 * @param b - Second amount (decimal string, stroops BigInt, or number)
 * @returns Sum as a canonical decimal string (trailing zeros trimmed)
 *
 * @throws {Error} If either input is invalid or result exceeds maximum
 */
export function addStellarAmounts(
  a: string | bigint | number,
  b: string | bigint | number
): string {
  const stroopsA = typeof a === "bigint" ? a : typeof a === "number" ? BigInt(a) : toStroops(a);
  const stroopsB = typeof b === "bigint" ? b : typeof b === "number" ? BigInt(b) : toStroops(b);

  const sum = stroopsA + stroopsB;
  if (sum > MAX_STROOPS) {
    throw new Error("Sum exceeds maximum Stellar amount");
  }
  return fromStroops(sum);
}

/**
 * Subtract one Stellar amount from another safely using BigInt arithmetic.
 *
 * @param a - Minuend (decimal string, stroops BigInt, or number)
 * @param b - Subtrahend (decimal string, stroops BigInt, or number)
 * @returns Difference as a canonical decimal string (trailing zeros trimmed)
 *
 * @throws {Error} If either input is invalid or result would be negative
 */
export function subtractStellarAmounts(
  a: string | bigint | number,
  b: string | bigint | number
): string {
  const stroopsA = typeof a === "bigint" ? a : typeof a === "number" ? BigInt(a) : toStroops(a);
  const stroopsB = typeof b === "bigint" ? b : typeof b === "number" ? BigInt(b) : toStroops(b);

  if (stroopsA < stroopsB) {
    throw new Error("Amount cannot be negative");
  }
  return fromStroops(stroopsA - stroopsB);
}

/**
 * Compare two Stellar amounts.
 *
 * @param a - First amount (decimal string, stroops BigInt, or number)
 * @param b - Second amount (decimal string, stroops BigInt, or number)
 * @returns -1 if a < b, 0 if a == b, 1 if a > b
 */
export function compareStellarAmounts(
  a: string | bigint | number,
  b: string | bigint | number
): number {
  const stroopsA = typeof a === "bigint" ? a : typeof a === "number" ? BigInt(a) : toStroops(a);
  const stroopsB = typeof b === "bigint" ? b : typeof b === "number" ? BigInt(b) : toStroops(b);

  if (stroopsA < stroopsB) return -1;
  if (stroopsA > stroopsB) return 1;
  return 0;
}