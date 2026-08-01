/**
 * Balance sync worker — periodically fetches Stellar account balances from Horizon
 * and stores them in the database for quick access.
 */

import pino from "pino";
import { prisma } from "../../db";
import { stellar } from "../../services/stellar";

const log = pino({ name: "balance-sync" });

const DEFAULT_ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_REQUEST_DELAY_MS = 200; // Rate limit protection

interface AccountInfo {
  id: string;
  stellarAccountId: string;
  type: "group" | "treasury" | "user";
}

/**
 * Get all accounts that have been active recently (involved in settlements
 * or treasury transactions within the activity window).
 */
async function getActiveAccounts(windowMs: number): Promise<AccountInfo[]> {
  const cutoff = new Date(Date.now() - windowMs);

  // Get groups with treasury accounts that have recent activity
  const groupsWithTreasury = await prisma.group.findMany({
    where: {
      treasuryEnabled: true,
      treasuryAccountPublicKey: { not: null },
      OR: [
        { expenses: { some: { createdAt: { gte: cutoff } } } },
        { settlements: { some: { createdAt: { gte: cutoff } } } },
        { treasuryTxs: { some: { createdAt: { gte: cutoff } } } },
      ],
    },
    select: {
      id: true,
      treasuryAccountPublicKey: true,
    },
  });

  // Get users who have recent settlements
  const activeUserKeys = await prisma.user.findMany({
    where: {
      OR: [
        { settlementsFrom: { some: { createdAt: { gte: cutoff } } } },
        { settlementsTo: { some: { createdAt: { gte: cutoff } } } },
        { treasuryTxs: { some: { createdAt: { gte: cutoff } } } },
      ],
    },
    select: { id: true, stellarPublicKey: true },
  });

  const accounts: AccountInfo[] = [];

  // Add treasury accounts
  for (const group of groupsWithTreasury) {
    if (group.treasuryAccountPublicKey) {
      accounts.push({
        id: group.id,
        stellarAccountId: group.treasuryAccountPublicKey,
        type: "treasury",
      });
    }
  }

  // Add user accounts (only unique public keys)
  const seenKeys = new Set<string>();
  for (const user of activeUserKeys) {
    if (user.stellarPublicKey && !seenKeys.has(user.stellarPublicKey)) {
      seenKeys.add(user.stellarPublicKey);
      accounts.push({
        id: user.id,
        stellarAccountId: user.stellarPublicKey,
        type: "user",
      });
    }
  }

  return accounts;
}

/**
 * Upsert a balance record into the database.
 */
async function upsertBalance(
  accountId: string,
  assetCode: string,
  balance: string
): Promise<void> {
  await prisma.accountBalance.upsert({
    where: {
      accountId_assetCode: {
        accountId,
        assetCode,
      },
    },
    update: {
      balance: balance,
      updatedAt: new Date(),
    },
    create: {
      accountId,
      assetCode,
      balance: balance,
    },
  });
}

/**
 * Sync balances for a single account.
 */
async function syncAccountBalances(
  account: AccountInfo,
  delayMs: number
): Promise<void> {
  try {
    const snapshot = await stellar.loadAccount(account.stellarAccountId);

    if (!snapshot.exists) {
      log.warn(
        { accountId: account.stellarAccountId, type: account.type },
        "account not found on Stellar network"
      );
      return;
    }

    // Upsert each balance
    for (const bal of snapshot.balances) {
      await upsertBalance(account.stellarAccountId, bal.assetCode, bal.balance);
    }

    log.info(
      {
        accountId: account.stellarAccountId,
        type: account.type,
        balances: snapshot.balances.length,
      },
      "synced account balances"
    );

    // Rate limit protection
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  } catch (error) {
    log.error(
      { err: error, accountId: account.stellarAccountId, type: account.type },
      "failed to sync account balances"
    );
  }
}

/**
 * Main sync function — queries active accounts and syncs their balances.
 */
export async function syncBalances(opts?: {
  activityWindowMs?: number;
  requestDelayMs?: number;
}): Promise<{ synced: number; failed: number }> {
  const activityWindowMs = opts?.activityWindowMs ?? DEFAULT_ACTIVITY_WINDOW_MS;
  const requestDelayMs = opts?.requestDelayMs ?? DEFAULT_REQUEST_DELAY_MS;

  const accounts = await getActiveAccounts(activityWindowMs);

  if (accounts.length === 0) {
    log.debug("no active accounts to sync");
    return { synced: 0, failed: 0 };
  }

  log.info({ count: accounts.length }, "syncing balances for active accounts");

  let synced = 0;
  let failed = 0;

  for (const account of accounts) {
    try {
      await syncAccountBalances(account, requestDelayMs);
      synced++;
    } catch (error) {
      log.error(
        { err: error, accountId: account.stellarAccountId },
        "failed to sync account"
      );
      failed++;
    }
  }

  log.info({ synced, failed }, "balance sync completed");
  return { synced, failed };
}

/**
 * Run balance sync once (for manual invocation or testing).
 */
export async function runBalanceSync(): Promise<void> {
  await syncBalances();
}
