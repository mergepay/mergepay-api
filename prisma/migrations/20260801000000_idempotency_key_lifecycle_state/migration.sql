-- Idempotency reservations are written before the guarded operation runs, so a
-- key needs a lifecycle: "in_progress" while the work is in flight, then
-- "completed" (the stored response replays) or "failed" (the client may retry
-- the same key). See src/services/idempotency.ts.
--
-- Written defensively with IF NOT EXISTS because earlier migrations in this
-- repository already introduced some of these columns.

ALTER TABLE "idempotency_keys"
  ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'in_progress';

ALTER TABLE "idempotency_keys"
  ADD COLUMN IF NOT EXISTS "status_code" INTEGER;

ALTER TABLE "idempotency_keys"
  ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMP(3);

ALTER TABLE "idempotency_keys"
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- A row that already carries a response was completed by the previous
-- implementation; give it a retention deadline rather than dropping it.
UPDATE "idempotency_keys"
SET "status" = 'completed'
WHERE "response_json" IS NOT NULL AND "status" <> 'completed';

UPDATE "idempotency_keys"
SET "expires_at" = "created_at" + INTERVAL '24 hours'
WHERE "expires_at" IS NULL;

ALTER TABLE "idempotency_keys" ALTER COLUMN "expires_at" SET NOT NULL;
ALTER TABLE "idempotency_keys" ALTER COLUMN "response_json" DROP NOT NULL;

CREATE INDEX IF NOT EXISTS "idempotency_keys_expires_at_idx"
  ON "idempotency_keys"("expires_at");
