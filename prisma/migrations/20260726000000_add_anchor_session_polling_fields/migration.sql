ALTER TABLE "anchor_sessions" ADD COLUMN "failure_reason" TEXT;
ALTER TABLE "anchor_sessions" ADD COLUMN "retry_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "anchor_sessions" ADD COLUMN "last_polled_at" TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS "anchor_sessions_status_idx" ON "anchor_sessions" ("status");
