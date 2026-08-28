import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(async () => []),
    update: vi.fn(),
    upsert: vi.fn(),
  });
  const prisma: any = {
    group: model(),
    accountBalance: model(),
    auditLog: model(),
  };
  const loadAccountMock = vi.fn();
  return { prisma, loadAccountMock };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

vi.mock("../src/services/stellar", () => ({
  stellar: {
    loadAccount: h.loadAccountMock,
  },
}));

vi.mock("../src/config", () => ({
  config: {
    STABLE_ASSET_CODE: "USDC",
    STABLE_ASSET_ISSUER: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    isTest: true,
  },
}));

vi.mock("../src/services/audit", () => ({
  audit: vi.fn(),
}));

import {
  reconcileTreasuryBalance,
  reconcileAllTreasuryBalances,
  normalizeBalance,
} from "../src/services/treasuryService";
import { audit } from "../src/services/audit";
import { config } from "../src/config";

const prisma = h.prisma;
const loadAccountMock = h.loadAccountMock;
const mockAudit = vi.mocked(audit);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGroup(over: Record<string, any> = {}) {
  return {
    id: "group_1",
    treasuryEnabled: true,
    treasuryAccountPublicKey: "GABC...",
    ...over,
  };
}

function makeSnapshot(balances: { assetCode: string; assetIssuer: string | null; balance: string }[]) {
  return {
    exists: true,
    sequence: "1",
    balances,
    signers: [],
    thresholds: { low: 1, med: 2, high: 3 },
  };
}

function makeCachedBalance(assetCode: string, balance: string) {
  return {
    id: `bal_${assetCode}`,
    accountId: "GABC...",
    assetCode,
    balance,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  prisma.accountBalance.update.mockResolvedValue({});
  prisma.accountBalance.upsert.mockResolvedValue({});
});

describe("normalizeBalance", () => {
  it("pads fractional part to 7 digits", () => {
    expect(normalizeBalance("10.5")).toBe("10.5000000");
  });

  it("trims fractional part to 7 digits", () => {
    expect(normalizeBalance("10.123456789")).toBe("10.1234567");
  });

  it("handles integer values", () => {
    expect(normalizeBalance("100")).toBe("100.0000000");
  });

  it("handles zero", () => {
    expect(normalizeBalance("0")).toBe("0.0000000");
  });

  it("handles values with no integer part", () => {
    // Stellar Horizon always returns "0.xxxx" not ".xxxx", but verify the function handles it
    expect(normalizeBalance("0.5")).toBe("0.5000000");
  });
});

