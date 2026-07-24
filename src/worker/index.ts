import { config } from "../config";
import { prisma } from "../db";
import { anchorService, mapAnchorStatus } from "../services/anchor";
import { runReconciliation, startReconciliation } from "./reconciliation";

const log = (...args: unknown[]) =>
  // eslint-disable-next-line no-console
  console.log(`[worker ${new Date().toISOString()}]`, ...args);

export async function reconcilePending(): Promise<void> {
  await runReconciliation();
}

export async function reconcileAnchors(): Promise<void> {
  const sessions = await prisma.anchorSession.findMany({
    where: {
      anchorToken: { not: null },
      externalTransactionId: { not: null },
      status: { notIn: ["completed", "error", "refunded"] },
    },
    take: 50,
  });

  if (sessions.length === 0) return;

  let toml;
  try {
    toml = await anchorService.getToml(config.ANCHOR_HOME_DOMAIN);
  } catch {
    return;
  }

  for (const session of sessions) {
    try {
      const status = await anchorService.getTransactionStatus({
        transferServer: toml.transferServerSep24,
        token: session.anchorToken!,
        id: session.externalTransactionId!,
      });

      if (status) {
        await prisma.anchorSession.update({
          where: { id: session.id },
          data: { status: mapAnchorStatus(status) },
        });
      }
    } catch {
      // Retry this session during the next cycle.
    }
  }
}

export async function expireInvites(): Promise<void> {
  await prisma.invite.deleteMany({
    where: { expiresAt: { not: null, lt: new Date() } },
  });
}

export function startWorker(opts?: {
  fastMs?: number;
  slowMs?: number;
}): () => void {
  const slowMs = opts?.slowMs ?? 60_000;
  const stopReconciliation = opts?.fastMs
    ? startReconciliation({ intervalMs: opts.fastMs })
    : startReconciliation();

  const slow = setInterval(() => {
    reconcileAnchors().catch((error) => log("reconcileAnchors error", error));
    expireInvites().catch((error) => log("expireInvites error", error));
  }, slowMs);

  log(
    `worker started (reconciliation=${opts?.fastMs ?? "configured"}ms slow=${slowMs}ms)`
  );

  return () => {
    stopReconciliation();
    clearInterval(slow);
  };
}

if (require.main === module) {
  const stop = startWorker();
  const shutdown = async () => {
    log("shutting down");
    stop();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
