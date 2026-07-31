-- Add retry tracking fields to Settlement model
ALTER TABLE "settlements" ADD COLUMN "next_retry_at" TIMESTAMP(3);
ALTER TABLE "settlements" ADD COLUMN "error_category" TEXT;

-- Add retry tracking fields to AnchorSession model
ALTER TABLE "anchor_sessions" ADD COLUMN "next_retry_at" TIMESTAMP(3);
ALTER TABLE "anchor_sessions" ADD COLUMN "error_category" TEXT;

-- Add index on nextRetryAt for efficient querying of retryable jobs
CREATE INDEX "settlements_next_retry_at_idx" ON "settlements"("next_retry_at");
CREATE INDEX "anchor_sessions_next_retry_at_idx" ON "anchor_sessions"("next_retry_at");
