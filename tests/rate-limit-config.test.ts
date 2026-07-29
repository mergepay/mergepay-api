import { describe, it, expect } from "vitest";
import { config } from "../src/config";

describe("rate limit configuration", () => {
  it("gives SEP-10 challenge and verify distinct, independently configurable limits", () => {
    expect(config.RATE_LIMIT_AUTH_CHALLENGE_MAX).not.toBe(undefined);
    expect(config.RATE_LIMIT_AUTH_VERIFY_MAX).not.toBe(undefined);
    // Challenge requests are cheap and legitimately retried while a wallet
    // extension is still open; verify is the actual auth step and should be
    // tighter or equal, never looser than challenge by default.
    expect(config.RATE_LIMIT_AUTH_VERIFY_MAX).toBeLessThanOrEqual(
      config.RATE_LIMIT_AUTH_CHALLENGE_MAX
    );
  });

  it("gives settlement creation and confirmation their own explicit limits distinct from the global default", () => {
    expect(config.RATE_LIMIT_SETTLEMENT_CREATE_MAX).toBeLessThan(config.RATE_LIMIT_GLOBAL_MAX);
    expect(config.RATE_LIMIT_SETTLEMENT_CONFIRM_MAX).toBeLessThan(config.RATE_LIMIT_GLOBAL_MAX);
  });

  it("gives the anchor webhook its own explicit limit", () => {
    expect(config.RATE_LIMIT_ANCHOR_WEBHOOK_MAX).toBeGreaterThan(0);
    expect(config.RATE_LIMIT_ANCHOR_WEBHOOK_WINDOW_MS).toBeGreaterThan(0);
  });

  it("defaults to the in-memory store, requiring an explicit opt-in for the database-backed one", () => {
    expect(config.RATE_LIMIT_STORE).toBe("memory");
  });
});
