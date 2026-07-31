-- Server-controlled expiry for unsigned transaction intents.
--
-- Nullable so existing rows are unaffected: a null expiry means "no recorded
-- deadline", which the validation path treats as not-expired rather than
-- retroactively invalidating in-flight settlements. New intents always set it.
ALTER TABLE "settlements" ADD COLUMN "expires_at" TIMESTAMP(3);
ALTER TABLE "treasury_transactions" ADD COLUMN "expires_at" TIMESTAMP(3);

-- The worker and the status endpoint both filter pending intents by expiry.
CREATE INDEX "settlements_expires_at_idx" ON "settlements"("expires_at");
CREATE INDEX "treasury_transactions_expires_at_idx" ON "treasury_transactions"("expires_at");
