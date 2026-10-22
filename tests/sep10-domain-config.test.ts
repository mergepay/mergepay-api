/**
 * Issue #673 — SEP-10 domain and token-expiry strictness.
 *
 * The challenge *verification* logic on `main` is already strict and well
 * covered (see tests/sep10-strict-validation.test.ts and friends). These specs
 * cover the two places where the strictness around it was self-contradictory:
 *
 *  1. The domain grammar. `/auth/verify` accepts an optional `home_domain` and
 *     rejects any value that is not the domain challenges are issued for,
 *     naming that domain in the error (src/routes/auth.ts). The value it names
 *     is `config.SEP10_HOME_DOMAIN`, which defaults to the *host* of
 *     `API_PUBLIC_URL` — a host that normally carries a port, and in local
 *     development is a single label (`localhost:4000`). The request schema's
 *     domain regex required at least one dot and forbade ports, so a client
 *     that obeyed the error message was rejected for the shape of a domain the
 *     server had just told it to send.
 *  2. The expiry margin. `verifyToken` rejects a token whose remaining
 *     lifetime is below `TOKEN_EXPIRY_MARGIN_SECONDS` (src/services/jwt.ts),
 *     while `signToken` sets `exp` exactly `ACCESS_TOKEN_TTL_SECONDS` after
 *     issuance. Both numbers were validated independently, so a configuration
 *     with a margin at or above the TTL — `ACCESS_TOKEN_TTL_SECONDS=25` with
 *     the default 30s margin, for example — boots cleanly and then rejects
 *     every token it has ever issued, with no failure anywhere else to point at.
 *
 * A SEP-10 domain that cannot be named, and a session that can never be valid,
 * are both "strict validation" failures of the kind this issue is about, and
 * both are caught here at the schema boundary rather than at request time.
 */
import { describe, it, expect } from "vitest";
import { envSchema } from "../src/config";
import {
  MAX_SEP10_DOMAIN_LENGTH,
  clientDomainSchema,
  isSep10Domain,
  sep10DomainSchema,
} from "../src/lib/sep10-domain";
import { sep10VerifyRequestSchema } from "../src/validations/sep10";

/** A minimal valid env, mirroring tests/config.test.ts. */
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

/**
 * The host `config.SEP10_HOME_DOMAIN` falls back to: `new URL(API_PUBLIC_URL).host`,
 * which keeps the port and is literally `localhost:4000` when the URL is
 * unparseable (src/config.ts `hostOf`).
 */
function hostOf(apiPublicUrl: string): string {
  try {
    return new URL(apiPublicUrl).host;
  } catch {
    return "localhost:4000";
  }
}

/** A real challenge envelope, so only the domain under test can fail the parse. */
const validTransaction =
  "AAAAAgAAAAC1onYLUtlHjstsPmfW5JlIT3RWjdpGH/6gVsRd9ncykQAAAGQAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAABqtvJ3AAAAAAAAAAEAAAAAAAAACgAAAARhdXRoAAAAAQAAAAVub25jZQAAAAAAAAAAAAAA";

describe("SEP-10 domain grammar — accepts what a server can be configured with", () => {
  it.each([
    "api.mergepay.app",
    "example.com",
    "sub.domain.example.co.uk",
    // Ports and single-label hosts are normal for local and container deployments,
    // and `hostOf` produces exactly these shapes.
    "localhost",
    "localhost:4000",
    "127.0.0.1",
    "127.0.0.1:5432",
    "host.docker.internal:3000",
    "API.MergePay.App",
    "example.com:65535",
  ])("accepts %s", (domain) => {
    expect(isSep10Domain(domain)).toBe(true);
    expect(sep10DomainSchema.safeParse(domain).success).toBe(true);
  });

  it("accepts the home domain its own configuration falls back to", () => {
    // The invariant that was broken: whatever `config.SEP10_HOME_DOMAIN` ends up
    // being, a client repeating it must pass the request-side grammar.
    for (const url of [
      "http://localhost:4000",
      "https://api.mergepay.app",
      "http://127.0.0.1:3000",
      "not-a-url",
    ]) {
      const host = hostOf(url);
      expect(
        sep10VerifyRequestSchema.safeParse({
          transaction: validTransaction,
          home_domain: host,
        }).success,
        `${url} -> home_domain ${host} must validate`
      ).toBe(true);
    }
  });

  it.each([
    "",
    "   ",
    ".example.com",
    "example.com.",
    "-bad.example.com",
    "bad-.example.com",
    "exam_ple.com",
    "wallet_example.com",
    "exa mple.com",
    "http://example.com",
    "example.com:0",
    "example.com:70000",
    "example.com:notaport",
    "a".repeat(254),
    `${"label".repeat(13)}.com`,
  ])("rejects %s", (domain) => {
    expect(isSep10Domain(domain)).toBe(false);
    expect(sep10DomainSchema.safeParse(domain).success).toBe(false);
  });

  it("caps a domain at the DNS length limit it documents", () => {
    expect(MAX_SEP10_DOMAIN_LENGTH).toBe(253);
    // `abcd.` is 5 characters; 50 of them plus `com` is exactly 253.
    const atLimit = `${"abcd.".repeat(50)}com`;
    expect(atLimit).toHaveLength(MAX_SEP10_DOMAIN_LENGTH);
    expect(isSep10Domain(atLimit)).toBe(true);
    expect(isSep10Domain(`a${atLimit}`)).toBe(false);
  });

  it("bounds each label the way RFC 1123 does", () => {
    expect(isSep10Domain(`${"a".repeat(63)}.com`)).toBe(true);
    expect(isSep10Domain(`${"a".repeat(64)}.com`)).toBe(false);
  });
});

