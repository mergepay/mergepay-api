import { afterEach, describe, expect, it, vi } from "vitest";
import { clearExchangeRateCache, convertAmount, getExchangeRate } from "../../src/services/exchange";

afterEach(() => {
  clearExchangeRateCache();
  vi.unstubAllGlobals();
});

describe("exchange service", () => {
  it("calculates a midpoint and serves subsequent reads from cache", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ asks: [{ price: "0.11" }], bids: [{ price: "0.09" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await getExchangeRate("XLM", "USDC");
    const second = await getExchangeRate("XLM", "USDC");
    expect(first.rate).toBe(0.1);
    expect(first.source).toBe("horizon");
    expect(second.cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the documented fallback and converts fractional amounts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    expect(await convertAmount("2.5", "XLM", "USDC")).toBe("0.2500000");
  });

  it("refreshes the quote after the configured cache TTL", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ asks: [{ price: "0.10" }], bids: [{ price: "0.10" }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ asks: [{ price: "0.20" }], bids: [{ price: "0.20" }] }) });
    vi.stubGlobal("fetch", fetchMock);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    await getExchangeRate("XLM", "USDC");
    vi.spyOn(Date, "now").mockReturnValue(now + 301_000);
    const refreshed = await getExchangeRate("XLM", "USDC");
    expect(refreshed.rate).toBe(0.2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
