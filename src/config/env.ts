/**
 * Rate-limiting configuration schema (see issue #408).
 *
 * `RATE_LIMIT_MAX` and `RATE_LIMIT_TIME_WINDOW` are the generic knobs a
 * deployment can use to raise or lower the default protection level without
 * touching the per-route tiers (those keep living in `src/config.ts`'s
 * `RATE_LIMIT_*_MAX` / `RATE_LIMIT_*_WINDOW_MS` entries and
 * `src/lib/rate-limit.ts`).
 *
 * The schema is deliberately a standalone export rather than inlined in
 * `src/config.ts`: it has no side effects, so `src/config/env.test.ts` can
 * exercise valid/invalid/absent inputs directly, and `src/config.ts` merges
 * its shape into the main schema so the values are validated once, at module
 * initialization — before the app accepts a single request. A malformed
 * value therefore aborts startup with a descriptive Zod error instead of
 * silently disabling the limiter (a `NaN` max would make every request
 * pass, i.e. fail *open*).
 */
import { z } from "zod";

/**
 * Global request budget per window. Must be a positive integer: `0` (and any
 * negative value) would lock out every request — or worse, parse as `NaN`
 * from a typo'd string and disable limiting entirely.
 */
export const RATE_LIMIT_MAX_DEFAULT = 100;

/**
 * Window length accepted by `@fastify/rate-limit`'s human-readable string
 * format (e.g. "1 minute", "30 seconds"). Optional so deployments can leave
 * the plugin's own default; when set, it must be a non-empty string.
 */
export const RATE_LIMIT_TIME_WINDOW_DEFAULT = "1 minute";

export const rateLimitConfigSchema = z.object({
  RATE_LIMIT_MAX: z.coerce
    .number({ invalid_type_error: "RATE_LIMIT_MAX must be a number" })
    .int("RATE_LIMIT_MAX must be an integer")
    .positive("RATE_LIMIT_MAX must be a positive integer")
    .default(RATE_LIMIT_MAX_DEFAULT),
  RATE_LIMIT_TIME_WINDOW: z
    .string({ invalid_type_error: "RATE_LIMIT_TIME_WINDOW must be a string" })
    .trim()
    .min(1, "RATE_LIMIT_TIME_WINDOW must be a non-empty string")
    .default(RATE_LIMIT_TIME_WINDOW_DEFAULT),
});

export type RateLimitConfig = z.infer<typeof rateLimitConfigSchema>;

/**
 * Startup environment validation reporting (issue #1086).
 *
 * Turns a Zod failure over `process.env` into one line per invalid variable —
 * `NAME: message` — so an operator sees every misconfiguration at once rather
 * than fixing them one restart at a time. Only the variable name and the rule
 * that failed are reported; the offending value is never printed, since an
 * invalid `JWT_SECRET` or `DATABASE_URL` is still a secret. Zod's built-in enum
 * message ends with "received '<value>'", which is stripped for the same
 * reason.
 */
export function formatEnvIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const name = issue.path.length > 0 ? issue.path.join(".") : "configuration";
    const message = issue.message.replace(/,?\s*received\s.*$/i, "").trim();
    return `${name}: ${message}`;
  });
}

export type EnvValidationResult<T> =
  | { ok: true; env: T }
  | { ok: false; errors: string[] };

/** Validates `source` against `schema` without throwing or exiting. */
export function validateEnv<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  source: Record<string, string | undefined>
): EnvValidationResult<T> {
  const result = schema.safeParse(source);
  if (result.success) return { ok: true, env: result.data };
  return { ok: false, errors: formatEnvIssues(result.error) };
}
