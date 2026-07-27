/**
 * Anchor (SEP-1 / SEP-10 / SEP-24) integration.
 *
 * All outbound HTTP to the anchor is funnelled through this module so tests can
 * mock it. The default anchor is the SDF test anchor (testanchor.stellar.org).
 */

import toml from "toml";
import { config } from "../config";
import { Errors } from "../errors";

export interface AnchorToml {
  homeDomain: string;
  webAuthEndpoint: string;
  transferServerSep24: string;
  signingKey: string;
  assets: { code: string; issuer: string | null }[];
}

const tomlCache = new Map<string, { value: AnchorToml; at: number }>();
const TOML_TTL = 5 * 60 * 1000;

export const anchorService = {
  /** Fetch & parse the anchor's stellar.toml (cached 5 min). */
  async getToml(homeDomain: string): Promise<AnchorToml> {
    const cached = tomlCache.get(homeDomain);
    if (cached && Date.now() - cached.at < TOML_TTL) return cached.value;

    const url = `https://${homeDomain}/.well-known/stellar.toml`;
    const res = await fetch(url);
    if (!res.ok) {
      throw Errors.upstream(`Could not load stellar.toml for ${homeDomain}`);
    }
    const parsed = toml.parse(await res.text());

    const assets = (parsed.CURRENCIES ?? []).map((c: any) => ({
      code: c.code,
      issuer: c.issuer ?? null,
    }));

    const value: AnchorToml = {
      homeDomain,
      webAuthEndpoint: parsed.WEB_AUTH_ENDPOINT,
      transferServerSep24: parsed.TRANSFER_SERVER_SEP0024,
      signingKey: parsed.SIGNING_KEY,
      assets,
    };
    tomlCache.set(homeDomain, { value, at: Date.now() });
    return value;
  },

  async getAnchorConfig(): Promise<AnchorToml> {
    return this.getToml(config.ANCHOR_HOME_DOMAIN);
  },

  /** Step 1: get a SEP-10 challenge from the anchor for the user account. */
  async getChallenge(
    webAuthEndpoint: string,
    account: string
  ): Promise<{ transaction: string; networkPassphrase: string }> {
    const url = `${webAuthEndpoint}?account=${encodeURIComponent(account)}`;
    const res = await fetch(url);
    if (!res.ok) throw Errors.upstream("Anchor SEP-10 challenge request failed");
    const data: any = await res.json();
    return {
      transaction: data.transaction,
      networkPassphrase: data.network_passphrase ?? config.networkPassphrase,
    };
  },

  /** Step 2: exchange the signed challenge for an anchor JWT. */
  async getToken(webAuthEndpoint: string, signedXdr: string): Promise<string> {
    const res = await fetch(webAuthEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transaction: signedXdr }),
    });
    if (!res.ok) throw Errors.upstream("Anchor SEP-10 token exchange failed");
    const data: any = await res.json();
    if (!data.token) throw Errors.upstream("Anchor did not return a SEP-10 token");
    return data.token;
  },

  /** Start a SEP-24 interactive deposit or withdrawal flow. */
  async startInteractive(params: {
    transferServer: string;
    token: string;
    kind: "deposit" | "withdrawal";
    assetCode: string;
    account: string;
  }): Promise<{ url: string; id: string }> {
    const path = params.kind === "deposit" ? "deposit" : "withdraw";
    const url = `${params.transferServer}/transactions/${path}/interactive`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.token}`,
      },
      body: JSON.stringify({
        asset_code: params.assetCode,
        account: params.account,
      }),
    });
    if (!res.ok) throw Errors.upstream("Anchor interactive flow request failed");
    const data: any = await res.json();
    if (!data.url || !data.id) {
      throw Errors.upstream("Anchor returned an invalid interactive response");
    }
    return { url: data.url, id: data.id };
  },

  async initiateWithdrawal(params: {
    signedXdr: string;
    amount: string;
    assetCode: string;
    account: string;
    memo?: string;
  }): Promise<{ url: string; id: string; token: string }> {
    const anchor = await this.getAnchorConfig();
    const token = await this.getToken(anchor.webAuthEndpoint, params.signedXdr);
    const res = await fetch(
      `${anchor.transferServerSep24}/transactions/withdraw/interactive`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          asset_code: params.assetCode,
          amount: params.amount,
          account: params.account,
          ...(params.memo ? { memo: params.memo } : {}),
        }),
      }
    );
    if (!res.ok) {
      let detail = "Anchor withdrawal request failed";
      try {
        const data: any = await res.json();
        detail = data.error ?? data.message ?? detail;
      } catch {
        // Preserve the stable upstream error for non-JSON responses.
      }
      throw Errors.upstream(detail);
    }
    const data: any = await res.json();
    if (!data.url || !data.id) {
      throw Errors.upstream("Anchor returned an invalid withdrawal response");
    }
    return { url: data.url, id: data.id, token };
  },

  /** Poll a single SEP-24 transaction's status. */
  async getTransactionStatus(params: {
    transferServer: string;
    token: string;
    id: string;
  }): Promise<string | null> {
    const url = `${params.transferServer}/transaction?id=${encodeURIComponent(
      params.id
    )}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${params.token}` },
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    return data?.transaction?.status ?? null;
  },
};

/** Map a raw SEP-24 status to Mergepay's AnchorSessionStatus enum. */
export function mapAnchorStatus(raw: string): string {
  switch (raw) {
    case "completed":
      return "completed";
    case "pending_user_transfer_start":
      return "pending_user_transfer_start";
    case "error":
    case "too_small":
    case "too_large":
      return "error";
    case "refunded":
      return "refunded";
    case "incomplete":
      return "incomplete";
    default:
      return "pending_anchor";
  }
}
