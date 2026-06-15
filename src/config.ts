import "dotenv/config";
import { z } from "zod";
import { Networks } from "@stellar/stellar-sdk";

const schema = z.object({
  DATABASE_URL: z.string().default("postgresql://postgres:postgres@localhost:5432/mergepay"),
  PORT: z.coerce.number().default(4000),
  API_PUBLIC_URL: z.string().default("http://localhost:4000"),
  // "*" opens CORS to all origins; comma-separate for a whitelist e.g. "https://a.com,https://b.com"
  WEB_URL: z.string().default("*"),
  JWT_SECRET: z.string().default("change-me-in-production"),
  STELLAR_NETWORK: z.enum(["testnet", "public"]).default("public"),
  HORIZON_URL: z.string().default("https://horizon.stellar.org"),
  SEP10_SIGNING_SECRET: z.string().optional(),
  // If not set, derived from API_PUBLIC_URL so the deployed domain is used automatically.
  SEP10_HOME_DOMAIN: z.string().optional(),
  WEB_AUTH_DOMAIN: z.string().optional(),
  ANCHOR_HOME_DOMAIN: z.string().default("testanchor.stellar.org"),
  ANCHOR_NAME: z.string().default("Stellar Test Anchor"),
  ANCHOR_WEBHOOK_SECRET: z.string().default("change-me"),
  STABLE_ASSET_CODE: z.string().default("USDC"),
  STABLE_ASSET_ISSUER: z
    .string()
    .default("GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"),
  UPLOADS_DIR: z.string().default("./uploads"),
  NODE_ENV: z.string().default("development"),
});

const parsed = schema.parse(process.env);

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "localhost:4000";
  }
}

const apiHost = hostOf(parsed.API_PUBLIC_URL);

export const config = {
  ...parsed,
  SEP10_HOME_DOMAIN: parsed.SEP10_HOME_DOMAIN ?? apiHost,
  WEB_AUTH_DOMAIN: parsed.WEB_AUTH_DOMAIN ?? apiHost,
  isTest: process.env.NODE_ENV === "test" || process.env.VITEST === "true",
  networkPassphrase:
    parsed.STELLAR_NETWORK === "public" ? Networks.PUBLIC : Networks.TESTNET,
  jwtExpiresIn: "12h" as const,
};

export type Config = typeof config;