describe("home_domain and client_domain use different grammars", () => {
  // `home_domain` names *this* server and may be a single-label host with a
  // port; `client_domain` names the origin of the client app's `stellar.toml`
  // and so must be a fully-qualified domain. Loosening the first must not
  // loosen the second — this test is the guard against a future "one grammar
  // for everything" change.
  it.each(["localhost", "localhost:4000", "127.0.0.1:3000", "example"])(
    "holds client_domain to the strict rule by rejecting %s",
    (value) => {
      expect(clientDomainSchema.safeParse(value).success).toBe(false);
      expect(sep10DomainSchema.safeParse(value).success).toBe(true);
    }
  );

  it("accepts a fully-qualified client domain", () => {
    expect(clientDomainSchema.safeParse("wallet.example.com").success).toBe(true);
    // A port belongs only to the home domain; a client domain must be resolvable
    // as-is for its `stellar.toml`, so `host:port` is refused.
    expect(clientDomainSchema.safeParse("app.mergepay.app:8443").success).toBe(false);
  });

  it("keeps the two fields independently typed on the verify request", () => {
    expect(
      sep10VerifyRequestSchema.safeParse({
        transaction: validTransaction,
        home_domain: "localhost:4000",
        client_domain: "example",
      }).success
    ).toBe(false);
    expect(
      sep10VerifyRequestSchema.safeParse({
        transaction: validTransaction,
        home_domain: "localhost:4000",
        client_domain: "client.example.com",
      }).success
    ).toBe(true);
  });
});

describe("SEP-10 domains are validated at boot, not at first request", () => {
  it("accepts a configuration that does not set them at all", () => {
    expect(() => envSchema.parse(validEnv)).not.toThrow();
  });

  it.each(["SEP10_HOME_DOMAIN", "WEB_AUTH_DOMAIN"])(
    "accepts an explicitly configured %s that is a valid domain",
    (key) => {
      const result = envSchema.safeParse({ ...validEnv, [key]: "localhost:4000" });
      expect(result.success).toBe(true);
    }
  );

  it.each(["SEP10_HOME_DOMAIN", "WEB_AUTH_DOMAIN"])(
    "refuses to boot when %s is not a domain",
    (key) => {
      for (const bad of ["exam_ple.com", "http://example.com", "", "example.com:99999"]) {
        const result = envSchema.safeParse({ ...validEnv, [key]: bad });
        expect(result.success, `${key}=${JSON.stringify(bad)} should be rejected`).toBe(false);
      }
    }
  );
});

describe("access-token lifetime must outlive the expiry margin", () => {
  it("accepts the defaults", () => {
    const parsed = envSchema.parse(validEnv);
    expect(parsed.ACCESS_TOKEN_TTL_SECONDS).toBeGreaterThan(
      parsed.TOKEN_EXPIRY_MARGIN_SECONDS
    );
  });

  it.each([
    // margin == TTL: `exp - now` is never >= the margin, so verifyToken's
    // near-expiry check rejects every token the moment it is minted.
    ["25", "30"],
    ["30", "30"],
    ["60", "300"],
    ["1", "30"],
  ])("refuses TTL=%s margin=%s, which would reject every token", (ttl, margin) => {
    const result = envSchema.safeParse({
      ...validEnv,
      ACCESS_TOKEN_TTL_SECONDS: ttl,
      TOKEN_EXPIRY_MARGIN_SECONDS: margin,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("ACCESS_TOKEN_TTL_SECONDS");
      expect(result.error.issues[0].message).toMatch(/expired|expiry|margin/i);
    }
  });

  it("accepts a TTL that clears the margin", () => {
    expect(
      envSchema.safeParse({
        ...validEnv,
        ACCESS_TOKEN_TTL_SECONDS: "90",
        TOKEN_EXPIRY_MARGIN_SECONDS: "30",
      }).success
    ).toBe(true);
  });
});
