-- Reconciles prisma/schema.prisma with the worker's lease-based job claiming
-- and retry-classification design.
--
-- Several earlier migrations added overlapping, inconsistently-named columns
-- for the same underlying concepts (job_attempt_count/job_claimed_at/
-- job_eligible_at vs. claimed_at/claimed_by/lease_expires_at; error_category
-- and next_retry_at added to anchor_sessions and settlements but never
-- reflected in schema.prisma; claimed_at/claimed_by/lease_expires_at/
-- next_attempt_at declared in schema.prisma for anchor_sessions with no
-- migration ever creating them). Rather than trying to reconstruct which of
-- those partial migrations actually ran against a given database, every
-- statement below is guarded with IF NOT EXISTS so this migration converges
-- any prior state to exactly what schema.prisma now declares.
ALTER TABLE "settlements" ADD COLUMN IF NOT EXISTS "error_category" TEXT;
ALTER TABLE "settlements" ADD COLUMN IF NOT EXISTS "next_attempt_at" TIMESTAMP(3);
ALTER TABLE "settlements" ADD COLUMN IF NOT EXISTS "claimed_at" TIMESTAMP(3);
ALTER TABLE "settlements" ADD COLUMN IF NOT EXISTS "claimed_by" TEXT;
ALTER TABLE "settlements" ADD COLUMN IF NOT EXISTS "lease_expires_at" TIMESTAMP(3);
ALTER TABLE "settlements" ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMP(3);
ALTER TABLE "treasury_transactions" ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMP(3);

ALTER TABLE "anchor_sessions" ADD COLUMN IF NOT EXISTS "error_category" TEXT;
ALTER TABLE "anchor_sessions" ADD COLUMN IF NOT EXISTS "next_attempt_at" TIMESTAMP(3);
ALTER TABLE "anchor_sessions" ADD COLUMN IF NOT EXISTS "claimed_at" TIMESTAMP(3);
ALTER TABLE "anchor_sessions" ADD COLUMN IF NOT EXISTS "claimed_by" TEXT;
ALTER TABLE "anchor_sessions" ADD COLUMN IF NOT EXISTS "lease_expires_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "settlements_lease_expires_at_idx" ON "settlements"("lease_expires_at");
CREATE INDEX IF NOT EXISTS "anchor_sessions_lease_expires_at_idx" ON "anchor_sessions"("lease_expires_at");
CREATE INDEX IF NOT EXISTS "settlements_expires_at_idx" ON "settlements"("expires_at");
CREATE INDEX IF NOT EXISTS "treasury_transactions_expires_at_idx" ON "treasury_transactions"("expires_at");
