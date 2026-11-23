import { z } from "zod";

const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;
const HTML_TAG_PATTERN = /<\/?[a-zA-Z][^>]*>/g;
const DANGEROUS_CONTROL_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
];
const INVISIBLE_OVERRIDE_PATTERN =
  /[\u200B\u200C\u2028\u2029\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

/**
 * Clean a user-submitted display string (expense titles/descriptions, group
 * names/descriptions, proposal descriptions) before it reaches the database.
 *
 * Strips HTML tags/comments, dangerous control characters, and invisible
 * bidi/zero-width overrides, then trims surrounding whitespace. Emojis
 * (including ZWJ sequences and skin-tone modifiers), international text, and
 * ordinary punctuation are preserved — only markup and non-printing control
 * code points are removed.
 */
export function sanitizeText(value: string): string {
  return value
    .replace(HTML_COMMENT_PATTERN, "")
    .replace(HTML_TAG_PATTERN, "")
    .split("")
    .filter((char) => !isDangerousControl(char))
    .join("")
    .replace(INVISIBLE_OVERRIDE_PATTERN, "")
    .trim();
}

function isDangerousControl(char: string): boolean {
  const code = char.charCodeAt(0);
  return DANGEROUS_CONTROL_RANGES.some(
    ([start, end]) => code >= start && code <= end
  );
}

export interface SanitizedTextOptions {
  min?: number;
  max?: number;
  minMessage?: string;
  maxMessage?: string;
}

/**
 * A Zod string field that sanitizes first, then validates length on the
 * cleaned value, so a padded or markup-wrapped payload is judged by what will
 * actually be stored. Usable anywhere `z.string()` was, including
 * `.optional()` / `.nullable()` chains.
 */
export function sanitizedTextField(options: SanitizedTextOptions = {}) {
  let inner = z.string();
  if (options.min !== undefined) {
    inner = inner.min(options.min, options.minMessage);
  }
  if (options.max !== undefined) {
    inner = inner.max(options.max, options.maxMessage);
  }
  return z.preprocess(
    (value) => (typeof value === "string" ? sanitizeText(value) : value),
    inner
  );
}
