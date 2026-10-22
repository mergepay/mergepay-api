import { describe, expect, it } from "vitest";
import { envSchema, safeErrorMessage } from "../config";
import {
  RATE_LIMIT_MAX_DEFAULT,
  RATE_LIMIT_TIME_WINDOW_DEFAULT,
  rateLimitConfigSchema,
} from "./env";

/**
 * `rateLimitConfigSchema` is the focused unit under test; the `envSchema`
 * cases prove the schema is actually wired into the environment parsing that
 * runs at initialization (src/config.ts exits with `safeErrorMessage` when
 * that parse fails, so the last block pins the operator-facing message).
 */
describe("rate limit config schema (issue #408)", () => {
  describe("valid values", () => {
    it("coerces a numeric string RATE_LIMIT_MAX into an integer", () => {
      const result = rateLimitConfigSchema.safeParse({
        RATE_LIMIT_MAX: "250",
        RATE_LIMIT_TIME_WINDOW: "30 seconds",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.RATE_LIMIT_MAX).toBe(250);
        expect(result.data.RATE_LIMIT_TIME_WINDOW).toBe("30 seconds");
      }
    });

    it("accepts the smallest valid budget and trims the window string", () => {
      const result = rateLimitConfigSchema.safeParse({
        RATE_LIMIT_MAX: 1,
        RATE_LIMIT_TIME_WINDOW: "  1 minute  ",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.RATE_LIMIT_MAX).toBe(1);
        expect(result.data.RATE_LIMIT_TIME_WINDOW).toBe("1 minute");
      }
    });

    it("parses valid values through the full environment schema", () => {
      const result = envSchema.safeParse({
        ...process.env,
        RATE_LIMIT_MAX: "250",
        RATE_LIMIT_TIME_WINDOW: "30 seconds",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.RATE_LIMIT_MAX).toBe(250);
        expect(result.data.RATE_LIMIT_TIME_WINDOW).toBe("30 seconds");
      }
    });
  });

  describe("defaults", () => {
    it("applies both defaults when the variables are absent", () => {
      const result = rateLimitConfigSchema.safeParse({});

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.RATE_LIMIT_MAX).toBe(RATE_LIMIT_MAX_DEFAULT);
        expect(result.data.RATE_LIMIT_MAX).toBe(100);
        expect(result.data.RATE_LIMIT_TIME_WINDOW).toBe(
          RATE_LIMIT_TIME_WINDOW_DEFAULT
        );
        expect(result.data.RATE_LIMIT_TIME_WINDOW).toBe("1 minute");
      }
    });

    it("applies the defaults through the full environment schema", () => {
      const input = { ...process.env };
      delete input.RATE_LIMIT_MAX;
      delete input.RATE_LIMIT_TIME_WINDOW;

      const result = envSchema.safeParse(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.RATE_LIMIT_MAX).toBe(100);
        expect(result.data.RATE_LIMIT_TIME_WINDOW).toBe("1 minute");
      }
    });
  });

  describe("invalid values", () => {
    it.each([
      ["0", "zero would lock out every request"],
      ["-5", "negative budgets are meaningless"],
      ["2.5", "fractional budgets cannot be counted"],
      ["abc", "non-numeric input coerces to NaN"],
      ["", "an empty value coerces to 0"],
    ])("rejects RATE_LIMIT_MAX=%p (%s)", (value, _description) => {
      const result = rateLimitConfigSchema.safeParse({ RATE_LIMIT_MAX: value });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some((issue) =>
            issue.path.includes("RATE_LIMIT_MAX")
          )
        ).toBe(true);
      }
    });

    it.each([
      ["", "an empty window is not a duration"],
      ["   ", "a whitespace-only window is not a duration"],
      [42, "the window must be a string, not a number"],
    ])("rejects RATE_LIMIT_TIME_WINDOW=%p (%s)", (value, _description) => {
      const result = rateLimitConfigSchema.safeParse({
        RATE_LIMIT_TIME_WINDOW: value,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some((issue) =>
            issue.path.includes("RATE_LIMIT_TIME_WINDOW")
          )
        ).toBe(true);
      }
    });

    it("rejects an invalid RATE_LIMIT_MAX through the full environment schema", () => {
      const result = envSchema.safeParse({ ...process.env, RATE_LIMIT_MAX: "-5" });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some((issue) =>
            issue.path.includes("RATE_LIMIT_MAX")
          )
        ).toBe(true);
      }
    });
  });

  describe("initialization failure reporting", () => {
    it("names the offending variable in the startup error message", () => {
      const result = envSchema.safeParse({ ...process.env, RATE_LIMIT_MAX: "0" });

      expect(result.success).toBe(false);
      if (!result.success) {
        const message = safeErrorMessage(result.error);
        expect(message).toContain("RATE_LIMIT_MAX");
        expect(message).toContain("positive");
      }
    });
  });
});
