ALTER TABLE "settlements" ADD COLUMN "transaction_xdr" TEXT;
ALTER TABLE "settlements" ADD COLUMN "retry_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "settlements" ADD COLUMN "failure_reason" TEXT;
