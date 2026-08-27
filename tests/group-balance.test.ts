import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

const h = vi.hoisted(() => {
  const model = () => ({ findUnique: vi.fn(), findMany: vi.fn(async () => []) });
  const prisma: any = {
    group: model(),
    groupMember: model(),
    user: model(),
    $transaction: vi.fn(async (arg: any) => typeof arg === "function" ? arg(prisma) : Promise.all(arg)),
    $disconnect: vi.fn(),
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

const loadAccount = vi.hoisted(() => vi.fn());
vi.mock("../src/services/stellar", () => ({ stellar: { loadAccount } }));

import { buildApp } from "../src/app";
import { clearGroupBalanceCache } from "../src/routes/groups";
import { signToken } from "../src/plugins/auth";
import { config } from "../src/config";

const prisma = h.prisma;
const user = { id: "user_1", stellarPublicKey: Keypair.random().publicKey() };
const treasuryKey = Keypair.random().publicKey();

function headers() {
  return { authorization: `Bearer ${signToken({ id: user.id, stellarPublicKey: user.stellarPublicKey })}` };
}

let app: Awaited<ReturnType<typeof buildApp>>;

describe("GET /groups/:id/balance", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    clearGroupBalanceCache();
    if (!app) app = await buildApp();
    prisma.groupMember.findUnique.mockResolvedValue({ groupId: "group_1", userId: user.id, role: "member" });
    prisma.group.findUnique.mockResolvedValue({ treasuryAccountPublicKey: treasuryKey });
    loadAccount.mockResolvedValue({
      exists: true,
      balances: [
        { assetCode: "XLM", assetIssuer: null, balance: "100.5000000" },
        { assetCode: "USDC", assetIssuer: config.STABLE_ASSET_ISSUER, balance: "250.0000000" },
        { assetCode: "OTHER", assetIssuer: Keypair.random().publicKey(), balance: "99" },
      ],
    });
  });

  it("returns XLM and configured USDC balances for a member", async () => {
    const response = await app.inject({ method: "GET", url: "/groups/group_1/balance", headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ balances: [
      { asset: "XLM", balance: "100.5000000" },
      { asset: "USDC", balance: "250.0000000" },
    ] });
  });

  it("denies non-members before reading the group or Horizon", async () => {
    prisma.groupMember.findUnique.mockResolvedValue(null);
    const response = await app.inject({ method: "GET", url: "/groups/group_1/balance", headers: headers() });
    expect(response.statusCode).toBe(403);
    expect(loadAccount).not.toHaveBeenCalled();
  });

  it("returns an empty array for an unfunded treasury account", async () => {
    loadAccount.mockResolvedValue({ exists: false, balances: [] });
    const response = await app.inject({ method: "GET", url: "/groups/group_1/balance", headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ balances: [] });
  });

  it("uses the cached result for requests within 30 seconds", async () => {
    await app.inject({ method: "GET", url: "/groups/group_1/balance", headers: headers() });
    await app.inject({ method: "GET", url: "/groups/group_1/balance", headers: headers() });
    expect(loadAccount).toHaveBeenCalledTimes(1);
  });
});
