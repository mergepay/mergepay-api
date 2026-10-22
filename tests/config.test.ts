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

  it("accepts an uppercase network name and normalizes it to lowercase", () => {
    const testnet = envSchema.parse({ ...validEnv, STELLAR_NETWORK: "TESTNET" });
    expect(testnet.STELLAR_NETWORK).toBe("testnet");

    const publicNetwork = envSchema.parse({
      ...validEnv,
      STELLAR_NETWORK: "PUBLIC",
      HORIZON_URL: "https://horizon.stellar.org",
    });
    expect(publicNetwork.STELLAR_NETWORK).toBe("public");
  });

  it("still enforces the Horizon/network match for an uppercase network name", () => {
    expect(() =>
      envSchema.parse({
        ...validEnv,
        STELLAR_NETWORK: "PUBLIC",
        HORIZON_URL: "https://horizon-testnet.stellar.org",
      })
    ).toThrow("HORIZON_URL must match STELLAR_NETWORK");
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

  it.each([
    ["ftp", "ftp://horizon-testnet.stellar.org"],
    ["file", "file:///etc/hosts"],
    ["websocket", "wss://horizon-testnet.stellar.org"],
  ])("rejects a HORIZON_URL that is well-formed but uses %s", (_label, url) => {
    expect(() => envSchema.parse({ ...validEnv, HORIZON_URL: url })).toThrow(
      "Horizon endpoint must be a valid http:// or https:// URL"
    );
  });

  it("rejects a HORIZON_URLS list containing a non-URL endpoint", () => {
    expect(() =>
      envSchema.parse({
        ...validEnv,
        HORIZON_URLS: "https://horizon-testnet.stellar.org,not-a-url",
      })
    ).toThrow("HORIZON_URLS contains an invalid endpoint");
  });

  it("rejects a HORIZON_URLS list containing a non-http endpoint", () => {
    expect(() =>
      envSchema.parse({
        ...validEnv,
        HORIZON_URLS: "https://horizon-testnet.stellar.org,ftp://horizon-testnet.stellar.org",
      })
    ).toThrow("HORIZON_URLS contains an invalid endpoint");
  });

  it("accepts a HORIZON_URLS list of http(s) endpoints, whatever the spacing", () => {
    const result = envSchema.parse({
      ...validEnv,
      HORIZON_URLS: " https://horizon-testnet.stellar.org , http://horizon2-testnet.stellar.org ",
    });
    expect(result.HORIZON_URLS).toContain("horizon2-testnet.stellar.org");
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

// Issue #380 — the Prisma connection knobs must exist with fail-fast defaults
// and reject values that would silently disable their protection (a zero or
// negative timeout is not a timeout). src/db.ts turns these into the
// datasource URL parameters and the query-timeout middleware; this block pins
// the contract at the configuration boundary.
describe("env schema — database timeout configuration", () => {
  it("applies fail-fast defaults for the Prisma connection settings", () => {
    const result = envSchema.parse(validEnv);
    expect(result.DATABASE_QUERY_TIMEOUT_MS).toBe(10000);
    expect(result.DATABASE_CONNECT_TIMEOUT_SECONDS).toBe(10);
    expect(result.DATABASE_POOL_TIMEOUT_SECONDS).toBe(10);
    expect(result.DATABASE_CONNECTION_LIMIT).toBe(5);
  });

  it("accepts explicit connection pool and timeout overrides", () => {
    const result = envSchema.parse({
      ...validEnv,
      DATABASE_QUERY_TIMEOUT_MS: "2500",
      DATABASE_CONNECT_TIMEOUT_SECONDS: "3",
      DATABASE_POOL_TIMEOUT_SECONDS: "4",
      DATABASE_CONNECTION_LIMIT: "20",
    });
    expect(result.DATABASE_QUERY_TIMEOUT_MS).toBe(2500);
    expect(result.DATABASE_CONNECT_TIMEOUT_SECONDS).toBe(3);
    expect(result.DATABASE_POOL_TIMEOUT_SECONDS).toBe(4);
    expect(result.DATABASE_CONNECTION_LIMIT).toBe(20);
  });

  it.each([
    "DATABASE_QUERY_TIMEOUT_MS",
    "DATABASE_CONNECT_TIMEOUT_SECONDS",
    "DATABASE_POOL_TIMEOUT_SECONDS",
    "DATABASE_CONNECTION_LIMIT",
  ])("rejects a non-positive or non-numeric %s", (key) => {
    expect(() => envSchema.parse({ ...validEnv, [key]: "0" })).toThrow();
    expect(() => envSchema.parse({ ...validEnv, [key]: "-1" })).toThrow();
    expect(() => envSchema.parse({ ...validEnv, [key]: "ten" })).toThrow();
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

  // SEP-10 challenge lifetime (#659). Bounded on both ends: the top of the
  // range is the replay window a stolen envelope stays signable, the bottom is
  // how long a slow signer (hardware wallet, mobile) gets to return it.
  it.each(["30", "300", "600"])(
    "accepts a SEP10_CHALLENGE_VALIDITY_SECONDS of %s",
    (value) => {
      expect(
        envSchema.parse({ ...validEnv, SEP10_CHALLENGE_VALIDITY_SECONDS: value })
          .SEP10_CHALLENGE_VALIDITY_SECONDS
      ).toBe(Number(value));
    }
  );

  it("defaults the SEP-10 challenge lifetime to SEP-10's recommendation", () => {
    expect(envSchema.parse(validEnv).SEP10_CHALLENGE_VALIDITY_SECONDS).toBe(300);
  });

  it.each([
    ["29, below the signing floor", "29"],
    ["601, past the replay bound", "601"],
    ["3600, the hour-long typo this guards against", "3600"],
    ["a fractional second", "30.5"],
    ["a non-number", "five-minutes"],
    ["negative", "-300"],
  ])("rejects SEP10_CHALLENGE_VALIDITY_SECONDS of %s", (_label, value) => {
    expect(() =>
      envSchema.parse({ ...validEnv, SEP10_CHALLENGE_VALIDITY_SECONDS: value })
    ).toThrow();
  });

  it("names the field when the SEP-10 lifetime is out of bounds", () => {
    const result = envSchema.safeParse({
      ...validEnv,
      SEP10_CHALLENGE_VALIDITY_SECONDS: "3600",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(safeErrorMessage(result.error)).toContain("SEP10_CHALLENGE_VALIDITY_SECONDS");
    }
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
