import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const loadAccount = vi.fn();
  const prisma: any = {
    groupMember: {
      findMany: vi.fn(async () => []),
      // requireMembership reads this before the route body runs.
      findUnique: vi.fn(async () => ({
        groupId: "group_1",
        userId: "user_1",
        role: "member",
      })),
    },
    group: { findUnique: vi.fn(async () => ({ id: "group_1" })) },
    expense: { create: vi.fn() },
    auditLog: { create: vi.fn(async () => ({ id: "audit_1" })) },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
  };
  return { loadAccount, prisma };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));

vi.mock("../../src/services/stellar", async (importActual) => {
  const actual = await importActual<typeof import("../../src/services/stellar")>();
  return {
    ...actual,
    stellar: { ...actual.stellar, loadAccount: h.loadAccount },
  };
});

import {
  assertParticipantsCanHoldAsset,
  fetchTrustlines,
} from "../../src/services/horizon";
import { buildApp } from "../../src/app";
import { signToken } from "../../src/plugins/auth";
import { config } from "../../src/config";
import { TimeoutError } from "../../src/services/timeout";

const prisma = h.prisma;
const loadAccount = h.loadAccount;

const USER_ID = "user_1";
const GROUP_ID = "group_1";
const KEY_A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const KEY_B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

const USDC = config.STABLE_ASSET_CODE;
const USDC_ISSUER = config.STABLE_ASSET_ISSUER;

/** An account that trusts the given assets. */
const account = (
  balances: { assetCode: string; assetIssuer: string | null }[] = []
) => ({
  exists: true,
  sequence: "1",
  balances: balances.map((b) => ({ ...b, balance: "100.0000000" })),
  signers: [],
  thresholds: { low: 0, med: 0, high: 0 },
});

const unfunded = () => ({
  exists: false,
  sequence: "0",
  balances: [],
  signers: [],
  thresholds: { low: 0, med: 0, high: 0 },
});

beforeEach(() => {
  vi.clearAllMocks();
  loadAccount.mockResolvedValue(account([{ assetCode: USDC, assetIssuer: USDC_ISSUER }]));
});

