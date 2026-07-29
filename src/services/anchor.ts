import toml from "toml";
import { z } from "zod";
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

const sep24TransactionResponseSchema = z
  .object({
    transaction: z
      .object({
        status: z.string().min(1).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const interactiveResponseSchema = z
  .object({
    url: z.string().url(),
    id: z.string().min(1),
  })
  .passthrough();

const challengeResponseSchema = z
  .object({
    transaction: z.string().min(1),
    network_passphrase: z.string().min(1).optional(),
  })
  .passthrough();

const tokenResponseSchema = z
  .object({
    token: z.string().min(1),
  })
  .passthrough();

function parseJson<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw Errors.upstream("Anchor returned an invalid response");
  }
  return parsed.data;
}

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

    let parsed: any;
    try {
      parsed = toml.parse(await res.text());
    } catch {
      throw Errors.upstream("Anchor returned invalid stellar.toml");
    }

    const currencies = Array.isArray(parsed.CURRENCIES) ? parsed.CURRENCIES : [];
    const assets = currencies
      .filter((currency: any) => typeof currency?.code === "string")
      .map((currency: any) => ({
        code: currency.code,
        issuer: typeof currency.issuer === "string" ? currency.issuer : null,
      }));

    if (
      typeof parsed.WEB_AUTH_ENDPOINT !== "string" ||
      typeof parsed.TRANSFER_SERVER_SEP0024 !== "string" ||
      typeof parsed.SIGNING_KEY !== "string"
    ) {
      throw Errors.upstream("Anchor stellar.toml is missing required SEP-24 fields");
    }

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

  /** Step 1: get a SEP-10 challenge from the anchor for the user account. */
  async getChallenge(
    webAuthEndpoint: string,
    account: string
  ): Promise<{ transaction: string; networkPassphrase: string }> {
    const url = `${webAuthEndpoint}?account=${encodeURIComponent(account)}`;
    const res = await fetch(url);
    if (!res.ok) throw Errors.upstream("Anchor SEP-10 challenge request failed");
    const data = parseJson(challengeResponseSchema, await res.json());
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
    return parseJson(tokenResponseSchema, await res.json()).token;
  },

  /** Step 3: start a SEP-24 interactive deposit/withdraw. */
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
    return parseJson(interactiveResponseSchema, await res.json());
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
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${params.token}` },
      });
    } catch {
      return null;
    }

    if (!res.ok) return null;

    try {
      const data = parseJson(sep24TransactionResponseSchema, await res.json());
      const rawStatus = data.transaction?.status;
      return rawStatus ? rawStatus.trim().toLowerCase() : null;
    } catch {
      return null;
    }
  },
};

/** Map a raw SEP-24 status to Mergepay's stable AnchorSessionStatus values. */
export function mapAnchorStatus(raw: string): string {
  switch (raw.trim().toLowerCase()) {
    case "completed":
      return "completed";
    case "pending_user_transfer_start":
      return "pending_user_transfer_start";
    case "pending_user_transfer_complete":
      return "pending_user_transfer_complete";
    case "pending_external":
      return "pending_external";
    case "pending_anchor":
      return "pending_anchor";
    case "pending_stellar":
      return "pending_stellar";
    case "refunded":
      return "refunded";
    case "incomplete":
      return "incomplete";
    case "error":
    case "too_small":
    case "too_large":
    case "expired":
      return "error";
    default:
      return "pending_anchor";
  }
}

/** Whether a normalized status is terminal and no longer needs polling. */
export function isTerminalAnchorStatus(status: string): boolean {
  return status === "completed" || status === "error" || status === "refunded";
}
