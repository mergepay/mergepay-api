import pino from "pino";
import { config } from "../config";
import { Errors } from "../errors";

const log = pino({ name: "exchange" });
export type AssetCode = "XLM" | "USDC";
export interface ExchangeRate { pair: string; rate: number; source: "horizon" | "fallback"; cached: boolean; fetchedAt: string; }
const cache = new Map<string, { rate: ExchangeRate; expiresAt: number }>();
const fallbacks: Record<string, number> = { "XLM/USDC": 0.1, "USDC/XLM": 10 };
function pair(from: AssetCode, to: AssetCode): string { return `${from.toUpperCase()}/${to.toUpperCase()}`; }

export async function getExchangeRate(fromAsset: AssetCode, toAsset: AssetCode): Promise<ExchangeRate> {
  const key = pair(fromAsset, toAsset);
  if (fromAsset === toAsset) return { pair: key, rate: 1, source: "fallback", cached: true, fetchedAt: new Date().toISOString() };
  const existing = cache.get(key);
  if (existing && existing.expiresAt > Date.now()) return { ...existing.rate, cached: true };
  try {
    const url = new URL("/order_book", config.HORIZON_URL);
    url.searchParams.set("selling_asset_type", "native");
    url.searchParams.set("buying_asset_type", "credit_alphanum4");
    url.searchParams.set("buying_asset_code", config.STABLE_ASSET_CODE);
    url.searchParams.set("buying_asset_issuer", config.STABLE_ASSET_ISSUER);
    const response = await fetch(url, { signal: AbortSignal.timeout(config.HORIZON_STATUS_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Horizon returned ${response.status}`);
    const book = (await response.json()) as { asks?: Array<{ price: string }>; bids?: Array<{ price: string }> };
    const ask = Number(book.asks?.[0]?.price); const bid = Number(book.bids?.[0]?.price);
    const xlmUsdc = ask > 0 && bid > 0 ? (ask + bid) / 2 : ask > 0 ? ask : bid;
    if (!Number.isFinite(xlmUsdc) || xlmUsdc <= 0) throw new Error("empty order book");
    const rate = key === "XLM/USDC" ? xlmUsdc : 1 / xlmUsdc;
    const value: ExchangeRate = { pair: key, rate, source: "horizon", cached: false, fetchedAt: new Date().toISOString() };
    cache.set(key, { rate: value, expiresAt: Date.now() + config.EXCHANGE_RATE_CACHE_TTL * 1000 });
    return value;
  } catch (error) {
    const fallback = fallbacks[key];
    if (!fallback) throw Errors.upstream("Exchange rate unavailable");
    log.warn({ pair: key, reason: error instanceof Error ? error.message : "upstream failure" }, "using fallback exchange rate");
    return { pair: key, rate: fallback, source: "fallback", cached: false, fetchedAt: new Date().toISOString() };
  }
}

export async function convertAmount(amount: string | number, fromAsset: AssetCode, toAsset: AssetCode): Promise<string> {
  const value = Number(amount);
  if (!Number.isFinite(value) || value < 0) throw Errors.badRequest("invalid_amount", "Amount must be a non-negative number");
  const quote = await getExchangeRate(fromAsset, toAsset);
  return (value * quote.rate).toFixed(7);
}

export function clearExchangeRateCache(): void { cache.clear(); }
