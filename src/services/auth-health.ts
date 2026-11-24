/**
 * Health of the SEP-10 authentication dependencies (issue #1033).
 *
 * Authentication is the hottest path in the API and has two external
 * dependencies: the server signing key that stamps every challenge, and
 * Stellar Horizon, which answers the signer lookup during verification. This
 * module reports both without ever exposing key material — the response is
 * booleans only, so it is safe to serve unauthenticated next to the other
 * health probes.
 */
import { serverKeypair } from "./sep10";
import { checkStellar } from "./health";

export interface AuthHealthResponse {
  status: "ok" | "degraded";
  checks: {
    signingKey: boolean;
    horizon: boolean;
  };
}

export interface AuthHealthDeps {
  /** Returns the signing key's public key, or throws when the key cannot be loaded. */
  loadSigningKey?: () => string;
  /** Probes Stellar Horizon for the signer lookup path. */
  checkHorizon?: () => Promise<boolean>;
}

/**
 * Load the SEP-10 signing key once at startup.
 *
 * `serverKeypair()` already memoizes the derived keypair, so the auth path
 * never re-derives it per request; calling this during boot moves the only
 * derivation — and any failure to parse SEP10_SIGNING_SECRET — off the request
 * path entirely. Returns the server's public key, which is served publicly in
 * stellar.toml and is therefore safe to log.
 */
export function preloadSep10SigningKey(): string {
  return serverKeypair().publicKey();
}

/** Whether the signing key is configured and derivable. Never throws. */
export function signingKeyLoadable(
  loadSigningKey: () => string = () => serverKeypair().publicKey()
): boolean {
  try {
    return Boolean(loadSigningKey());
  } catch {
    return false;
  }
}

/**
 * Report auth dependency health. `ok` only when the signing key loads and
 * Horizon answers; otherwise `degraded`, so an orchestrator can drain an
 * instance whose logins would fail closed.
 */
export async function getAuthHealth(
  deps: AuthHealthDeps = {}
): Promise<AuthHealthResponse> {
  const signingKey = signingKeyLoadable(deps.loadSigningKey);

  let horizon = false;
  try {
    horizon = await (deps.checkHorizon ?? checkStellar)();
  } catch {
    horizon = false;
  }

  return {
    status: signingKey && horizon ? "ok" : "degraded",
    checks: { signingKey, horizon },
  };
}
