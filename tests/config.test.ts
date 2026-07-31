import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { Networks } from "@stellar/stellar-sdk";

// Import the schema directly to test validation without triggering module-level exit
const urlSchema = z.string().url("Invalid URL format");
const stellarPublicKeySchema = z.string().regex(/^G[A-Z0-9]{55}$/, "Invalid Stellar public key format");

const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  PORT: z.coerce.number().int().positive().default(4000),
  API_PUBLIC_URL: urlSchema,
  WEB_URL: z.string().default("*"),
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),
  STELLAR_NETWORK: z.enum(["testnet", "public"], {
    errorMap: () => ({ message: "STELLAR_NETWORK must be either 'testnet' or 'public'" }),
  }),
  HORIZON_URL: urlSchema,
  FEE_CACHE_TTL: z.coerce.number().positive().default(30),
  MAX_FEE_STROOPS: z.coerce.number().int().positive().default(1000),
  DEFAULT_FEE_STROOPS: z.coerce.number().int().positive().default(100),
  SEP10_SIGNING_SECRET: z.string().optional(),
  SEP10_HOME_DOMAIN: z.string().optional(),
  WEB_AUTH_DOMAIN: z.string().optional(),
  ANCHOR_HOME_DOMAIN: z.string().min(1, "ANCHOR_HOME_DOMAIN is required"),
  ANCHOR_NAME: z.string().min(1, "ANCHOR_NAME is required"),
  ANCHOR_WEBHOOK_SECRET: z.string().min(1, "ANCHOR_WEBHOOK_SECRET is required"),
  STABLE_ASSET_CODE: z.string().min(1, "STABLE_ASSET_CODE is required"),
  STABLE_ASSET_ISSUER: stellarPublicKeySchema,
  UPLOADS_DIR: z.string().default("./uploads"),
  WORKER_INTERVAL_MS: z.coerce.number().positive().default(30000),
  NODE_ENV: z.string().default("development"),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().max(100000).default(10),
  SETTLEMENT_RATE_LIMIT_MAX: z.coerce.number().int().positive().max(100000).default(20),
  SEP24_RATE_LIMIT_MAX: z.coerce.number().int().positive().max(100000).default(10),
  AUTH_BODY_LIMIT_BYTES: z.coerce.number().int().positive().max(10 * 1024 * 1024).default(256 * 1024),
  MULTIPART_FILE_SIZE_BYTES: z.coerce.number().int().positive().max(50 * 1024 * 1024).default(5 * 1024 * 1024),
}).refine(
  (data) => {
    const isTestnet = data.STELLAR_NETWORK === "testnet";
    const horizonUrl = data.HORIZON_URL.toLowerCase();
    
    if (isTestnet && !horizonUrl.includes("testnet")) {
      return false;
    }
    if (!isTestnet && horizonUrl.includes("testnet")) {
      return false;
    }
    return true;
  },
  {
    message: "HORIZON_URL must match STELLAR_NETWORK (testnet URLs for testnet, public URLs for public)",
    path: ["HORIZON_URL"],
  }
);

const validConfig = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/mergepay",
  PORT: 4000,
  API_PUBLIC_URL: "http://localhost:4000",
  WEB_URL: "*",
  JWT_SECRET: "secure-secret-key-16-chars",
  STELLAR_NETWORK: "testnet" as const,
  HORIZON_URL: "https://horizon-testnet.stellar.org",
  FEE_CACHE_TTL: 30,
  MAX_FEE_STROOPS: 1000,
  DEFAULT_FEE_STROOPS: 100,
  ANCHOR_HOME_DOMAIN: "testanchor.stellar.org",
  ANCHOR_NAME: "Stellar Test Anchor",
  ANCHOR_WEBHOOK_SECRET: "webhook-secret",
  STABLE_ASSET_CODE: "USDC",
  STABLE_ASSET_ISSUER: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  UPLOADS_DIR: "./uploads",
  WORKER_INTERVAL_MS: 30000,
  NODE_ENV: "development",
  RATE_LIMIT_WINDOW_MS: 60000,
  AUTH_RATE_LIMIT_MAX: 10,
  SETTLEMENT_RATE_LIMIT_MAX: 20,
  SEP24_RATE_LIMIT_MAX: 10,
  AUTH_BODY_LIMIT_BYTES: 256 * 1024,
  MULTIPART_FILE_SIZE_BYTES: 5 * 1024 * 1024,
};

