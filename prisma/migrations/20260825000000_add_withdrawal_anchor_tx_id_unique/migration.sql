-- Withdrawal.anchorTxId becomes the idempotency key for anchor webhook/poll
-- reconciliation (see src/services/withdrawal-status.ts). Replace the plain
-- index with a unique one; Postgres still allows unlimited NULLs (rows
-- created before confirm assigns an anchor tx id).
DROP INDEX IF EXISTS "withdrawals_anchor_tx_id_idx";
CREATE UNIQUE INDEX "withdrawals_anchor_tx_id_key" ON "withdrawals"("anchor_tx_id");
