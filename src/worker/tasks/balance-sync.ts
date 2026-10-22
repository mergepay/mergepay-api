/**
 * Balance sync worker — periodically fetches Stellar account balances from Horizon
 * and stores them in the database for quick access.
 */

import { createLogger } from "../../lib/logger";
import { prisma } from "../../db";
import { stellar } from "../../services/stellar";
import {
  classifyJobFailure,
  safeFailureMessage,
  type RetryPolicy,
} from "../../services/job-retry";
import { withRetry, type WorkerRetryOptions } from "../health";

const log = createLogger({ name: "balance-sync" });

const DEFAULT_ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_REQUEST_DELAY_MS = 200; // Rate limit protection

/**
 * Bounded retry budget for one account's balance sync.
 *
 * `stellar.loadAccount` already retries the Horizon *read* internally, so this
 * task-level budget covers the failures that wrapper does NOT: a transient
 * throw from the `accountBalance` upsert, and a read whose own budget was
 * exhausted and re-threw. `withRetry` classifies each failure (see
 * `classifyJobFailure`) and re-attempts only demonstrably-transient ones, so a
 * 4xx fails fast instead of burning attempts on a request that can never work.
 */
const BALANCE_SYNC_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 250,
  maxDelayMs: 2000,
  jitterRatio: 0.25,
};

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
  // Deliberately NOT caught here: a transient failure must reach `withRetry`
  // so it can be re-attempted, and a permanent one must reach the caller's
  // accounting so it is recorded as a failure instead of a silent success.
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
}

/**
 * Main sync function — queries active accounts and syncs their balances.
 */
export async function syncBalances(opts?: {
  activityWindowMs?: number;
  requestDelayMs?: number;
  /** Override the per-account retry budget (tests use a small one). */
  retryPolicy?: RetryPolicy;
  /** Injectable backoff sleep so tests drive retry timing without real waits
   * (the same seam `withRetry` exposes for cycle tasks). */
  retrySleep?: (ms: number) => Promise<void>;
  /** Called before each scheduled retry; tests use it to count re-attempts. */
  onRetry?: WorkerRetryOptions["onRetry"];
}): Promise<{ synced: number; failed: number }> {
  const activityWindowMs = opts?.activityWindowMs ?? DEFAULT_ACTIVITY_WINDOW_MS;
  const requestDelayMs = opts?.requestDelayMs ?? DEFAULT_REQUEST_DELAY_MS;
  const policy = opts?.retryPolicy ?? BALANCE_SYNC_RETRY_POLICY;

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
      await withRetry(() => syncAccountBalances(account, requestDelayMs), {
        taskName: "balance-sync",
        policy,
        sleep: opts?.retrySleep,
        onRetry: (info) => {
          log.warn(
            {
              category: info.category,
              attempt: info.attempt,
              nextDelayMs: info.delayMs,
              reason: info.reason,
              accountId: account.stellarAccountId,
              type: account.type,
            },
            "balance sync attempt failed, retrying"
          );
          opts?.onRetry?.(info);
        },
      });
      synced++;
    } catch (error) {
      // Reached only after a permanent failure, an indeterminate one, or an
      // exhausted transient budget. Counting it as `failed` (not `synced`) is
      // the dropped-task fix: a Horizon outage no longer reports `{ synced: N,
      // failed: 0 }`, and the structured log gives operators the category and a
      // scrubbed reason to act on.
      const category = classifyJobFailure(error);
      failed++;
      log.error(
        {
          err: error,
          accountId: account.stellarAccountId,
          type: account.type,
          category,
          reason: safeFailureMessage(error),
        },
        "failed to sync account permanently"
      );
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
