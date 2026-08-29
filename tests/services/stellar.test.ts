import { describe, it, expect, vi, beforeEach } from "vitest";

// Every Horizon.Server constructed by the service is recorded along with the
// URL it was created from, so tests can assert which endpoint each failover
// attempt was routed to.
const horizonMocks = vi.hoisted(() => ({
  created: [] as { url: string; server: any }[],
}));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  class MockHorizonServer {
    url: string;
    constructor(url: string) {
      this.url = url;
      horizonMocks.created.push({ url, server: this });
    }
  }
  return {
    ...actual,
    Horizon: {
      ...(actual.Horizon as any),
      Server: MockHorizonServer as any,
    },
  };
});

/** Import a fresh copy of the stellar service with the given endpoint pool. */
async function loadStellar(endpoints: string[]) {
  vi.resetModules();
  vi.doMock("../../src/config", () => ({
    config: { HORIZON_ENDPOINTS: endpoints },
  }));
  return import("../../src/services/stellar");
}

function connectionError(): Error {
  return new Error("ECONNREFUSED: connect to primary.example.com");
}

function horizonError(status: number): { response: { status: number } } {
  return { response: { status } };
}

beforeEach(() => {
  horizonMocks.created.length = 0;
  vi.useRealTimers();
});

describe("withHorizonFailover", () => {
  it("rotates to the backup node when the primary throws a connection error", async () => {
    const stellar = await loadStellar([
      "https://primary.example.com",
      "https://backup.example.com",
    ]);

    const attempts: any[] = [];
    const result = await stellar.withHorizonFailover(async (horizon: any) => {
      attempts.push(horizon);
      if (attempts.length === 1) throw connectionError();
      return "ok";
    });

    expect(result).toBe("ok");
    expect(attempts).toHaveLength(2);
    // First attempt hit the primary; the retry hit the backup.
    expect(attempts[0].url).toBe("https://primary.example.com");
    expect(attempts[1].url).toBe("https://backup.example.com");
    expect(horizonMocks.created[0].url).toBe("https://primary.example.com");
    expect(horizonMocks.created[1].url).toBe("https://backup.example.com");
  });

  it("falls back on 5xx server errors", async () => {
    const stellar = await loadStellar([
      "https://primary.example.com",
      "https://backup.example.com",
    ]);

    const attempts: any[] = [];
    const result = await stellar.withHorizonFailover(async (horizon: any) => {
      attempts.push(horizon);
      if (attempts.length === 1) throw horizonError(503);
      return "recovered";
    });

    expect(result).toBe("recovered");
    expect(attempts).toHaveLength(2);
    expect(attempts[0].url).toBe("https://primary.example.com");
    expect(attempts[1].url).toBe("https://backup.example.com");
  });

  it("falls back on 429 rate limits", async () => {
    const stellar = await loadStellar([
      "https://primary.example.com",
      "https://backup.example.com",
    ]);

    const attempts: any[] = [];
    const result = await stellar.withHorizonFailover(async (horizon: any) => {
      attempts.push(horizon);
      if (attempts.length === 1) throw horizonError(429);
      return "ok";
    });

    expect(result).toBe("ok");
    expect(attempts).toHaveLength(2);
  });

  it("does not fall back on 4xx client errors", async () => {
    const stellar = await loadStellar([
      "https://primary.example.com",
      "https://backup.example.com",
    ]);

    const attempts: any[] = [];
    await expect(
      stellar.withHorizonFailover(async (horizon: any) => {
        attempts.push(horizon);
        throw horizonError(400);
      })
    ).rejects.toMatchObject({ response: { status: 400 } });

    expect(attempts).toHaveLength(1);
  });

  it("rotates through every node and rethrows the last error when all fail", async () => {
    const stellar = await loadStellar([
      "https://primary.example.com",
      "https://backup.example.com",
      "https://tertiary.example.com",
    ]);

    const attempts: any[] = [];
    await expect(
      stellar.withHorizonFailover(async (horizon: any) => {
        attempts.push(horizon);
        throw horizonError(502);
      })
    ).rejects.toMatchObject({ response: { status: 502 } });

    expect(attempts).toHaveLength(3);
    expect(attempts[0].url).toBe("https://primary.example.com");
    expect(attempts[1].url).toBe("https://backup.example.com");
    expect(attempts[2].url).toBe("https://tertiary.example.com");
  });

  it("skips a failed node during its cooldown and retries it once the cooldown expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T12:00:00Z"));

    const stellar = await loadStellar([
      "https://primary.example.com",
      "https://backup.example.com",
    ]);

    // Phase 1: primary fails, backup takes over. Primary is now in cooldown.
    const firstAttempts: any[] = [];
    await stellar.withHorizonFailover(async (horizon: any) => {
      firstAttempts.push(horizon);
      if (firstAttempts.length === 1) throw horizonError(500);
      return "ok";
    });
    expect(firstAttempts[0].url).toBe("https://primary.example.com");
    expect(firstAttempts[1].url).toBe("https://backup.example.com");

    // Phase 2: while the primary is cooling down, requests go straight to backup.
    const secondAttempts: any[] = [];
    await stellar.withHorizonFailover(async (horizon: any) => {
      secondAttempts.push(horizon);
      return "ok";
    });
    expect(secondAttempts).toHaveLength(1);
    expect(secondAttempts[0].url).toBe("https://backup.example.com");

    // Phase 3: advance past the cooldown, then fail the backup: rotation lands
    // back on the primary, which is no longer in cooldown.
    vi.setSystemTime(new Date("2026-08-29T12:00:31Z"));
    const thirdAttempts: any[] = [];
    await stellar.withHorizonFailover(async (horizon: any) => {
      thirdAttempts.push(horizon);
      if (thirdAttempts.length === 1) throw horizonError(503);
      return "ok";
    });
    expect(thirdAttempts[0].url).toBe("https://backup.example.com");
    expect(thirdAttempts[1].url).toBe("https://primary.example.com");
  });

  it("keeps single-node configuration backward compatible (no fallback)", async () => {
    const stellar = await loadStellar(["https://only.example.com"]);

    const attempts: any[] = [];
    await expect(
      stellar.withHorizonFailover(async (horizon: any) => {
        attempts.push(horizon);
        throw connectionError();
      })
    ).rejects.toThrow("ECONNREFUSED");

    expect(attempts).toHaveLength(1);
    expect(horizonMocks.created).toHaveLength(1);
  });
});
