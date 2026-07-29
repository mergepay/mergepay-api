import { describe, it, expect } from "vitest";
import { userOrIpKey, ipKey } from "../src/services/rate-limit-keys";

function fakeReq(over: Record<string, any> = {}): any {
  return { ip: "203.0.113.5", user: undefined, ...over };
}

describe("userOrIpKey", () => {
  it("keys by user id when authenticated", () => {
    const gen = userOrIpKey("settlement.create");
    const key = gen(fakeReq({ user: { id: "user_123", stellarPublicKey: "GABC..." } }));
    expect(key).toBe("settlement.create:user:user_123");
  });

  it("never includes the Stellar public key in the key", () => {
    const gen = userOrIpKey("settlement.create");
    const key = gen(
      fakeReq({ user: { id: "user_123", stellarPublicKey: "GSECRETPUBLICKEYXXXXXXXXXXXX" } })
    );
    expect(key).not.toContain("GSECRETPUBLICKEYXXXXXXXXXXXX");
  });

  it("falls back to IP when unauthenticated", () => {
    const gen = userOrIpKey("global");
    expect(gen(fakeReq())).toBe("global:ip:203.0.113.5");
  });

  it("falls back to a bounded placeholder when IP is missing", () => {
    const gen = userOrIpKey("global");
    expect(gen(fakeReq({ ip: undefined }))).toBe("global:ip:unknown");
  });

  it("bounds the resulting key length", () => {
    const gen = userOrIpKey("x".repeat(500));
    const key = gen(fakeReq({ user: { id: "user_1" } }));
    expect(key.length).toBeLessThanOrEqual(200);
  });
});

describe("ipKey", () => {
  it("keys strictly by IP regardless of any authenticated user", () => {
    const gen = ipKey("auth.challenge");
    const key = gen(fakeReq({ user: { id: "user_1" } }));
    expect(key).toBe("auth.challenge:ip:203.0.113.5");
  });

  it("bounds the resulting key length", () => {
    const gen = ipKey("y".repeat(500));
    expect(gen(fakeReq()).length).toBeLessThanOrEqual(200);
  });
});
