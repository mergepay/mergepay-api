/**
 * Treasury service — reconciliation of cached group treasury balances
 * with on-chain Stellar account balances from Horizon.
 *
 * Compares the cached XLM and USDC (stable asset) balances stored in
 * AccountBalance with the live on-chain values, updating the cache and
 * creating audit records when variances are detected.
 */

import pino from "pino";
import { prisma } from "../db";
import { config } from "../config";
import { stellar } from "./stellar";
import { audit } from "./audit";

const log = pino({ name: "treasury-service" });

/**
 * Normalize a Stellar balance string to a canonical form for comparison.
 *
 * Stellar Horizon returns balances as decimal strings with up to 7 digits
 * after the decimal point (stroops precision). This function pads or trims
 * the fractional part to exactly 7 digits, avoiding unsafe floating-point
 * arithmetic.
 */
export function normalizeBalance(value: string): string {
  const [integer, fraction = ""] = value.split(".");
  return `${integer}.${(fraction + "0000000").slice(0, 7)}`;
}

/**
 * Reconcile a single group treasury's cached balances with on-chain values.
 *
 * Steps:
 *  1. Resolve the group treasury and its Stellar public key.
 *  2. Fetch the on-chain account balances from Horizon via `stellar.loadAccount`.
 *  3. Parse native XLM and the configured USDC trustline.
 *  4. Compare with cached AccountBalance records.
 *  5. On variance: update the cache and create an audit record.
 *  6. On match: keep the cache consistent (touch updatedAt).
 *
 * Returns `{ compared: number, variances: number }` for observability.
 *
 * Idempotent — safe to call repeatedly for the same treasury.
 */
export async function reconcileTreasuryBalance(
  treasuryId: string
): Promise<{ compared: number; variances: number }> {
  const group = await prisma.group.findUnique({
    where: { id: treasuryId },
    select: {
      id: true,
      treasuryEnabled: true,
      treasuryAccountPublicKey: true,
    },
  });

  if (!group || !group.treasuryEnabled || !group.treasuryAccountPublicKey) {
    log.warn(
      { treasuryId },
      "treasury not found or not enabled, skipping reconciliation"
    );
    return { compared: 0, variances: 0 };
  }

  const publicKey = group.treasuryAccountPublicKey;

  const snapshot = await stellar.loadAccount(publicKey);

  if (!snapshot.exists) {
    log.warn(
      { treasuryId, publicKey },
      "treasury account not found on Stellar network"
    );
    return { compared: 0, variances: 0 };
  }

  // Parse on-chain balances — treat missing trustlines as zero.
  const xlmOnChain =
    snapshot.balances.find((b) => b.assetCode === "XLM")?.balance ?? "0";
  const usdcOnChain =
    snapshot.balances.find(
      (b) =>
        b.assetCode === config.STABLE_ASSET_CODE &&
        b.assetIssuer === config.STABLE_ASSET_ISSUER
    )?.balance ?? "0";

  // Fetch cached balances.
  const [cachedXlm, cachedUsdc] = await Promise.all([
    prisma.accountBalance.findUnique({
      where: { accountId_assetCode: { accountId: publicKey, assetCode: "XLM" } },
    }),
    prisma.accountBalance.findUnique({
      where: {
        accountId_assetCode: {
          accountId: publicKey,
          assetCode: config.STABLE_ASSET_CODE,
        },
      },
    }),
  ]);

  let compared = 0;
  let variances = 0;

  const xlmVariance = await compareAndUpdate(
    treasuryId,
    publicKey,
    "XLM",
    null,
    xlmOnChain,
    cachedXlm?.balance ?? null
  );
  if (xlmVariance) variances++;
  compared++;

  const usdcVariance = await compareAndUpdate(
    treasuryId,
    publicKey,
    config.STABLE_ASSET_CODE,
    config.STABLE_ASSET_ISSUER,
    usdcOnChain,
    cachedUsdc?.balance ?? null
  );
  if (usdcVariance) variances++;
  compared++;

  if (variances === 0) {
    log.info(
      { treasuryId, publicKey },
      "treasury balance reconciliation complete — no variances"
    );
  }

  return { compared, variances };
}

/**
 * Compare on-chain vs cached balance for a single asset.
 * Updates the cache and creates an audit record on variance.
 * Returns true if a variance was detected.
 */
async function compareAndUpdate(
  treasuryId: string,
  publicKey: string,
  assetCode: string,
  assetIssuer: string | null,
  onChainBalance: string,
  cachedBalance: string | null
): Promise<boolean> {
  const normalizedOnChain = normalizeBalance(onChainBalance);
  const normalizedCached = cachedBalance
    ? normalizeBalance(cachedBalance)
    : null;

  if (normalizedCached !== null && normalizedOnChain === normalizedCached) {
    // Match — touch updatedAt to record the reconciliation check.
    await prisma.accountBalance.update({
      where: {
        accountId_assetCode: { accountId: publicKey, assetCode },
      },
      data: { updatedAt: new Date() },
    });
    return false;
  }

  // Variance detected — update the cached snapshot.
  await prisma.accountBalance.upsert({
    where: {
      accountId_assetCode: { accountId: publicKey, assetCode },
    },
    update: {
      balance: onChainBalance,
      updatedAt: new Date(),
    },
    create: {
      accountId: publicKey,
      assetCode,
      balance: onChainBalance,
    },
  });

  await audit({
    groupId: treasuryId,
    action: "treasury.balance_variance",
    entityType: "AccountBalance",
    entityId: `${publicKey}:${assetCode}`,
    metadata: {
      assetCode,
      assetIssuer,
      cachedBalance: cachedBalance ?? null,
      onChainBalance,
    },
  });

  log.warn(
    {
      treasuryId,
      publicKey,
      assetCode,
      cachedBalance: cachedBalance ?? null,
      onChainBalance,
    },
    "treasury balance variance detected and corrected"
  );

  return true;
}

/**
 * Reconcile balances for all enabled treasuries.
 * Used by the periodic worker task.
 * Failures for one treasury do not prevent reconciliation of others.
 */
export async function reconcileAllTreasuryBalances(): Promise<{
  reconciled: number;
  variances: number;
  errors: number;
}> {
  const groups = await prisma.group.findMany({
    where: {
      treasuryEnabled: true,
      treasuryAccountPublicKey: { not: null },
    },
    select: { id: true },
  });

  if (groups.length === 0) {
    log.debug("no enabled treasuries to reconcile");
    return { reconciled: 0, variances: 0, errors: 0 };
  }

  log.info({ count: groups.length }, "reconciling treasury balances");

  let reconciled = 0;
  let variances = 0;
  let errors = 0;

  for (const group of groups) {
    try {
      const result = await reconcileTreasuryBalance(group.id);
      reconciled++;
      variances += result.variances;
    } catch (err) {
      errors++;
      log.error(
        {
          treasuryId: group.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "failed to reconcile treasury balance"
      );
    }
  }

  log.info({ reconciled, variances, errors }, "treasury balance reconciliation complete");
  return { reconciled, variances, errors };
}
