import pino from "pino";
import { prisma } from "../db";
import { stellar } from "../services/stellar";
import { audit } from "../services/audit";

const log = pino({ name: "transaction-reconciliation" });

type ReconciliationTable = "settlement" | "withdrawal" | "treasuryProposal";

type ReconciliationRecord = {
  id: string;
  status: string;
  stellarTxHash: string | null;
  updatedAt: Date;
  createdAt?: Date;
  expenseShareId?: string | null;
  retryCount?: number;
  ledger?: number | null;
  failureReason?: string | null;
  [key: string]: unknown;
};

type HorizonTransaction = {
  successful?: boolean;
  confirmations?: number;
  ledger?: number;
  hash?: string;
};

type PrismaModel = {
  findMany?: (args: unknown) => Promise<unknown>;
  update?: (args: unknown) => Promise<unknown>;
};

type StellarReconciliationService = {
  getTransaction?: (hash: string) => Promise<HorizonTransaction>;
  getTransactionStatus?: (hash: string) => Promise<HorizonTransaction>;
  retryTransaction?: (
    hash: string
  ) => Promise<string | { hash?: string } | undefined>;
};

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_CONFIRMATION_THRESHOLD = 1;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_RETRIES = 3;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

export interface ReconciliationOptions {
  intervalMs?: number;
  confirmationThreshold?: number;
  timeoutMs?: number;
  maxRetries?: number;
}

export function reconciliationConfig(
  options: ReconciliationOptions = {}
): Required<ReconciliationOptions> {
  return {
    intervalMs:
      options.intervalMs ??
      positiveInteger(process.env.RECONCILIATION_INTERVAL, DEFAULT_INTERVAL_MS),
    confirmationThreshold:
      options.confirmationThreshold ??
      positiveInteger(
        process.env.CONFIRMATION_THRESHOLD,
        DEFAULT_CONFIRMATION_THRESHOLD
      ),
    timeoutMs:
      options.timeoutMs ??
      positiveInteger(process.env.TX_TIMEOUT, DEFAULT_TIMEOUT_MS),
    maxRetries:
      options.maxRetries ??
      nonNegativeInteger(process.env.MAX_RETRIES, DEFAULT_MAX_RETRIES),
  };
}

function modelFor(table: ReconciliationTable): PrismaModel | undefined {
  return (prisma as unknown as Record<string, PrismaModel>)[table];
}

function hasField(record: ReconciliationRecord, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, field);
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const value = error as {
    response?: { status?: number };
    status?: number;
    name?: string;
  };

  return (
    value.response?.status === 404 ||
    value.status === 404 ||
    value.name === "NotFoundError"
  );
}

function hasEnoughConfirmations(
  transaction: HorizonTransaction,
  threshold: number
): boolean {
  if (transaction.successful !== true) return false;
  if (transaction.confirmations === undefined) return threshold <= 1;
  return transaction.confirmations >= threshold;
}

async function writeStatus(
  table: ReconciliationTable,
  record: ReconciliationRecord,
  status: "confirmed" | "failed" | "submitted",
  details: {
    ledger?: number;
    reason?: string;
    hash?: string;
    retryCount?: number;
  } = {}
): Promise<void> {
  const hashChanged =
    details.hash !== undefined && details.hash !== record.stellarTxHash;
  const ledgerChanged =
    details.ledger !== undefined && details.ledger !== record.ledger;
  const retryChanged =
    details.retryCount !== undefined && details.retryCount !== record.retryCount;
  const reasonChanged =
    details.reason !== undefined && details.reason !== record.failureReason;

  if (
    record.status === status &&
    !hashChanged &&
    !ledgerChanged &&
    !retryChanged &&
    !reasonChanged
  ) {
    return;
  }

  const model = modelFor(table);
  if (!model?.update) {
    log.warn({ table, id: record.id }, "reconciliation table is unavailable");
    return;
  }

  const data: Record<string, unknown> = { status };

  if (details.ledger !== undefined && hasField(record, "ledger")) {
    data.ledger = details.ledger;
  }
  if (hashChanged && hasField(record, "stellarTxHash")) {
    data.stellarTxHash = details.hash;
  }
  if (details.retryCount !== undefined && hasField(record, "retryCount")) {
    data.retryCount = details.retryCount;
  }
  if (details.reason !== undefined && hasField(record, "failureReason")) {
    data.failureReason = details.reason;
  }

  await model.update({ where: { id: record.id }, data });

  if (
    table === "settlement" &&
    status === "confirmed" &&
    record.expenseShareId
  ) {
    await prisma.expenseShare.update({
      where: { id: record.expenseShareId },
      data: { status: "settled" },
    });
  }

  await audit({
    action: `stellar_transaction_${status}`,
    entityType: table,
    entityId: record.id,
    metadata: {
      stellarTxHash: details.hash ?? record.stellarTxHash,
      previousStatus: record.status,
      status,
      ledger: details.ledger,
      reason: details.reason,
      retryCount: details.retryCount,
    },
  });

  log.info(
    {
      table,
      id: record.id,
      hash: details.hash ?? record.stellarTxHash,
      status,
      ledger: details.ledger,
      retryCount: details.retryCount,
    },
    "stellar transaction status changed"
  );
}

