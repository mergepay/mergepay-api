/**
 * Issue #658 — the boot-time throttle switch for test suites.
 *
 * The last item in #658's Implementation Guidance is "ensure test environments
 * do not get blocked by overly aggressive rate limits during test runs". Nothing
 * on `main` provided that. Every budget is small and real (the SEP-10 challenge
 * tier is 20/minute, verification 10/minute, the global bucket 100/minute), and
 * a suite cannot dodge them from the client side: the authenticated buckets key
 * on the *user*, so the rotating `remoteAddress` that the IP-keyed tiers force a
 * suite to vary buys nothing for anything else. Measured while writing the
 * treasury multisig DB suite: that file issues 51 requests, 19 of them
 * `POST /api/treasury/proposals`, whose tier is 20/minute — one assertion away
 * from a 429 inside its own run, on a route that was never the subject.
 *
 * So `buildApp()` now takes `rateLimit: "enforced" | "off"`, defaulting to
 * `"enforced"`. Opting out registers no limiter at all, which is only safe
 * because it is a boot-time decision a suite must ask for by name: production
 * callers pass no options, and every limiter suite keeps the default so the
 * enforcement contract below stays under test.
 *
 * This file asserts both halves of that, through the real application:
 *   1. the default instance still exhausts a route's budget and answers the 429
 *      with the standard headers and JSON envelope;
 *   2. an opted-out instance serves the same route far past its tier and stamps
 *      no rate-limit headers, proving nothing was registered;
 *   3. the keying property that makes (1) a hazard for suites — rotating the
 *      client address cannot buy a second budget for one user.
 */
import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { Keypair, Transaction } from "@stellar/stellar-sdk";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(async () => ({})),
    findUnique: vi.fn(async () => null),
    findFirst: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
    update: vi.fn(async () => ({})),
    upsert: vi.fn(async () => ({})),
    count: vi.fn(async () => 0),
  });
  const prisma: any = {
    user: model(),
    auditLog: model(),
    refreshToken: model(),
    idempotencyKey: model(),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $disconnect: vi.fn(),
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

import { buildApp } from "../src/app";
import { config } from "../src/config";
import { globalRateLimitKey } from "../src/plugins/rate-limit";
import { signToken } from "../src/plugins/auth";
import { rateLimitPolicies } from "../src/lib/rate-limit";

const policies = rateLimitPolicies();
const account = Keypair.random().publicKey();

/** `POST /auth/challenge` builds in-process: no database, no Horizon. */
function challenge(app: FastifyInstance, remoteAddress = "203.0.113.60") {
  return app.inject({
    method: "POST",
    url: "/auth/challenge",
    remoteAddress,
    payload: { account },
  });
}

describe("buildApp({ rateLimit }) (#658)", () => {
  it("throttles at the route's tier by default", async () => {
    const app = await buildApp();
    const { max } = policies.authChallenge;

    for (let i = 0; i < max; i++) {
      const res = await challenge(app);
      expect(res.statusCode, `in-budget request ${i + 1} of ${max}`).toBe(200);
    }

    const blocked = await challenge(app);
    expect(blocked.statusCode, `request ${max + 1} crosses the budget`).toBe(429);
    expect(blocked.headers["x-ratelimit-limit"]).toBe(String(max));
    expect(blocked.headers["x-ratelimit-remaining"]).toBe("0");
    expect(blocked.headers["retry-after"]).toBeDefined();
    // The production 429 contract: the standard envelope, not a bare payload.
    expect(blocked.json().error.code).toBe("RATE_LIMITED");

    await app.close();
  });

  it("serves an opted-out suite far past the tier, with no limiter registered", async () => {
    const app = await buildApp({ rateLimit: "off" });
    const { max } = policies.authChallenge;

    for (let i = 0; i < max * 3; i++) {
      const res = await challenge(app);
      expect(res.statusCode, `request ${i + 1} was throttled by the opt-out app`).toBe(200);
      // Absent headers are the evidence that nothing was registered, rather
      // than a limiter whose budget happens not to be spent.
      expect(res.headers["x-ratelimit-limit"]).toBeUndefined();
      expect(res.headers["x-ratelimit-remaining"]).toBeUndefined();
    }

    await app.close();
  });

  it("removes throttling only, not any part of the reply", async () => {
    const enforcedApp = await buildApp();
    const bypassedApp = await buildApp({ rateLimit: "off" });

    const enforced = await challenge(enforcedApp);
    const bypassed = await challenge(bypassedApp);

    expect([enforced.statusCode, bypassed.statusCode]).toEqual([200, 200]);
    // Only the counters differ: the enforced reply advertises its budget and the
    // opted-out one has none to advertise.
    expect(enforced.headers["x-ratelimit-limit"]).toBe(String(policies.authChallenge.max));
    expect(bypassed.headers["x-ratelimit-limit"]).toBeUndefined();

    // The bodies cannot be compared byte-for-byte — a SEP-10 challenge carries a
    // fresh random nonce on every request, by specification. What must match is
    // the envelope's structure: same account, same sequence, the same operations
    // under the same names, so an opted-out suite is served the real challenge
    // flow and not a stub.
    const shape = (res: { json(): any }) => {
      const body = res.json();
      const tx = new Transaction(body.transaction, config.networkPassphrase);
      return {
        networkPassphrase: body.networkPassphrase,
        source: tx.source,
        sequence: tx.sequence,
        operations: tx.operations.map((op: any) => `${op.type}:${String(op.name)}`),
      };
    };
    expect(shape(bypassed)).toEqual(shape(enforced));

    await enforcedApp.close();
    await bypassedApp.close();
  });

  it("cannot be dodged by varying the client address, which is why suites need it", () => {
    const token = signToken({ id: "usr_658", stellarPublicKey: account });
    const request = (ip: string) =>
      globalRateLimitKey({ headers: { authorization: `Bearer ${token}` }, ip } as any);

    // One budget per user, wherever the requests come from: three addresses are
    // still one bucket, so a suite that rotates `remoteAddress` for the IP-keyed
    // tiers gains nothing on the global one.
    expect(new Set(["10.0.0.1", "10.0.0.2", "10.0.0.3"].map(request))).toEqual(
      new Set(["global:user:usr_658"])
    );
  });
});