describe("fetchTrustlines", () => {
  it("reports an account that trusts the asset", async () => {
    const result = await fetchTrustlines({
      publicKeys: [KEY_A],
      assetCode: USDC,
      assetIssuer: USDC_ISSUER,
    });

    expect(result).toEqual([
      { publicKey: KEY_A, hasTrustline: true, accountExists: true },
    ]);
  });

  it("reports an account with no trustline for the asset", async () => {
    loadAccount.mockResolvedValue(account([{ assetCode: "XLM", assetIssuer: null }]));

    const [status] = await fetchTrustlines({
      publicKeys: [KEY_A],
      assetCode: USDC,
      assetIssuer: USDC_ISSUER,
    });

    expect(status).toMatchObject({ hasTrustline: false, accountExists: true });
  });

  it("treats an unfunded account as unable to hold the asset", async () => {
    loadAccount.mockResolvedValue(unfunded());

    const [status] = await fetchTrustlines({
      publicKeys: [KEY_A],
      assetCode: USDC,
      assetIssuer: USDC_ISSUER,
    });

    expect(status).toMatchObject({ hasTrustline: false, accountExists: false });
  });

  it("does not match a trustline to a different issuer of the same code", async () => {
    // Two issuers can both mint "USDC"; trusting the wrong one will not settle
    // the payment this expense builds.
    loadAccount.mockResolvedValue(
      account([{ assetCode: USDC, assetIssuer: KEY_B }])
    );

    const [status] = await fetchTrustlines({
      publicKeys: [KEY_A],
      assetCode: USDC,
      assetIssuer: USDC_ISSUER,
    });

    expect(status.hasTrustline).toBe(false);
  });

  it("collapses duplicate keys into one lookup", async () => {
    await fetchTrustlines({
      publicKeys: [KEY_A, KEY_A, KEY_A],
      assetCode: USDC,
      assetIssuer: USDC_ISSUER,
    });

    expect(loadAccount).toHaveBeenCalledTimes(1);
  });

  it("checks several accounts concurrently", async () => {
    loadAccount.mockImplementation(async (key: string) =>
      key === KEY_A
        ? account([{ assetCode: USDC, assetIssuer: USDC_ISSUER }])
        : account([])
    );

    const result = await fetchTrustlines({
      publicKeys: [KEY_A, KEY_B],
      assetCode: USDC,
      assetIssuer: USDC_ISSUER,
    });

    expect(loadAccount).toHaveBeenCalledTimes(2);
    expect(result.find((r) => r.publicKey === KEY_A)?.hasTrustline).toBe(true);
    expect(result.find((r) => r.publicKey === KEY_B)?.hasTrustline).toBe(false);
  });

  it("maps a Horizon failure to a safe upstream error", async () => {
    loadAccount.mockRejectedValue(new TimeoutError("Horizon.loadAccount", 10_000));

    await expect(
      fetchTrustlines({
        publicKeys: [KEY_A],
        assetCode: USDC,
        assetIssuer: USDC_ISSUER,
      })
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("does not leak Horizon's own response into the error", async () => {
    loadAccount.mockRejectedValue(
      Object.assign(new Error(`account ${KEY_A} rate limited, key=secret`), {
        response: { status: 429 },
      })
    );

    await expect(
      fetchTrustlines({
        publicKeys: [KEY_A],
        assetCode: USDC,
        assetIssuer: USDC_ISSUER,
      })
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("fails the whole call rather than returning a partial answer", async () => {
    // A partial result would report "everyone has a trustline" while one
    // account was never actually checked.
    loadAccount.mockImplementation(async (key: string) => {
      if (key === KEY_B) throw new TimeoutError("Horizon.loadAccount", 10_000);
      return account([{ assetCode: USDC, assetIssuer: USDC_ISSUER }]);
    });

    await expect(
      fetchTrustlines({
        publicKeys: [KEY_A, KEY_B],
        assetCode: USDC,
        assetIssuer: USDC_ISSUER,
      })
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });
});

describe("assertParticipantsCanHoldAsset", () => {
  const participants = [
    { userId: "user_1", stellarPublicKey: KEY_A },
    { userId: "user_2", stellarPublicKey: KEY_B },
  ];

  it("passes when every participant trusts the asset", async () => {
    await expect(
      assertParticipantsCanHoldAsset({
        participants,
        assetCode: USDC,
        assetIssuer: USDC_ISSUER,
      })
    ).resolves.toBeUndefined();
  });

  it("names every participant missing a trustline, not just the first", async () => {
    loadAccount.mockResolvedValue(account([]));

    const error = await assertParticipantsCanHoldAsset({
      participants,
      assetCode: USDC,
      assetIssuer: USDC_ISSUER,
    }).catch((e) => e);

    expect(error.code).toBe("MISSING_TRUSTLINES");
    expect(error.details.missing).toHaveLength(2);
    expect(error.details.missing.map((m: any) => m.userId).sort()).toEqual([
      "user_1",
      "user_2",
    ]);
  });

  it("distinguishes an unfunded account from a missing trustline", async () => {
    loadAccount.mockImplementation(async (key: string) =>
      key === KEY_A ? unfunded() : account([])
    );

    const error = await assertParticipantsCanHoldAsset({
      participants,
      assetCode: USDC,
      assetIssuer: USDC_ISSUER,
    }).catch((e) => e);

    const byUser = Object.fromEntries(
      error.details.missing.map((m: any) => [m.userId, m.reason])
    );
    expect(byUser).toEqual({
      user_1: "account_not_found",
      user_2: "no_trustline",
    });
  });

  it("does nothing when there are no participants", async () => {
    await assertParticipantsCanHoldAsset({
      participants: [],
      assetCode: USDC,
      assetIssuer: USDC_ISSUER,
    });

    expect(loadAccount).not.toHaveBeenCalled();
  });
});

describe("POST /groups/:id/expenses — trustline validation", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  function authHeader() {
    const token = signToken({ id: USER_ID, stellarPublicKey: KEY_A });
    return { authorization: `Bearer ${token}` };
  }

  function createExpense(body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/groups/${GROUP_ID}/expenses`,
      headers: authHeader(),
      payload: {
        title: "Dinner",
        amount: "20.0000000",
        splitType: "equal",
        shares: [{ userId: USER_ID }, { userId: "user_2" }],
        ...body,
      },
    });
  }

  beforeEach(async () => {
    if (!app) app = await buildApp();

    // clearAllMocks above wipes the hoisted implementations, so the membership
    // lookup the route's preHandler depends on is re-established here.
    prisma.groupMember.findUnique.mockResolvedValue({
      groupId: GROUP_ID,
      userId: USER_ID,
      role: "member",
    });
    prisma.group.findUnique.mockResolvedValue({ id: GROUP_ID });

    prisma.groupMember.findMany.mockImplementation(async ({ select }: any) =>
      select?.user
        ? [
            { userId: USER_ID, user: { stellarPublicKey: KEY_A } },
            { userId: "user_2", user: { stellarPublicKey: KEY_B } },
          ]
        : [{ userId: USER_ID }, { userId: "user_2" }]
    );

    prisma.expense.create.mockResolvedValue({
      id: "expense_1",
      groupId: GROUP_ID,
      payerUserId: USER_ID,
      title: "Dinner",
      description: null,
      amount: "20.0000000",
      assetCode: USDC,
      assetIssuer: USDC_ISSUER,
      splitType: "equal",
      memo: "ABC123",
      receiptUrl: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      payer: { id: USER_ID, stellarPublicKey: KEY_A, createdAt: new Date() },
      shares: [],
    });
  });

  it("rejects a non-XLM expense when a member lacks the trustline", async () => {
    loadAccount.mockImplementation(async (key: string) =>
      key === KEY_A
        ? account([{ assetCode: USDC, assetIssuer: USDC_ISSUER }])
        : account([])
    );

    const res = await createExpense({
      assetCode: USDC,
      assetIssuer: USDC_ISSUER,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe("MISSING_TRUSTLINES");
    expect(body.details.missing[0].userId).toBe("user_2");
    // Rejected before anything was written.
    expect(prisma.expense.create).not.toHaveBeenCalled();
  });

  it("creates the expense when every member trusts the asset", async () => {
    loadAccount.mockResolvedValue(
      account([{ assetCode: USDC, assetIssuer: USDC_ISSUER }])
    );

    const res = await createExpense({
      assetCode: USDC,
      assetIssuer: USDC_ISSUER,
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.expense.create).toHaveBeenCalled();
  });

  it("skips the Horizon round trip entirely for native XLM", async () => {
    const res = await createExpense({ assetCode: "XLM" });

    expect(res.statusCode).toBe(200);
    // XLM needs no trustline, so paying for a lookup would be pure latency.
    expect(loadAccount).not.toHaveBeenCalled();
  });

  it("returns an upstream error when Horizon is unavailable", async () => {
    loadAccount.mockRejectedValue(new TimeoutError("Horizon.loadAccount", 10_000));

    const res = await createExpense({
      assetCode: USDC,
      assetIssuer: USDC_ISSUER,
    });

    // Fails closed: allowing the expense here would defeat the check exactly
    // when the network is least healthy.
    expect(res.statusCode).toBe(502);
    expect(prisma.expense.create).not.toHaveBeenCalled();
  });
});
