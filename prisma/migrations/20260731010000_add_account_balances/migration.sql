-- Cached Stellar account balances, refreshed periodically by the
-- balance-sync worker so account balance reads don't need a live Horizon call.
CREATE TABLE IF NOT EXISTS "account_balances" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "asset_code" TEXT NOT NULL,
    "balance" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "account_balances_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "account_balances_account_id_asset_code_key"
    ON "account_balances"("account_id", "asset_code");
CREATE INDEX IF NOT EXISTS "account_balances_account_id_idx" ON "account_balances"("account_id");
