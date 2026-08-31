/**
 * POST /auth/refresh — the HTTP contract around token rotation (#262).
 *
 * The rotation logic itself is covered in tests/refresh-token.test.ts. These
 * tests are about what the endpoint returns: that a refresh yields a usable
 * session, that every failure looks identical from outside, and that logout
 * actually invalidates the refresh chain.
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

vi.mock("../../src/db", () => ({ prisma: h.prisma }));

import { buildApp } from "../../src/app";
import { signToken, verifyToken } from "../../src/plugins/auth";
import { generateToken, hashToken } from "../../src/services/refresh-token";

const prisma = h.prisma;
let app: Awaited<ReturnType<typeof buildApp>>;

const USER_ID = "user_1";
const PUBLIC_KEY = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const FAMILY = "fam_1";

function fakeUser() {
  return {
    id: USER_ID,
    stellarPublicKey: PUBLIC_KEY,
    displayName: "Tester",
    avatarUrl: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function storedToken(over: Record<string, unknown> = {}) {
  return {
    id: "rt_1",
    tokenHash: "hash",
    familyId: FAMILY,
    userId: USER_ID,
    expiresAt: new Date("2099-01-01T00:00:00Z"),
    createdAt: new Date("2026-01-01T00:00:00Z"),
    rotatedAt: null,
    revokedAt: null,
    ...over,
  };
}

function refresh(refreshToken: string) {
  return app.inject({
    method: "POST",
    url: "/auth/refresh",
    payload: { refreshToken },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  app = await buildApp();
  prisma.user.findUnique.mockResolvedValue(fakeUser());
  prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
  prisma.refreshToken.create.mockImplementation(async ({ data }: any) => ({
    ...storedToken(),
    ...data,
  }));
});

describe("POST /auth/refresh — success", () => {
  it("returns a new access token and a new refresh token", async () => {
    prisma.refreshToken.findUnique.mockResolvedValue(storedToken());
    const { token } = generateToken();

    const res = await refresh(token);
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(body.token).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    expect(body.refreshToken).not.toBe(token);
    expect(body.user.id).toBe(USER_ID);
  });

  it("returns an access token that authenticates as the same user", async () => {
    prisma.refreshToken.findUnique.mockResolvedValue(storedToken());
    const { token } = generateToken();

    const body = (await refresh(token)).json();

    expect(verifyToken(body.token)).toEqual({
      id: USER_ID,
      stellarPublicKey: PUBLIC_KEY,
    });
  });

  it("returns the new refresh token's expiry", async () => {
    prisma.refreshToken.findUnique.mockResolvedValue(storedToken());
    const { token } = generateToken();

    const body = (await refresh(token)).json();

    expect(new Date(body.refreshTokenExpiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("never echoes the presented token back", async () => {
    prisma.refreshToken.findUnique.mockResolvedValue(storedToken());
    const { token } = generateToken();

    const res = await refresh(token);

    expect(res.body).not.toContain(token);
  });
});

describe("POST /auth/refresh — rejections are indistinguishable", () => {
  const cases: Array<[string, () => void]> = [
    ["unknown token", () => prisma.refreshToken.findUnique.mockResolvedValue(null)],
    [
      "expired token",
      () =>
        prisma.refreshToken.findUnique.mockResolvedValue(
          storedToken({ expiresAt: new Date("2020-01-01T00:00:00Z") })
        ),
    ],
    [
      "revoked token",
      () =>
        prisma.refreshToken.findUnique.mockResolvedValue(
          storedToken({ revokedAt: new Date("2026-01-02T00:00:00Z") })
        ),
    ],
    [
      "reused token",
      () =>
        prisma.refreshToken.findUnique.mockResolvedValue(
          storedToken({ rotatedAt: new Date("2026-01-02T00:00:00Z") })
        ),
    ],
  ];

  for (const [name, arrange] of cases) {
    it(`returns 401 for an ${name}`, async () => {
      arrange();
      const { token } = generateToken();

      const res = await refresh(token);

      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe("UNAUTHORIZED");
    });
  }

  it("returns the same code, message, and status for every failure mode", async () => {
    const shapes: string[] = [];
    for (const [, arrange] of cases) {
      vi.clearAllMocks();
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
      arrange();
      const res = await refresh(generateToken().token);
      const { code, message } = res.json();
      // requestId is per-request by design, so it is excluded — everything a
      // caller could use to tell one failure from another is compared.
      shapes.push(JSON.stringify({ status: res.statusCode, code, message }));
    }

    // A caller must not be able to tell an expired token from a stolen one.
    expect(new Set(shapes).size).toBe(1);
  });

  it("rejects a malformed token with the same 401", async () => {
    const res = await refresh("not-a-real-token");

    expect(res.statusCode).toBe(401);
    expect(prisma.refreshToken.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a missing refreshToken field as a validation error", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
  });
});

describe("POST /auth/refresh — reuse detection", () => {
  it("revokes the family when a rotated token is replayed", async () => {
    prisma.refreshToken.findUnique.mockResolvedValue(
      storedToken({ rotatedAt: new Date("2026-01-02T00:00:00Z") })
    );

    await refresh(generateToken().token);

    const revocation = prisma.refreshToken.updateMany.mock.calls[0][0];
    expect(revocation.where.familyId).toBe(FAMILY);
  });

  it("issues nothing when reuse is detected", async () => {
    prisma.refreshToken.findUnique.mockResolvedValue(
      storedToken({ rotatedAt: new Date("2026-01-02T00:00:00Z") })
    );

    await refresh(generateToken().token);

    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
  });

  it("records an audit entry without storing the token", async () => {
    prisma.refreshToken.findUnique.mockResolvedValue(
      storedToken({ rotatedAt: new Date("2026-01-02T00:00:00Z") })
    );
    const { token } = generateToken();

    await refresh(token);

    const entries = prisma.auditLog.create.mock.calls.map((c: any) =>
      JSON.stringify(c[0])
    );
    const reuse = entries.find((e: string) => e.includes("reuse_detected"));
    expect(reuse).toBeDefined();
    expect(reuse).not.toContain(token);
    expect(reuse).not.toContain(hashToken(token));
  });
});

describe("POST /auth/logout", () => {
  it("revokes the caller's live refresh tokens", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: {
        authorization: `Bearer ${signToken({ id: USER_ID, stellarPublicKey: PUBLIC_KEY })}`,
      },
    });

    expect(res.statusCode).toBe(200);
    const { where } = prisma.refreshToken.updateMany.mock.calls[0][0];
    expect(where).toMatchObject({ userId: USER_ID, revokedAt: null });
  });

  it("succeeds without a token and revokes nothing", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/logout" });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it("does not reveal whether an invalid token was valid", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { authorization: "Bearer not-a-jwt" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });
});
