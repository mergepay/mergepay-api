import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "../db";

export interface WorkerLease {
  key: string;
  owner: string;
}

/** Atomically acquire a lease, including reclaiming an expired lease. */
export async function acquireWorkerLease(
  key: string,
  ttlMs: number,
  owner = randomUUID()
): Promise<WorkerLease | null> {
  const expiresAt = new Date(Date.now() + ttlMs);
  const updated = await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "worker_locks" ("key", "owner", "expires_at", "updated_at")
    VALUES (${key}, ${owner}, ${expiresAt}, CURRENT_TIMESTAMP)
    ON CONFLICT ("key") DO UPDATE
      SET "owner" = EXCLUDED."owner",
          "expires_at" = EXCLUDED."expires_at",
          "updated_at" = CURRENT_TIMESTAMP
      WHERE "worker_locks"."expires_at" <= CURRENT_TIMESTAMP
  `);
  return updated === 1 ? { key, owner } : null;
}

/** Release only the lease owned by this worker; never release a successor's lease. */
export async function releaseWorkerLease(lease: WorkerLease): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`
    DELETE FROM "worker_locks" WHERE "key" = ${lease.key} AND "owner" = ${lease.owner}
  `);
}
