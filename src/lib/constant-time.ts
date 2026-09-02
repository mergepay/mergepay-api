import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time comparison of two strings, for verifying shared secrets
 * (webhook and callback signatures) without leaking how much of the expected
 * value a guess matched.
 *
 * `timingSafeEqual` requires equal buffer lengths, so length is checked
 * first. A length mismatch reveals only the secret's length — never its
 * contents — and that information is already implied by the constant-time
 * comparison itself, so this is the standard safe pattern.
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
