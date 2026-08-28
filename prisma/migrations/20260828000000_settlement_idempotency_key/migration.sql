-- Store the client-provided idempotency key directly on the settlement so a
-- database-level constraint can enforce at-most-one settlement per expense
-- share when a key is present, regardless of how the request reached the API.
-- PostgreSQL treats NULL as distinct in unique constraints, so freeform
-- settlements (no expenseShareId) or those without a key are unaffected.
ALTER TABLE "settlements"
  ADD COLUMN "idempotency_key" TEXT;

-- Two rows sharing the same expense_share_id + idempotency_key violate this
-- constraint at insert time — the unique constraint serializes concurrent
-- retries even when the request-level idempotency service is bypassed.
CREATE UNIQUE INDEX IF NOT EXISTS "settlement_expense_share_idempotency"
  ON "settlements"("expense_share_id", "idempotency_key");
