ALTER TABLE "treasury_proposals" ADD COLUMN "expires_at" TIMESTAMP(3);

UPDATE "treasury_proposals"
SET "expires_at" = "created_at" + INTERVAL '7 days'
WHERE "expires_at" IS NULL AND "status" IN ('open', 'pending', 'awaiting_signatures');

CREATE INDEX "treasury_proposals_status_expires_at_idx" ON "treasury_proposals"("status", "expires_at");
