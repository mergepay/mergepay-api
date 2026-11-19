import { describe, it, expect } from "vitest";
import { envSchema } from "../src/config";
import { validateEnv, formatEnvIssues } from "../src/config/env";

const valid: Record<string, string> = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/mergepay",
  API_PUBLIC_URL: "http://localhost:4000",
  JWT_SECRET: "secure-secret-key-16-chars",
  STELLAR_NETWORK: "testnet",
  HORIZON_URL: "https://horizon-testnet.stellar.org",
  ANCHOR_HOME_DOMAIN: "testanchor.stellar.org",
  ANCHOR_NAME: "Stellar Test Anchor",
  ANCHOR_WEBHOOK_SECRET: "webhook-secret",
  STABLE_ASSET_CODE: "USDC",
  STABLE_ASSET_ISSUER: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
};

describe("startup env validation (#1086)", () => {
  it("accepts a valid environment and applies defaults", () => {
    const r = validateEnv(envSchema, valid);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.env.PORT).toBe(4000);
  });

  it("lists every invalid variable by name in one pass", () => {
    const r = validateEnv(envSchema, { ...valid, DATABASE_URL: "", PORT: "abc", HORIZON_URL: "nope" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const names = r.errors.map((e) => e.split(":")[0]);
      expect(names).toEqual(expect.arrayContaining(["DATABASE_URL", "PORT", "HORIZON_URL"]));
    }
  });

  it("reports missing required variables", () => {
    const r = validateEnv(envSchema, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith("JWT_SECRET"))).toBe(true);
  });

  it("never echoes the offending value, including secrets", () => {
    const r = validateEnv(envSchema, { ...valid, JWT_SECRET: "short-secret", LOG_LEVEL: "super-secret-level" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const out = r.errors.join("\n");
      expect(out).toContain("JWT_SECRET");
      expect(out).not.toContain("short-secret");
      expect(out).not.toContain("super-secret-level");
    }
  });

  it("formats a ZodError path-less issue as configuration", () => {
    const r = envSchema.safeParse({});
    expect(r.success).toBe(false);
    if (!r.success) expect(formatEnvIssues(r.error).length).toBeGreaterThan(0);
  });
});
