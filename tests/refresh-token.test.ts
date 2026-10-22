/**
 * Refresh-token rotation (#262).
 *
 * The properties under test are the security ones: a token works exactly once,
 * reusing one cuts off the whole session, and every rejection looks the same
 * from outside.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const refreshToken = {
    create: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  };
  const prisma: any = {
    refreshToken,
    user: { findUnique: vi.fn(), upsert: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

import {
  RefreshTokenError,
  classifyStored,
  generateToken,
  hashToken,
  hashesEqual,
  isWellFormedToken,
  issueRefreshToken,
  revokeAllForUser,
  revokeFamily,
  rotateRefreshToken,
} from "../src/services/refresh-token";

const prisma = h.prisma;
const NOW = new Date("2026-06-01T12:00:00Z");
const USER_ID = "user_1";
const FAMILY = "fam_1";

function storedToken(over: Record<string, unknown> = {}) {
  return {
    id: "rt_1",
    tokenHash: "hash",
    familyId: FAMILY,
    userId: USER_ID,
    expiresAt: new Date("2026-07-01T12:00:00Z"),
    createdAt: new Date("2026-06-01T00:00:00Z"),
    rotatedAt: null,
    revokedAt: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.refreshToken.create.mockImplementation(async ({ data }: any) => ({
    ...storedToken(),
    ...data,
  }));
  prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
});

describe("token generation", () => {
  it("produces a distinct token each time", () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateToken().token));
    expect(seen.size).toBe(50);
  });

  it("stores only the hash, never the token", () => {
    const { token, tokenHash } = generateToken();
    expect(tokenHash).not.toContain(token);
    expect(tokenHash).toBe(hashToken(token));
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts its own tokens as well-formed", () => {
    for (let i = 0; i < 20; i++) {
      expect(isWellFormedToken(generateToken().token)).toBe(true);
    }
  });

  it("rejects tokens that are not the expected shape", () => {
    expect(isWellFormedToken("")).toBe(false);
    expect(isWellFormedToken("short")).toBe(false);
    expect(isWellFormedToken("has spaces in it aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(false);
    expect(isWellFormedToken("has/slash+plus" + "a".repeat(40))).toBe(false);
  });
});

describe("hashesEqual", () => {
  it("matches identical hashes and rejects different ones", () => {
    const a = hashToken("one");
    expect(hashesEqual(a, hashToken("one"))).toBe(true);
    expect(hashesEqual(a, hashToken("two"))).toBe(false);
  });

  it("returns false for different lengths rather than throwing", () => {
    expect(hashesEqual("abc", "abcd")).toBe(false);
  });
});

describe("classifyStored", () => {
  it("accepts a live token", () => {
    expect(classifyStored(storedToken(), NOW)).toBeNull();
  });

  it("reports an unknown token", () => {
    expect(classifyStored(null, NOW)).toBe("unknown");
  });

  it("reports an expired token", () => {
    expect(
      classifyStored(storedToken({ expiresAt: new Date("2026-05-01T00:00:00Z") }), NOW)
    ).toBe("expired");
  });

  it("reports a revoked token", () => {
    expect(classifyStored(storedToken({ revokedAt: NOW }), NOW)).toBe("revoked");
  });

  it("reports reuse ahead of expiry", () => {
    // An expired token that was already rotated is still evidence of theft,
    // so it must classify as reuse and trigger family revocation.
    const replayed = storedToken({
      rotatedAt: new Date("2026-05-15T00:00:00Z"),
      expiresAt: new Date("2026-05-01T00:00:00Z"),
    });
    expect(classifyStored(replayed, NOW)).toBe("reused");
  });

  it("treats a token expiring exactly now as expired", () => {
    expect(classifyStored(storedToken({ expiresAt: NOW }), NOW)).toBe("expired");
  });
});

describe("issueRefreshToken", () => {
  it("starts a new family per login", async () => {
    await issueRefreshToken(USER_ID, prisma, NOW);
    await issueRefreshToken(USER_ID, prisma, NOW);

    const first = prisma.refreshToken.create.mock.calls[0][0].data.familyId;
    const second = prisma.refreshToken.create.mock.calls[1][0].data.familyId;
    expect(first).not.toBe(second);
  });

  it("persists the hash rather than the token", async () => {
    const issued = await issueRefreshToken(USER_ID, prisma, NOW);
    const { data } = prisma.refreshToken.create.mock.calls[0][0];

    expect(data.tokenHash).toBe(hashToken(issued.token));
    expect(JSON.stringify(data)).not.toContain(issued.token);
  });

  it("sets an expiry in the future", async () => {
    const issued = await issueRefreshToken(USER_ID, prisma, NOW);
    expect(issued.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
  });
});

describe("rotateRefreshToken", () => {
  it("rejects a malformed token without querying", async () => {
    await expect(rotateRefreshToken("nope", NOW)).rejects.toMatchObject({
      reason: "malformed",
    });
    expect(prisma.refreshToken.findUnique).not.toHaveBeenCalled();
  });

  it("rejects an unknown token", async () => {
    prisma.refreshToken.findUnique.mockResolvedValue(null);
    const { token } = generateToken();

    await expect(rotateRefreshToken(token, NOW)).rejects.toMatchObject({
      reason: "unknown",
    });
  });

  it("rejects an expired token", async () => {
    prisma.refreshToken.findUnique.mockResolvedValue(
      storedToken({ expiresAt: new Date("2026-05-01T00:00:00Z") })
    );
    const { token } = generateToken();

    await expect(rotateRefreshToken(token, NOW)).rejects.toMatchObject({
      reason: "expired",
    });
  });

  it("rejects a revoked token", async () => {
    prisma.refreshToken.findUnique.mockResolvedValue(storedToken({ revokedAt: NOW }));
    const { token } = generateToken();

    await expect(rotateRefreshToken(token, NOW)).rejects.toMatchObject({
      reason: "revoked",
    });
  });

  it("looks the token up by hash, never by the raw value", async () => {
    prisma.refreshToken.findUnique.mockResolvedValue(storedToken());
    const { token } = generateToken();

    await rotateRefreshToken(token, NOW);

    const { where } = prisma.refreshToken.findUnique.mock.calls[0][0];
    expect(where.tokenHash).toBe(hashToken(token));
  });

  it("issues a successor in the same family", async () => {
    prisma.refreshToken.findUnique.mockResolvedValue(storedToken());
    const { token } = generateToken();

    const result = await rotateRefreshToken(token, NOW);

    expect(result.userId).toBe(USER_ID);
    expect(result.refresh.familyId).toBe(FAMILY);
    expect(prisma.refreshToken.create.mock.calls[0][0].data.familyId).toBe(FAMILY);
  });

  it("returns a different token than the one presented", async () => {
    prisma.refreshToken.findUnique.mockResolvedValue(storedToken());
    const { token } = generateToken();

    const result = await rotateRefreshToken(token, NOW);

    expect(result.refresh.token).not.toBe(token);
  });

  it("marks the presented token rotated", async () => {
    prisma.refreshToken.findUnique.mockResolvedValue(storedToken());
    const { token } = generateToken();

    await rotateRefreshToken(token, NOW);

    const claim = prisma.refreshToken.updateMany.mock.calls[0][0];
    expect(claim.where).toMatchObject({ id: "rt_1", rotatedAt: null });
    expect(claim.data.rotatedAt).toEqual(NOW);
  });

  it("revokes the whole family when an already-rotated token is presented", async () => {
    prisma.refreshToken.findUnique.mockResolvedValue(
      storedToken({ rotatedAt: new Date("2026-05-20T00:00:00Z") })
    );
    const { token } = generateToken();

    await expect(rotateRefreshToken(token, NOW)).rejects.toMatchObject({
      reason: "reused",
    });

    const revocation = prisma.refreshToken.updateMany.mock.calls[0][0];
    expect(revocation.where).toMatchObject({ familyId: FAMILY, revokedAt: null });
    expect(revocation.data.revokedAt).toEqual(NOW);
  });

  it("does not issue a replacement when reuse is detected", async () => {
    prisma.refreshToken.findUnique.mockResolvedValue(
      storedToken({ rotatedAt: new Date("2026-05-20T00:00:00Z") })
    );
    const { token } = generateToken();

    await expect(rotateRefreshToken(token, NOW)).rejects.toThrow(RefreshTokenError);
    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
  });

  it("treats losing a concurrent rotation race as reuse", async () => {
    prisma.refreshToken.findUnique.mockResolvedValue(storedToken());
    // The conditional claim matched zero rows: another request rotated first.
    prisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });
    const { token } = generateToken();

    await expect(rotateRefreshToken(token, NOW)).rejects.toMatchObject({
      reason: "reused",
    });
    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
  });

  it("rotates inside a transaction so no token is orphaned", async () => {
    prisma.refreshToken.findUnique.mockResolvedValue(storedToken());
    const { token } = generateToken();

    await rotateRefreshToken(token, NOW);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe("revocation", () => {
  it("revokes only unrevoked tokens in a family", async () => {
    await revokeFamily(FAMILY, prisma, NOW);

    const { where } = prisma.refreshToken.updateMany.mock.calls[0][0];
    expect(where).toEqual({ familyId: FAMILY, revokedAt: null });
  });

  it("revokes a user's live tokens on logout without touching spent ones", async () => {
    await revokeAllForUser(USER_ID, prisma, NOW);

    const { where } = prisma.refreshToken.updateMany.mock.calls[0][0];
    expect(where).toEqual({ userId: USER_ID, revokedAt: null, rotatedAt: null });
  });
});
