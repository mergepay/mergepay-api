-- Idempotency keys are a short-lived request-dedup cache, not business data.
-- Clearing them when their uniqueness scope changes is safe: at worst, a
-- request retried with a previously-used key is treated as new rather than
-- replayed from cache.
DELETE FROM "idempotency_keys";

-- DropIndex
DROP INDEX IF EXISTS "idempotency_keys_key_key";

-- AlterTable
ALTER TABLE "idempotency_keys"
  ADD COLUMN "user_id" TEXT NOT NULL,
  ADD COLUMN "scope" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_user_id_scope_key_key" ON "idempotency_keys"("user_id", "scope", "key");

-- CreateIndex
CREATE INDEX "idempotency_keys_user_id_idx" ON "idempotency_keys"("user_id");

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
