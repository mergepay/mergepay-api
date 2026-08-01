-- Durable job state for the settlement worker: attempt scheduling, failure
-- classification, and the lease that keeps two workers off the same
-- transition. See src/worker/index.ts.

-- An earlier migration introduced "next_retry_at" for the same purpose; adopt
-- it under the name the schema uses rather than carrying two columns.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'settlements' AND column_name = 'next_retry_at'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'settlements' AND column_name = 'next_attempt_at'
  ) THEN
    ALTER TABLE "settlements" RENAME COLUMN "next_retry_at" TO "next_attempt_at";
  END IF;
END $$;

ALTER TABLE "settlements" ADD COLUMN IF NOT EXISTS "next_attempt_at" TIMESTAMP(3);
ALTER TABLE "settlements" ADD COLUMN IF NOT EXISTS "error_category" TEXT;
ALTER TABLE "settlements" ADD COLUMN IF NOT EXISTS "claimed_by" TEXT;
ALTER TABLE "settlements" ADD COLUMN IF NOT EXISTS "claimed_at" TIMESTAMP(3);
ALTER TABLE "settlements" ADD COLUMN IF NOT EXISTS "lease_expires_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "settlements_status_next_attempt_at_idx"
  ON "settlements"("status", "next_attempt_at");

CREATE INDEX IF NOT EXISTS "settlements_lease_expires_at_idx"
  ON "settlements"("lease_expires_at");

-- Anchor sessions follow the same job-state contract.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'anchor_sessions' AND column_name = 'next_retry_at'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'anchor_sessions' AND column_name = 'next_attempt_at'
  ) THEN
    ALTER TABLE "anchor_sessions" RENAME COLUMN "next_retry_at" TO "next_attempt_at";
  END IF;
END $$;

ALTER TABLE "anchor_sessions" ADD COLUMN IF NOT EXISTS "next_attempt_at" TIMESTAMP(3);
ALTER TABLE "anchor_sessions" ADD COLUMN IF NOT EXISTS "error_category" TEXT;
ALTER TABLE "anchor_sessions" ADD COLUMN IF NOT EXISTS "claimed_by" TEXT;
ALTER TABLE "anchor_sessions" ADD COLUMN IF NOT EXISTS "claimed_at" TIMESTAMP(3);
ALTER TABLE "anchor_sessions" ADD COLUMN IF NOT EXISTS "lease_expires_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "anchor_sessions_next_attempt_at_idx"
  ON "anchor_sessions"("next_attempt_at");

CREATE INDEX IF NOT EXISTS "anchor_sessions_lease_expires_at_idx"
  ON "anchor_sessions"("lease_expires_at");