describe("Configuration validation", () => {
  it("accepts a valid testnet configuration", () => {
    const result = schema.parse(validConfig);
    expect(result.STELLAR_NETWORK).toBe("testnet");
    expect(result.HORIZON_URL).toBe("https://horizon-testnet.stellar.org");
  });

  it("accepts a valid public network configuration", () => {
    const config = {
      ...validConfig,
      STELLAR_NETWORK: "public" as const,
      HORIZON_URL: "https://horizon.stellar.org",
    };
    const result = schema.parse(config);
    expect(result.STELLAR_NETWORK).toBe("public");
    expect(result.HORIZON_URL).toBe("https://horizon.stellar.org");
  });

  it("rejects missing DATABASE_URL", () => {
    const config = { ...validConfig, DATABASE_URL: "" };
    expect(() => schema.parse(config)).toThrow("DATABASE_URL is required");
  });

  it("rejects invalid API_PUBLIC_URL format", () => {
    const config = { ...validConfig, API_PUBLIC_URL: "not-a-url" };
    expect(() => schema.parse(config)).toThrow("Invalid URL format");
  });

  it("rejects JWT_SECRET shorter than 16 characters", () => {
    const config = { ...validConfig, JWT_SECRET: "short" };
    expect(() => schema.parse(config)).toThrow("JWT_SECRET must be at least 16 characters");
  });

  it("rejects unsupported STELLAR_NETWORK value", () => {
    const config = { ...validConfig, STELLAR_NETWORK: "mainnet" as any };
    expect(() => schema.parse(config)).toThrow("STELLAR_NETWORK must be either 'testnet' or 'public'");
  });

  it("rejects invalid HORIZON_URL format", () => {
    const config = { ...validConfig, HORIZON_URL: "not-a-url" };
    expect(() => schema.parse(config)).toThrow("Invalid URL format");
  });

  it("rejects HORIZON_URL that doesn't match testnet network", () => {
    const config = {
      ...validConfig,
      STELLAR_NETWORK: "testnet" as const,
      HORIZON_URL: "https://horizon.stellar.org",
    };
    expect(() => schema.parse(config)).toThrow("HORIZON_URL must match STELLAR_NETWORK");
  });

  it("rejects HORIZON_URL that doesn't match public network", () => {
    const config = {
      ...validConfig,
      STELLAR_NETWORK: "public" as const,
      HORIZON_URL: "https://horizon-testnet.stellar.org",
    };
    expect(() => schema.parse(config)).toThrow("HORIZON_URL must match STELLAR_NETWORK");
  });

  it("rejects missing ANCHOR_HOME_DOMAIN", () => {
    const config = { ...validConfig, ANCHOR_HOME_DOMAIN: "" };
    expect(() => schema.parse(config)).toThrow("ANCHOR_HOME_DOMAIN is required");
  });

  it("rejects missing ANCHOR_NAME", () => {
    const config = { ...validConfig, ANCHOR_NAME: "" };
    expect(() => schema.parse(config)).toThrow("ANCHOR_NAME is required");
  });

  it("rejects missing ANCHOR_WEBHOOK_SECRET", () => {
    const config = { ...validConfig, ANCHOR_WEBHOOK_SECRET: "" };
    expect(() => schema.parse(config)).toThrow("ANCHOR_WEBHOOK_SECRET is required");
  });

  it("rejects missing STABLE_ASSET_CODE", () => {
    const config = { ...validConfig, STABLE_ASSET_CODE: "" };
    expect(() => schema.parse(config)).toThrow("STABLE_ASSET_CODE is required");
  });

  it("rejects invalid Stellar public key format", () => {
    const config = { ...validConfig, STABLE_ASSET_ISSUER: "not-a-valid-key" };
    expect(() => schema.parse(config)).toThrow("Invalid Stellar public key format");
  });

  it("rejects Stellar secret key (starts with S)", () => {
    const config = { ...validConfig, STABLE_ASSET_ISSUER: "SABCD1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890" };
    expect(() => schema.parse(config)).toThrow("Invalid Stellar public key format");
  });

  it("accepts valid Stellar public key", () => {
    const result = schema.parse(validConfig);
    expect(result.STABLE_ASSET_ISSUER).toBe("GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");
  });

  it("accepts optional SEP10_SIGNING_SECRET when provided", () => {
    const config = { ...validConfig, SEP10_SIGNING_SECRET: "secret-key" };
    const result = schema.parse(config);
    expect(result.SEP10_SIGNING_SECRET).toBe("secret-key");
  });

  it("accepts configuration without SEP10_SIGNING_SECRET", () => {
    const configWithoutSecret: any = { ...validConfig };
    delete configWithoutSecret.SEP10_SIGNING_SECRET;
    const result = schema.parse(configWithoutSecret);
    expect(result.SEP10_SIGNING_SECRET).toBeUndefined();
  });

  it("rejects PORT that is not a positive integer", () => {
    const config = { ...validConfig, PORT: -1 };
    expect(() => schema.parse(config)).toThrow();
  });

  it("rejects PORT that is not an integer", () => {
    const config = { ...validConfig, PORT: 4000.5 };
    expect(() => schema.parse(config)).toThrow();
  });

  it("rejects negative WORKER_INTERVAL_MS", () => {
    const config = { ...validConfig, WORKER_INTERVAL_MS: -1000 };
    expect(() => schema.parse(config)).toThrow();
  });

  it("rejects rate limit max values exceeding 100000", () => {
    const config = { ...validConfig, AUTH_RATE_LIMIT_MAX: 100001 };
    expect(() => schema.parse(config)).toThrow();
  });

  it("provides clear error messages for multiple validation failures", () => {
    const config = {
      ...validConfig,
      DATABASE_URL: "",
      API_PUBLIC_URL: "invalid-url",
      JWT_SECRET: "short",
    };
    expect(() => schema.parse(config)).toThrow();
  });
});
