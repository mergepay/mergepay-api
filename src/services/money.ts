/**
 * Fixed-point money math at Stellar's 7-decimal precision.
 *
 * All internal arithmetic is done in "stroops" (BigInt, value * 10^7) to avoid
 * floating-point drift, then formatted back to decimal strings for the API and
 * Stellar SDK (which both expect string amounts).
 */

export const SCALE = 7n;
const SCALE_FACTOR = 10_000_000n; // 10^7

/** Parse a decimal string/number to BigInt stroops. Throws on garbage. */
export function toStroops(value: string | number): bigint {
  const s = typeof value === "number" ? value.toString() : value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    throw new Error(`Invalid decimal amount: ${value}`);
  }
  const negative = s.startsWith("-");
  const abs = negative ? s.slice(1) : s;
  const [whole, frac = ""] = abs.split(".");
  const fracPadded = (frac + "0000000").slice(0, 7);
  const result = BigInt(whole) * SCALE_FACTOR + BigInt(fracPadded || "0");
  return negative ? -result : result;
}

/** Format BigInt stroops back to a trimmed decimal string. */
export function fromStroops(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / SCALE_FACTOR;
  const frac = abs % SCALE_FACTOR;
  const fracStr = frac.toString().padStart(7, "0").replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return fracStr.length > 0 ? `${sign}${whole}.${fracStr}` : `${sign}${whole}`;
}

/** Stellar amounts are always 7dp strings. */
export function stroopsToStellarAmount(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / SCALE_FACTOR;
  const frac = abs % SCALE_FACTOR;
  return `${negative ? "-" : ""}${whole}.${frac.toString().padStart(7, "0")}`;
}

export function isPositive(value: string | number): boolean {
  try {
    return toStroops(value) > 0n;
  } catch {
    return false;
  }
}

export function bigIntAbs(v: bigint): bigint {
  return v < 0n ? -v : v;
}
