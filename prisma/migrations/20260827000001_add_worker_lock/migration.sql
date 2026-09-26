CREATE TABLE IF NOT EXISTS "worker_locks" (
  "key" TEXT NOT NULL,
  "owner" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "worker_locks_pkey" PRIMARY KEY ("key")
);

CREATE INDEX IF NOT EXISTS "worker_locks_expires_at_idx"
  ON "worker_locks"("expires_at");