describe("reconcileTreasuryBalance", () => {
  it("skips when treasury is not found", async () => {
    prisma.group.findUnique.mockResolvedValue(null);

    const result = await reconcileTreasuryBalance("nonexistent");

    expect(result).toEqual({ compared: 0, variances: 0 });
    expect(loadAccountMock).not.toHaveBeenCalled();
  });

  it("skips when treasury is not enabled", async () => {
    prisma.group.findUnique.mockResolvedValue(
      makeGroup({ treasuryEnabled: false })
    );

    const result = await reconcileTreasuryBalance("group_1");

    expect(result).toEqual({ compared: 0, variances: 0 });
    expect(loadAccountMock).not.toHaveBeenCalled();
  });

  it("skips when treasury has no public key", async () => {
    prisma.group.findUnique.mockResolvedValue(
      makeGroup({ treasuryAccountPublicKey: null })
    );

    const result = await reconcileTreasuryBalance("group_1");

    expect(result).toEqual({ compared: 0, variances: 0 });
    expect(loadAccountMock).not.toHaveBeenCalled();
  });

  it("skips when account not found on Stellar", async () => {
    prisma.group.findUnique.mockResolvedValue(makeGroup());
    loadAccountMock.mockResolvedValue({
      exists: false,
      sequence: "0",
      balances: [],
      signers: [],
      thresholds: { low: 0, med: 0, high: 0 },
    });

    const result = await reconcileTreasuryBalance("group_1");

    expect(result).toEqual({ compared: 0, variances: 0 });
  });

  it("reconciles matching XLM and USDC balances", async () => {
    prisma.group.findUnique.mockResolvedValue(makeGroup());
    loadAccountMock.mockResolvedValue(
      makeSnapshot([
        { assetCode: "XLM", assetIssuer: null, balance: "100.0000000" },
        {
          assetCode: config.STABLE_ASSET_CODE,
          assetIssuer: config.STABLE_ASSET_ISSUER,
          balance: "50.0000000",
        },
      ])
    );
    prisma.accountBalance.findUnique
      .mockResolvedValueOnce(makeCachedBalance("XLM", "100.0000000"))
      .mockResolvedValueOnce(
        makeCachedBalance(config.STABLE_ASSET_CODE, "50.0000000")
      );

    const result = await reconcileTreasuryBalance("group_1");

    expect(result).toEqual({ compared: 2, variances: 0 });
    expect(mockAudit).not.toHaveBeenCalled();
    expect(prisma.accountBalance.update).toHaveBeenCalledTimes(2);
  });

  it("detects XLM variance and updates cache + creates audit", async () => {
    prisma.group.findUnique.mockResolvedValue(makeGroup());
    loadAccountMock.mockResolvedValue(
      makeSnapshot([
        { assetCode: "XLM", assetIssuer: null, balance: "120.5000000" },
        {
          assetCode: config.STABLE_ASSET_CODE,
          assetIssuer: config.STABLE_ASSET_ISSUER,
          balance: "50.0000000",
        },
      ])
    );
    prisma.accountBalance.findUnique
      .mockResolvedValueOnce(makeCachedBalance("XLM", "100.0000000"))
      .mockResolvedValueOnce(
        makeCachedBalance(config.STABLE_ASSET_CODE, "50.0000000")
      );

    const result = await reconcileTreasuryBalance("group_1");

    expect(result).toEqual({ compared: 2, variances: 1 });
    expect(prisma.accountBalance.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          accountId_assetCode: { accountId: "GABC...", assetCode: "XLM" },
        },
        update: expect.objectContaining({ balance: "120.5000000" }),
      })
    );
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: "group_1",
        action: "treasury.balance_variance",
        entityType: "AccountBalance",
        metadata: expect.objectContaining({
          assetCode: "XLM",
          cachedBalance: "100.0000000",
          onChainBalance: "120.5000000",
        }),
      })
    );
  });

  it("detects USDC variance and updates cache + creates audit", async () => {
    prisma.group.findUnique.mockResolvedValue(makeGroup());
    loadAccountMock.mockResolvedValue(
      makeSnapshot([
        { assetCode: "XLM", assetIssuer: null, balance: "100.0000000" },
        {
          assetCode: config.STABLE_ASSET_CODE,
          assetIssuer: config.STABLE_ASSET_ISSUER,
          balance: "75.2500000",
        },
      ])
    );
    prisma.accountBalance.findUnique
      .mockResolvedValueOnce(makeCachedBalance("XLM", "100.0000000"))
      .mockResolvedValueOnce(
        makeCachedBalance(config.STABLE_ASSET_CODE, "50.0000000")
      );

    const result = await reconcileTreasuryBalance("group_1");

    expect(result).toEqual({ compared: 2, variances: 1 });
    expect(prisma.accountBalance.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          accountId_assetCode: {
            accountId: "GABC...",
            assetCode: config.STABLE_ASSET_CODE,
          },
        },
        update: expect.objectContaining({ balance: "75.2500000" }),
      })
    );
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: "group_1",
        action: "treasury.balance_variance",
        metadata: expect.objectContaining({
          assetCode: config.STABLE_ASSET_CODE,
          cachedBalance: "50.0000000",
          onChainBalance: "75.2500000",
        }),
      })
    );
  });

  it("detects both assets differing", async () => {
    prisma.group.findUnique.mockResolvedValue(makeGroup());
    loadAccountMock.mockResolvedValue(
      makeSnapshot([
        { assetCode: "XLM", assetIssuer: null, balance: "200.0000000" },
        {
          assetCode: config.STABLE_ASSET_CODE,
          assetIssuer: config.STABLE_ASSET_ISSUER,
          balance: "99.9900000",
        },
      ])
    );
    prisma.accountBalance.findUnique
      .mockResolvedValueOnce(makeCachedBalance("XLM", "100.0000000"))
      .mockResolvedValueOnce(
        makeCachedBalance(config.STABLE_ASSET_CODE, "50.0000000")
      );

    const result = await reconcileTreasuryBalance("group_1");

    expect(result).toEqual({ compared: 2, variances: 2 });
    expect(mockAudit).toHaveBeenCalledTimes(2);
    expect(prisma.accountBalance.upsert).toHaveBeenCalledTimes(2);
  });

  it("ignores missing cached balances (creates new records)", async () => {
    prisma.group.findUnique.mockResolvedValue(makeGroup());
    loadAccountMock.mockResolvedValue(
      makeSnapshot([
        { assetCode: "XLM", assetIssuer: null, balance: "100.0000000" },
        {
          assetCode: config.STABLE_ASSET_CODE,
          assetIssuer: config.STABLE_ASSET_ISSUER,
          balance: "50.0000000",
        },
      ])
    );
    prisma.accountBalance.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    const result = await reconcileTreasuryBalance("group_1");

    expect(result).toEqual({ compared: 2, variances: 2 });
    expect(prisma.accountBalance.upsert).toHaveBeenCalledTimes(2);
    expect(mockAudit).toHaveBeenCalledTimes(2);
  });

  it("ignores non-USDC trustlines", async () => {
    prisma.group.findUnique.mockResolvedValue(makeGroup());
    loadAccountMock.mockResolvedValue(
      makeSnapshot([
        { assetCode: "XLM", assetIssuer: null, balance: "100.0000000" },
        {
          assetCode: "EURC",
          assetIssuer: "GsomeOtherIssuer...",
          balance: "25.0000000",
        },
        {
          assetCode: config.STABLE_ASSET_CODE,
          assetIssuer: config.STABLE_ASSET_ISSUER,
          balance: "50.0000000",
        },
      ])
    );
    prisma.accountBalance.findUnique
      .mockResolvedValueOnce(makeCachedBalance("XLM", "100.0000000"))
      .mockResolvedValueOnce(
        makeCachedBalance(config.STABLE_ASSET_CODE, "50.0000000")
      );

    const result = await reconcileTreasuryBalance("group_1");

    // Only XLM and USDC are compared; EURC is ignored.
    expect(result).toEqual({ compared: 2, variances: 0 });
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it("ignores USDC trustline with wrong issuer", async () => {
    prisma.group.findUnique.mockResolvedValue(makeGroup());
    loadAccountMock.mockResolvedValue(
      makeSnapshot([
        { assetCode: "XLM", assetIssuer: null, balance: "100.0000000" },
        {
          assetCode: "USDC",
          assetIssuer: "GWrongIssuer...",
          balance: "50.0000000",
        },
      ])
    );
    prisma.accountBalance.findUnique
      .mockResolvedValueOnce(makeCachedBalance("XLM", "100.0000000"))
      .mockResolvedValueOnce(null);

    const result = await reconcileTreasuryBalance("group_1");

    // USDC with wrong issuer is not matched → treated as missing → variance
    expect(result).toEqual({ compared: 2, variances: 1 });
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          assetCode: config.STABLE_ASSET_CODE,
          cachedBalance: null,
          onChainBalance: "0",
        }),
      })
    );
  });

  it("handles Horizon/network errors gracefully", async () => {
    prisma.group.findUnique.mockResolvedValue(makeGroup());
    loadAccountMock.mockRejectedValue(
      new Error("Horizon request failed: connection timeout")
    );

    await expect(reconcileTreasuryBalance("group_1")).rejects.toThrow(
      "Horizon request failed: connection timeout"
    );
  });

  it("treats missing XLM balance as zero", async () => {
    prisma.group.findUnique.mockResolvedValue(makeGroup());
    loadAccountMock.mockResolvedValue(
      makeSnapshot([
        {
          assetCode: config.STABLE_ASSET_CODE,
          assetIssuer: config.STABLE_ASSET_ISSUER,
          balance: "50.0000000",
        },
      ])
    );
    prisma.accountBalance.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    const result = await reconcileTreasuryBalance("group_1");

    expect(result).toEqual({ compared: 2, variances: 2 });
    // XLM on-chain is "0" (no trustline), cached is null → variance
    expect(prisma.accountBalance.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          accountId_assetCode: { accountId: "GABC...", assetCode: "XLM" },
        },
        create: expect.objectContaining({ balance: "0" }),
      })
    );
  });

  it("handles fractional balance differences correctly", async () => {
    prisma.group.findUnique.mockResolvedValue(makeGroup());
    loadAccountMock.mockResolvedValue(
      makeSnapshot([
        { assetCode: "XLM", assetIssuer: null, balance: "100.0000001" },
        {
          assetCode: config.STABLE_ASSET_CODE,
          assetIssuer: config.STABLE_ASSET_ISSUER,
          balance: "50.0000000",
        },
      ])
    );
    prisma.accountBalance.findUnique
      .mockResolvedValueOnce(makeCachedBalance("XLM", "100.0000000"))
      .mockResolvedValueOnce(
        makeCachedBalance(config.STABLE_ASSET_CODE, "50.0000000")
      );

    const result = await reconcileTreasuryBalance("group_1");

    // 100.0000001 vs 100.0000000 → variance detected at stroops precision
    expect(result).toEqual({ compared: 2, variances: 1 });
  });
});

