import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Keypair, Transaction } from "@stellar/stellar-sdk";
import {
  CLOCK_SKEW_TOLERANCE_SECONDS,
  INTENT_VALIDITY_SECONDS,
  MAX_INTENT_VALIDITY_SECONDS,
  MIN_INTENT_VALIDITY_SECONDS,
  assertIntentNotExpired,
  assertTimeBoundsMatchIntent,
  intentExpiry,
  intentValiditySchema,
  isIntentExpired,
  nowSeconds,
  readTimeBounds,
  secondsUntilExpiry,
} from "../src/lib/time-bounds";

const NOW = new Date("2026-07-30T12:00:00.000Z");

describe("intent expiry is derived from the server clock", () => {
  it("defaults to the shared validity window", () => {
    const { expiresAt, validitySeconds } = intentExpiry(undefined, NOW);
    expect(validitySeconds).toBe(INTENT_VALIDITY_SECONDS);
    expect(expiresAt.getTime()).toBe(NOW.getTime() + INTENT_VALIDITY_SECONDS * 1000);
  });

  it("lets a client shorten the window but never extend it", () => {
    expect(intentExpiry(60, NOW).validitySeconds).toBe(60);

    // Even if a caller sneaks past the schema, the computation clamps.
    expect(intentExpiry(99_999, NOW).validitySeconds).toBe(MAX_INTENT_VALIDITY_SECONDS);
    expect(intentExpiry(1, NOW).validitySeconds).toBe(MIN_INTENT_VALIDITY_SECONDS);
  });

  it("rejects an unreasonable requested window as validation input", () => {
    expect(intentValiditySchema.parse(undefined)).toBe(INTENT_VALIDITY_SECONDS);
    expect(intentValiditySchema.parse("120")).toBe(120);

    for (const bad of [0, -60, MIN_INTENT_VALIDITY_SECONDS - 1, MAX_INTENT_VALIDITY_SECONDS + 1, 86_400, 1.5]) {
      expect(() => intentValiditySchema.parse(bad)).toThrow();
    }
  });

  it("never lets a client timestamp decide the deadline", () => {
    // intentExpiry takes only a duration and the server's own clock — there is
    // no parameter through which a client could supply an absolute time.
    const fromServerClock = intentExpiry(120, NOW).expiresAt;
    expect(fromServerClock.getTime()).toBe(NOW.getTime() + 120_000);
  });
});

describe("expiry boundaries and clock skew", () => {
  const expiresAt = new Date(NOW.getTime() + 60_000);

  it("is not expired before the deadline", () => {
    expect(isIntentExpired(expiresAt, new Date(expiresAt.getTime() - 1_000))).toBe(false);
  });

  it("is not expired exactly at the deadline", () => {
    expect(isIntentExpired(expiresAt, expiresAt)).toBe(false);
  });

  it("tolerates a clock difference up to the documented bound", () => {
    const withinSkew = new Date(
      expiresAt.getTime() + CLOCK_SKEW_TOLERANCE_SECONDS * 1000
    );
    expect(isIntentExpired(expiresAt, withinSkew)).toBe(false);
  });

  it("is expired once past the deadline plus tolerance", () => {
    const pastSkew = new Date(
      expiresAt.getTime() + (CLOCK_SKEW_TOLERANCE_SECONDS + 1) * 1000
    );
    expect(isIntentExpired(expiresAt, pastSkew)).toBe(true);
  });

  it("keeps the tolerance small enough to be meaningless as an extension", () => {
    expect(CLOCK_SKEW_TOLERANCE_SECONDS).toBeGreaterThan(0);
    expect(CLOCK_SKEW_TOLERANCE_SECONDS).toBeLessThanOrEqual(60);
  });

  it("treats a missing deadline as not expired rather than guessing", () => {
    expect(isIntentExpired(null)).toBe(false);
    expect(isIntentExpired(undefined)).toBe(false);
  });

  it("reports remaining time, going negative once past", () => {
    expect(secondsUntilExpiry(expiresAt, NOW)).toBe(60);
    expect(secondsUntilExpiry(expiresAt, new Date(NOW.getTime() + 120_000))).toBe(-60);
  });
});