async function failOrRetry(
  table: ReconciliationTable,
  record: ReconciliationRecord,
  options: Required<ReconciliationOptions>,
  reason: string
): Promise<void> {
  const retryCount = typeof record.retryCount === "number" ? record.retryCount : 0;
  const service = stellar as unknown as StellarReconciliationService;

  if (
    record.stellarTxHash &&
    hasField(record, "retryCount") &&
    retryCount < options.maxRetries &&
    service.retryTransaction
  ) {
    try {
      const result = await service.retryTransaction(record.stellarTxHash);
      const nextHash =
        typeof result === "string"
          ? result
          : result?.hash ?? record.stellarTxHash;

      await writeStatus(table, record, "submitted", {
        hash: nextHash,
        retryCount: retryCount + 1,
      });

      log.warn(
        { table, id: record.id, hash: nextHash, retryCount: retryCount + 1 },
        "retried Stellar transaction"
      );
      return;
    } catch (error) {
      log.warn(
        { err: error, table, id: record.id },
        "Stellar transaction retry failed"
      );
    }
  }

  await writeStatus(table, record, "failed", {
    reason,
    retryCount,
  });

  log.warn(
    { table, id: record.id, hash: record.stellarTxHash, retryCount },
    "Stellar transaction marked failed"
  );
}

async function getTransaction(hash: string): Promise<HorizonTransaction> {
  const service = stellar as unknown as StellarReconciliationService;

  if (service.getTransactionStatus) {
    return service.getTransactionStatus(hash);
  }
  if (service.getTransaction) {
    return service.getTransaction(hash);
  }

  throw new Error("The Stellar service does not expose a transaction status query");
}

async function reconcileRecord(
  table: ReconciliationTable,
  record: ReconciliationRecord,
  options: Required<ReconciliationOptions>
): Promise<void> {
  if (!record.stellarTxHash) return;

  let transaction: HorizonTransaction | undefined;

  try {
    transaction = await getTransaction(record.stellarTxHash);
  } catch (error) {
    if (!isNotFoundError(error)) {
      log.warn(
        { err: error, table, id: record.id },
        "unable to query Stellar transaction; will retry"
      );
      return;
    }
  }

  if (transaction) {
    if (hasEnoughConfirmations(transaction, options.confirmationThreshold)) {
      await writeStatus(table, record, "confirmed", {
        ledger: transaction.ledger,
        hash: transaction.hash ?? record.stellarTxHash,
      });
    } else if (transaction.successful === false) {
      await failOrRetry(table, record, options, "Stellar rejected the transaction");
    }
    return;
  }

  const referenceDate = record.createdAt ?? record.updatedAt;
  if (Date.now() - referenceDate.getTime() >= options.timeoutMs) {
    await failOrRetry(
      table,
      record,
      options,
      `Transaction was not found on Stellar after ${options.timeoutMs}ms`
    );
  }
}

async function loadPendingRecords(
  table: ReconciliationTable,
  cutoff: Date
): Promise<ReconciliationRecord[]> {
  const model = modelFor(table);
  if (!model?.findMany) return [];

  const records = await model.findMany({
    where: {
      status: { in: ["pending", "submitted"] },
      updatedAt: { lt: cutoff },
      stellarTxHash: { not: null },
    },
    orderBy: { updatedAt: "asc" },
  });

  return records as ReconciliationRecord[];
}

export async function runReconciliation(
  options: ReconciliationOptions = {}
): Promise<void> {
  const resolved = reconciliationConfig(options);
  const cutoff = new Date(Date.now() - resolved.intervalMs);
  const tables: ReconciliationTable[] = [
    "settlement",
    "withdrawal",
    "treasuryProposal",
  ];

  for (const table of tables) {
    let records: ReconciliationRecord[];

    try {
      records = await loadPendingRecords(table, cutoff);
    } catch (error) {
      log.error({ err: error, table }, "unable to load pending transactions");
      continue;
    }

    for (const record of records) {
      try {
        await reconcileRecord(table, record, resolved);
      } catch (error) {
        log.error(
          { err: error, table, id: record.id },
          "transaction reconciliation failed"
        );
      }
    }
  }
}

export function startReconciliation(
  options: ReconciliationOptions = {}
): () => void {
  const resolved = reconciliationConfig(options);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const scheduleNext = (): void => {
    if (stopped) return;

    timer = setTimeout(async () => {
      try {
        await runReconciliation(resolved);
      } catch (error) {
        log.error({ err: error }, "reconciliation cycle failed");
      } finally {
        scheduleNext();
      }
    }, resolved.intervalMs);
  };

  void (async () => {
    try {
      await runReconciliation(resolved);
    } catch (error) {
      log.error({ err: error }, "initial reconciliation cycle failed");
    } finally {
      scheduleNext();
    }
  })();

  log.info(
    {
      intervalMs: resolved.intervalMs,
      confirmationThreshold: resolved.confirmationThreshold,
      timeoutMs: resolved.timeoutMs,
      maxRetries: resolved.maxRetries,
    },
    "stellar reconciliation started"
  );

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    log.info("stellar reconciliation stopped");
  };
}