describe("reconcileAllTreasuryBalances", () => {
  it("reconciles all enabled treasuries", async () => {
    prisma.group.findMany.mockResolvedValue([
      { id: "g1" },
      { id: "g2" },
    ]);
    // For each treasury, mock the full flow
    prisma.group.findUnique
      .mockResolvedValueOnce(makeGroup({ id: "g1", treasuryAccountPublicKey: "G1..." }))
      .mockResolvedValueOnce(makeGroup({ id: "g2", treasuryAccountPublicKey: "G2..." }));

    loadAccountMock
      .mockResolvedValueOnce(
        makeSnapshot([
          { assetCode: "XLM", assetIssuer: null, balance: "100.0000000" },
          {
            assetCode: config.STABLE_ASSET_CODE,
            assetIssuer: config.STABLE_ASSET_ISSUER,
            balance: "50.0000000",
          },
        ])
      )
      .mockResolvedValueOnce(
        makeSnapshot([
          { assetCode: "XLM", assetIssuer: null, balance: "200.0000000" },
          {
            assetCode: config.STABLE_ASSET_CODE,
            assetIssuer: config.STABLE_ASSET_ISSUER,
            balance: "75.0000000",
          },
        ])
      );

    // Both treasuries have matching cached balances
    prisma.accountBalance.findUnique
      .mockResolvedValueOnce(makeCachedBalance("XLM", "100.0000000"))
      .mockResolvedValueOnce(
        makeCachedBalance(config.STABLE_ASSET_CODE, "50.0000000")
      )
      .mockResolvedValueOnce(makeCachedBalance("XLM", "200.0000000"))
      .mockResolvedValueOnce(
        makeCachedBalance(config.STABLE_ASSET_CODE, "75.0000000")
      );

    const result = await reconcileAllTreasuryBalances();

    expect(result).toEqual({ reconciled: 2, variances: 0, errors: 0 });
  });

  it("returns zero when no enabled treasuries", async () => {
    prisma.group.findMany.mockResolvedValue([]);

    const result = await reconcileAllTreasuryBalances();

    expect(result).toEqual({ reconciled: 0, variances: 0, errors: 0 });
  });

  it("continues to next treasury after one fails", async () => {
    prisma.group.findMany.mockResolvedValue([
      { id: "g1" },
      { id: "g2" },
    ]);
    prisma.group.findUnique
      .mockResolvedValueOnce(makeGroup({ id: "g1" }))
      .mockResolvedValueOnce(makeGroup({ id: "g2" }));

    // g1 fails
    loadAccountMock
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce(
        makeSnapshot([
          { assetCode: "XLM", assetIssuer: null, balance: "100.0000000" },
          {
            assetCode: config.STABLE_ASSET_CODE,
            assetIssuer: config.STABLE_ASSET_ISSUER,
            balance: "50.0000000",
          },
        ])
      );

    prisma.accountBalance.findUnique
      .mockResolvedValueOnce(makeCachedBalance("XLM", "100.0000000"))
      .mockResolvedValueOnce(
        makeCachedBalance(config.STABLE_ASSET_CODE, "50.0000000")
      );

    const result = await reconcileAllTreasuryBalances();

    expect(result).toEqual({ reconciled: 1, variances: 0, errors: 1 });
  });

  it("counts variances across all treasuries", async () => {
    prisma.group.findMany.mockResolvedValue([
      { id: "g1" },
      { id: "g2" },
    ]);
    prisma.group.findUnique
      .mockResolvedValueOnce(makeGroup({ id: "g1" }))
      .mockResolvedValueOnce(makeGroup({ id: "g2" }));

    loadAccountMock
      .mockResolvedValueOnce(
        makeSnapshot([
          { assetCode: "XLM", assetIssuer: null, balance: "200.0000000" },
          {
            assetCode: config.STABLE_ASSET_CODE,
            assetIssuer: config.STABLE_ASSET_ISSUER,
            balance: "50.0000000",
          },
        ])
      )
      .mockResolvedValueOnce(
        makeSnapshot([
          { assetCode: "XLM", assetIssuer: null, balance: "300.0000000" },
          {
            assetCode: config.STABLE_ASSET_CODE,
            assetIssuer: config.STABLE_ASSET_ISSUER,
            balance: "75.0000000",
          },
        ])
      );

    // g1: XLM differs
    prisma.accountBalance.findUnique
      .mockResolvedValueOnce(makeCachedBalance("XLM", "100.0000000"))
      .mockResolvedValueOnce(
        makeCachedBalance(config.STABLE_ASSET_CODE, "50.0000000")
      );
    // g2: both differ
    prisma.accountBalance.findUnique
      .mockResolvedValueOnce(makeCachedBalance("XLM", "100.0000000"))
      .mockResolvedValueOnce(
        makeCachedBalance(config.STABLE_ASSET_CODE, "50.0000000")
      );

    const result = await reconcileAllTreasuryBalances();

    expect(result).toEqual({ reconciled: 2, variances: 3, errors: 0 });
  });
});