describe("assertIntentNotExpired raises a distinguishable error", () => {
  it("passes a live intent through", () => {
    expect(() =>
      assertIntentNotExpired(new Date(NOW.getTime() + 60_000), "settlement", NOW)
    ).not.toThrow();
  });

  it("uses a stable code distinct from malformed input and authorization", () => {
    const expired = new Date(NOW.getTime() - 3_600_000);
    try {
      assertIntentNotExpired(expired, "settlement", NOW);
      throw new Error("expected assertIntentNotExpired to throw");
    } catch (error: any) {
      expect(error.code).toBe("INTENT_EXPIRED");
      expect(error.status).toBe(400);
      expect(error.code).not.toBe("VALIDATION_ERROR");
      expect(error.code).not.toBe("XDR_MISMATCH");
      expect(error.code).not.toBe("UNAUTHORIZED");
      expect(error.code).not.toBe("FORBIDDEN");
      // Actionable without leaking state.
      expect(error.message).toMatch(/expired/i);
      expect(error.details).toMatchObject({
        clockSkewToleranceSeconds: CLOCK_SKEW_TOLERANCE_SECONDS,
      });
    }
  });
});

describe("reading time bounds off a signed envelope", () => {
  it("coerces the decimal strings the Stellar SDK exposes", () => {
    expect(readTimeBounds({ timeBounds: { minTime: "100", maxTime: "400" } })).toEqual({
      minTime: 100,
      maxTime: 400,
    });
  });

  it("returns null for an envelope with no usable bounds", () => {
    expect(readTimeBounds({ timeBounds: null })).toBeNull();
    expect(readTimeBounds({})).toBeNull();
    expect(readTimeBounds({ timeBounds: { minTime: "x", maxTime: "y" } })).toBeNull();
  });
});

describe("validating an envelope's bounds against its intent", () => {
  const expiresAt = new Date(NOW.getTime() + INTENT_VALIDITY_SECONDS * 1000);
  const intentMax = Math.floor(expiresAt.getTime() / 1000);

  it("accepts bounds that match the intent", () => {
    expect(() =>
      assertTimeBoundsMatchIntent(
        { minTime: 0, maxTime: intentMax },
        expiresAt,
        "settlement",
        NOW
      )
    ).not.toThrow();
  });

  it("rejects an unbounded envelope as a mismatch, not as expired", () => {
    for (const bounds of [null, { minTime: 0, maxTime: 0 }]) {
      try {
        assertTimeBoundsMatchIntent(bounds, expiresAt, "settlement", NOW);
        throw new Error("expected a mismatch");
      } catch (error: any) {
        expect(error.code).toBe("XDR_MISMATCH");
      }
    }
  });

  it("rejects an envelope valid longer than the intent it was built for", () => {
    try {
      assertTimeBoundsMatchIntent(
        { minTime: 0, maxTime: intentMax + 3_600 },
        expiresAt,
        "settlement",
        NOW
      );
      throw new Error("expected a mismatch");
    } catch (error: any) {
      expect(error.code).toBe("XDR_MISMATCH");
      expect(error.message).toMatch(/valid longer/i);
    }
  });

  it("allows a wallet's maxTime to sit within the skew tolerance of the intent", () => {
    expect(() =>
      assertTimeBoundsMatchIntent(
        { minTime: 0, maxTime: intentMax + CLOCK_SKEW_TOLERANCE_SECONDS },
        expiresAt,
        "settlement",
        NOW
      )
    ).not.toThrow();
  });

  it("rejects an envelope whose own maxTime has passed as expired", () => {
    const wayLater = new Date(NOW.getTime() + 3_600_000);
    try {
      assertTimeBoundsMatchIntent(
        { minTime: 0, maxTime: intentMax },
        expiresAt,
        "settlement",
        wayLater
      );
      throw new Error("expected an expiry error");
    } catch (error: any) {
      expect(error.code).toBe("INTENT_EXPIRED");
    }
  });

  it("accepts an envelope exactly at its maxTime", () => {
    expect(() =>
      assertTimeBoundsMatchIntent(
        { minTime: 0, maxTime: nowSeconds(NOW) },
        expiresAt,
        "settlement",
        NOW
      )
    ).not.toThrow();
  });

  it("rejects an envelope that is not valid yet", () => {
    try {
      assertTimeBoundsMatchIntent(
        { minTime: nowSeconds(NOW) + 3_600, maxTime: intentMax + 3_600 },
        null,
        "settlement",
        NOW
      );
      throw new Error("expected a mismatch");
    } catch (error: any) {
      expect(error.code).toBe("XDR_MISMATCH");
      expect(error.message).toMatch(/not valid yet/i);
    }
  });
});

// ── The Stellar service builds and validates bounded envelopes ──────────────

