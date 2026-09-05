import { describe, it, expect } from "vitest";
import { envSchema, safeErrorMessage } from "../src/config";

// A minimal valid env object, mirroring what dotenv would hand the schema:
// all values are strings, every mandatory variable is present, and everything
// else falls back to the schema's defaults.
const validEnv: Record<string, string> = {
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

const requiredKeys: string[] = [
  "DATABASE_URL",
  "API_PUBLIC_URL",
  "JWT_SECRET",
  "STELLAR_NETWORK",
  "HORIZON_URL",
  "ANCHOR_HOME_DOMAIN",
  "ANCHOR_NAME",
  "ANCHOR_WEBHOOK_SECRET",
  "STABLE_ASSET_CODE",
  "STABLE_ASSET_ISSUER",
];

function without(env: Record<string, string>, key: string): Record<string, string> {
  const copy = { ...env };
  delete copy[key];
  return copy;
}

describe("env schema — valid configurations", () => {
  it("accepts a valid testnet configuration", () => {
    const result = envSchema.parse(validEnv);
    expect(result.STELLAR_NETWORK).toBe("testnet");
    expect(result.HORIZON_URL).toBe("https://horizon-testnet.stellar.org");
  });

  it("accepts a valid public network configuration", () => {
    const result = envSchema.parse({
      ...validEnv,
      STELLAR_NETWORK: "public",
      HORIZON_URL: "https://horizon.stellar.org",
    });
    expect(result.STELLAR_NETWORK).toBe("public");
    expect(result.HORIZON_URL).toBe("https://horizon.stellar.org");
  });

  it("coerces numeric strings to numbers", () => {
    const result = envSchema.parse({ ...validEnv, PORT: "4000", FEE_CACHE_TTL: "30" });
    expect(result.PORT).toBe(4000);
    expect(result.FEE_CACHE_TTL).toBe(30);
  });

  it("coerces boolean strings", () => {
    const result = envSchema.parse({ ...validEnv, CORS_ALLOW_CREDENTIALS: "true" });
    expect(result.CORS_ALLOW_CREDENTIALS).toBe(true);
  });

  it("applies defaults for omitted optional fields", () => {
    const result = envSchema.parse(validEnv);
    expect(result.PORT).toBe(4000);
    expect(result.LOG_LEVEL).toBe("info");
    expect(result.CORS_ALLOW_CREDENTIALS).toBe(false);
    expect(result.ACCESS_TOKEN_TTL_SECONDS).toBe(900);
  });

  it("accepts optional SEP-10 and Horizon fields when provided", () => {
    const result = envSchema.parse({
      ...validEnv,
      SEP10_SIGNING_SECRET: "secret-key",
      SEP10_HOME_DOMAIN: "auth.example.com",
      WEB_AUTH_DOMAIN: "auth.example.com",
      HORIZON_URLS: "https://horizon-testnet.stellar.org,https://horizon2-testnet.stellar.org",
    });
    expect(result.SEP10_SIGNING_SECRET).toBe("secret-key");
    expect(result.SEP10_HOME_DOMAIN).toBe("auth.example.com");
    expect(result.WEB_AUTH_DOMAIN).toBe("auth.example.com");
    expect(result.HORIZON_URLS).toContain(",");
  });
});

describe("env schema — missing mandatory variables", () => {
  it.each(requiredKeys)("throws when %s is missing", (key) => {
    expect(() => envSchema.parse(without(validEnv, key))).toThrow();
  });

  it.each(requiredKeys)("throws when %s is empty", (key) => {
    expect(() => envSchema.parse({ ...validEnv, [key]: "" })).toThrow();
  });

  it("reports the missing variable name in the error", () => {
    const result = envSchema.safeParse(without(validEnv, "DATABASE_URL"));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(safeErrorMessage(result.error)).toContain("DATABASE_URL");
    }
  });
});

