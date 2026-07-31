-- DropIndex (old single-column uniqueness on key alone)
DROP INDEX IF EXISTS "idempotency_keys_key_key";

-- AlterTable
ALTER TABLE "idempotency_keys" ADD COLUMN "user_id" TEXT NOT NULL DEFAULT '';
ALTER TABLE "idempotency_keys" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'succeeded';
ALTER TABLE "idempotency_keys" ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "idempotency_keys" ALTER COLUMN "response_json" DROP NOT NULL;
ALTER TABLE "idempotency_keys" ALTER COLUMN "user_id" DROP DEFAULT;
ALTER TABLE "idempotency_keys" ALTER COLUMN "status" DROP DEFAULT;

-- CreateIndex (compound uniqueness scoped to the authenticated principal)
CREATE UNIQUE INDEX "idempotency_keys_user_id_key_key" ON "idempotency_keys"("user_id", "key");