describe("stellar.buildPayment produces a bounded envelope", () => {
  it("puts the intent's deadline on-chain as the transaction maxTime", async () => {
    const { stellar } = await import("../src/services/stellar");
    const { config } = await import("../src/config");
    const source = Keypair.random();

    const before = nowSeconds();
    const xdr = stellar.buildPayment({
      sourcePublicKey: source.publicKey(),
      sourceSequence: "1",
      destination: Keypair.random().publicKey(),
      asset: { code: "XLM", issuer: null },
      amount: "1",
      memoCode: "ABC123",
      validitySeconds: 120,
    });

    const bounds = readTimeBounds(
      new Transaction(xdr, config.networkPassphrase) as never
    );
    expect(bounds).not.toBeNull();
    expect(bounds!.maxTime).toBeGreaterThanOrEqual(before + 119);
    expect(bounds!.maxTime).toBeLessThanOrEqual(before + 121);
  });

  it("defaults to the shared intent window", async () => {
    const { stellar } = await import("../src/services/stellar");
    const { config } = await import("../src/config");

    const before = nowSeconds();
    const xdr = stellar.buildPayment({
      sourcePublicKey: Keypair.random().publicKey(),
      sourceSequence: "1",
      destination: Keypair.random().publicKey(),
      asset: { code: "XLM", issuer: null },
      amount: "1",
      memoCode: "ABC123",
    });

    const bounds = readTimeBounds(
      new Transaction(xdr, config.networkPassphrase) as never
    );
    expect(bounds!.maxTime).toBeGreaterThanOrEqual(before + INTENT_VALIDITY_SECONDS - 2);
  });
});

describe("submission refuses an expired intent before reaching Horizon", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Build and sign a real payment so only expiry is under test. */
  async function signedPayment(validitySeconds: number) {
    const { stellar } = await import("../src/services/stellar");
    const { config } = await import("../src/config");
    const source = Keypair.random();
    const destination = Keypair.random();

    const xdr = stellar.buildPayment({
      sourcePublicKey: source.publicKey(),
      sourceSequence: "1",
      destination: destination.publicKey(),
      asset: { code: "XLM", issuer: null },
      amount: "1",
      memoCode: "ABC123",
      validitySeconds,
    });

    const tx = new Transaction(xdr, config.networkPassphrase);
    tx.sign(source);

    return {
      signedXdr: tx.toXDR(),
      intent: {
        sourcePublicKey: source.publicKey(),
        destination: destination.publicKey(),
        asset: { code: "XLM", issuer: null },
        amount: "1",
        memoCode: "ABC123",
        resource: "settlement",
      },
    };
  }

  it("accepts a promptly signed envelope", async () => {
    const { validatePaymentTx } = await import("../src/services/stellar");
    const { config } = await import("../src/config");
    const { signedXdr, intent } = await signedPayment(INTENT_VALIDITY_SECONDS);

    expect(() =>
      validatePaymentTx(new Transaction(signedXdr, config.networkPassphrase), {
        ...intent,
        expiresAt: new Date(Date.now() + INTENT_VALIDITY_SECONDS * 1000),
      })
    ).not.toThrow();
  });

  it("rejects an envelope signed long after its window, without calling Horizon", async () => {
    const stellarModule = await import("../src/services/stellar");
    const { signedXdr, intent } = await signedPayment(INTENT_VALIDITY_SECONDS);
    const expiresAt = new Date(Date.now() + INTENT_VALIDITY_SECONDS * 1000);

    // Advance past the window plus the whole skew tolerance.
    vi.useFakeTimers();
    vi.setSystemTime(
      new Date(expiresAt.getTime() + (CLOCK_SKEW_TOLERANCE_SECONDS + 60) * 1000)
    );

    await expect(
      stellarModule.stellar.submitPayment(signedXdr, { ...intent, expiresAt })
    ).rejects.toMatchObject({ code: "INTENT_EXPIRED", status: 400 });
  });

  it("rejects an envelope whose validity outlives the recorded intent", async () => {
    const { validatePaymentTx } = await import("../src/services/stellar");
    const { config } = await import("../src/config");
    const { signedXdr, intent } = await signedPayment(INTENT_VALIDITY_SECONDS);

    // The stored intent expires in 30s, but the envelope is good for 300s.
    expect(() =>
      validatePaymentTx(new Transaction(signedXdr, config.networkPassphrase), {
        ...intent,
        expiresAt: new Date(Date.now() + 30_000),
      })
    ).toThrowError(expect.objectContaining({ code: "XDR_MISMATCH" }));
  });

  it("still validates the intent's other fields", async () => {
    const { validatePaymentTx } = await import("../src/services/stellar");
    const { config } = await import("../src/config");
    const { signedXdr, intent } = await signedPayment(INTENT_VALIDITY_SECONDS);

    expect(() =>
      validatePaymentTx(new Transaction(signedXdr, config.networkPassphrase), {
        ...intent,
        amount: "999",
        expiresAt: new Date(Date.now() + INTENT_VALIDITY_SECONDS * 1000),
      })
    ).toThrowError(expect.objectContaining({ code: "XDR_MISMATCH" }));
  });
});
