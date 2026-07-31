-- AlterTable
ALTER TABLE "idempotency_keys" ADD COLUMN "user_id" TEXT;
ALTER TABLE "idempotency_keys" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'in_progress';
ALTER TABLE "idempotency_keys" ADD COLUMN "status_code" INTEGER;
ALTER TABLE "idempotency_keys" ADD COLUMN "expires_at" TIMESTAMP(3);
ALTER TABLE "idempotency_keys" ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill: existing rows already hold a completed response — expire them 24h after creation.
UPDATE "idempotency_keys"
SET "status" = 'completed', "expires_at" = "created_at" + INTERVAL '24 hours'
WHERE "expires_at" IS NULL;

ALTER TABLE "idempotency_keys" ALTER COLUMN "expires_at" SET NOT NULL;
ALTER TABLE "idempotency_keys" ALTER COLUMN "response_json" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");