describe("env schema — invalid formats", () => {
  it("rejects a non-URL API_PUBLIC_URL", () => {
    expect(() => envSchema.parse({ ...validEnv, API_PUBLIC_URL: "not-a-url" })).toThrow(
      "Invalid URL format"
    );
  });

  it("rejects a non-URL HORIZON_URL", () => {
    expect(() => envSchema.parse({ ...validEnv, HORIZON_URL: "not-a-url" })).toThrow(
      "Invalid URL format"
    );
  });

  it("rejects a JWT_SECRET shorter than 16 characters", () => {
    expect(() => envSchema.parse({ ...validEnv, JWT_SECRET: "short" })).toThrow(
      "JWT_SECRET must be at least 16 characters"
    );
  });

  it("rejects an unsupported STELLAR_NETWORK value", () => {
    expect(() => envSchema.parse({ ...validEnv, STELLAR_NETWORK: "mainnet" })).toThrow(
      "STELLAR_NETWORK must be either 'testnet' or 'public'"
    );
  });

  it("rejects a malformed STABLE_ASSET_ISSUER", () => {
    expect(() => envSchema.parse({ ...validEnv, STABLE_ASSET_ISSUER: "not-a-valid-key" })).toThrow(
      "Invalid Stellar public key format"
    );
  });

  it("rejects a secret key as STABLE_ASSET_ISSUER", () => {
    expect(() =>
      envSchema.parse({
        ...validEnv,
        STABLE_ASSET_ISSUER: "SABCD1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
      })
    ).toThrow("Invalid Stellar public key format");
  });

  it("rejects a public HORIZON_URL when STELLAR_NETWORK is testnet", () => {
    expect(() => envSchema.parse({ ...validEnv, HORIZON_URL: "https://horizon.stellar.org" })).toThrow(
      "HORIZON_URL must match STELLAR_NETWORK"
    );
  });

  it("rejects a testnet HORIZON_URL when STELLAR_NETWORK is public", () => {
    expect(() =>
      envSchema.parse({
        ...validEnv,
        STELLAR_NETWORK: "public",
        HORIZON_URL: "https://horizon-testnet.stellar.org",
      })
    ).toThrow("HORIZON_URL must match STELLAR_NETWORK");
  });
});

describe("env schema — numeric constraints", () => {
  it("rejects a non-positive PORT", () => {
    expect(() => envSchema.parse({ ...validEnv, PORT: "0" })).toThrow();
  });

  it("rejects a non-integer PORT", () => {
    expect(() => envSchema.parse({ ...validEnv, PORT: "4000.5" })).toThrow();
  });

  it("rejects a negative WORKER_INTERVAL_MS", () => {
    expect(() => envSchema.parse({ ...validEnv, WORKER_INTERVAL_MS: "-1000" })).toThrow();
  });

  it("rejects WEBHOOK_MAX_ATTEMPTS above the max of 10", () => {
    expect(() => envSchema.parse({ ...validEnv, WEBHOOK_MAX_ATTEMPTS: "11" })).toThrow();
  });

  it("rejects WORKER_BATCH_SIZE above the max of 500", () => {
    expect(() => envSchema.parse({ ...validEnv, WORKER_BATCH_SIZE: "501" })).toThrow();
  });

  it("rejects ACCESS_TOKEN_TTL_SECONDS above 86400", () => {
    expect(() => envSchema.parse({ ...validEnv, ACCESS_TOKEN_TTL_SECONDS: "86401" })).toThrow();
  });
});

describe("env schema — error reporting", () => {
  it("reports every failed field with its path", () => {
    const result = envSchema.safeParse({
      ...without(validEnv, "DATABASE_URL"),
      API_PUBLIC_URL: "not-a-url",
      JWT_SECRET: "short",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = safeErrorMessage(result.error);
      expect(message).toContain("DATABASE_URL");
      expect(message).toContain("API_PUBLIC_URL");
      expect(message).toContain("JWT_SECRET");
    }
  });

  it("formats a single failure as path: message", () => {
    const result = envSchema.safeParse(without(validEnv, "STABLE_ASSET_CODE"));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(safeErrorMessage(result.error)).toContain("STABLE_ASSET_CODE");
    }
  });
});
