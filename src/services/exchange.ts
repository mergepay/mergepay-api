import pino from "pino";
import { config } from "../config";
import { Errors } from "../errors";

const log = pino({ name: "exchange" });
/** The only two assets this module quotes against each other. */
export type AssetCode = "XLM" | "USDC";
/**
 * A quoted rate for one asset pair. `source` says whether the number came
 * from Horizon's order book or from this module's hard-coded fallback, so a
 * caller can decide whether a quote is trustworthy; `cached` marks a value
 * served from the in-memory cache instead of fetched.
 */
export interface ExchangeRate { pair: string; rate: number; source: "horizon" | "fallback"; cached: boolean; fetchedAt: string; }
const cache = new Map<string, { rate: ExchangeRate; expiresAt: number }>();
const fallbacks: Record<string, number> = { "XLM/USDC": 0.1, "USDC/XLM": 10 };
function pair(from: AssetCode, to: AssetCode): string { return `${from.toUpperCase()}/${to.toUpperCase()}`; }

/**
 * Quote `fromAsset` in terms of `toAsset`, reading Horizon's XLM/USDC order
 * book.
 *
 * Horizon is contacted only on a cache miss (or expiry). A failure — timeout,
 * non-OK status, or an empty book — falls back to this module's fixed rate for
 * pairs that have one, so a display-only conversion keeps working during a
 * Horizon outage; pairs without a fallback fail instead of returning a made-up
 * number. An identity conversion never touches the network at all.
 *
 * @param fromAsset - Asset being converted from (`"XLM"` or `"USDC"`).
 * @param toAsset - Asset being converted to; equal to `fromAsset` yields a
 *   rate of `1` with `source: "fallback"`.
 * @returns The quote: `rate` is units of `toAsset` per unit of `fromAsset`,
 *   `source` is `"horizon"` for a fresh book read and `"fallback"` otherwise,
 *   and `cached: true` when served from memory.
 * @throws {AppError} `upstream` when Horizon failed and no fallback rate is
 *   configured for the pair.
 */
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

/**
 * Convert an amount between the two supported assets using
 * {@link getExchangeRate}.
 *
 * @param amount - Non-negative number (or its string form) in `fromAsset`.
 * @param fromAsset - Asset the amount is denominated in.
 * @param toAsset - Asset to convert into.
 * @returns The converted amount as a fixed 7-decimal-place string (Stellar's
 *   wire precision).
 * @throws {AppError} `bad_request` (`invalid_amount`) when `amount` is not a
 *   finite, non-negative number.
 * @throws {AppError} `upstream` when no rate is available for the pair —
 *   propagated from {@link getExchangeRate}.
 */
export async function convertAmount(amount: string | number, fromAsset: AssetCode, toAsset: AssetCode): Promise<string> {
  const value = Number(amount);
  if (!Number.isFinite(value) || value < 0) throw Errors.badRequest("invalid_amount", "Amount must be a non-negative number");
  const quote = await getExchangeRate(fromAsset, toAsset);
  return (value * quote.rate).toFixed(7);
}

/**
 * Drop every cached quote, forcing the next {@link getExchangeRate} call to
 * re-read Horizon. Primarily for tests and explicit refreshes.
 */
export function clearExchangeRateCache(): void { cache.clear(); }
