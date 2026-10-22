-- Reconciles the migration history with `prisma/schema.prisma`.
--
-- Several historical migrations added tables, columns, and indexes under names
-- the schema never declared (PascalCase `Webhook`/`WebhookDelivery`/`IdempotencyKey`/
-- `Sep10ConsumedChallenge`) or left worker-job columns on `settlements` that the
-- schema only defines on `anchor_sessions`, while two schema tables
-- (`treasury_approvals`, `status_history`) and the withdrawal/anchor retry
-- columns were never created by any migration at all. The result was a history
-- that `prisma migrate deploy` could not apply to a fresh database and that,
-- even where it could run, drifted from `schema.prisma` — the state every real
-- environment is actually built to by `prisma db push`.
--
-- This migration is the output of:
--   prisma migrate diff \
--     --from-migrations prisma/migrations \
--     --to-schema-datamodel prisma/schema.prisma \
--     --shadow-database-url "$SHADOW_DATABASE_URL" \
--     --script
-- so it is, by construction, exactly the SQL that makes a deploy-built database
-- equal `schema.prisma`: it drops the drift the schema does not declare and adds
-- the objects the schema does. The CI `migration` job asserts this is a no-op
-- (`migrate diff --exit-code`), which is what prevents future drift from landing.
--
-- Safe to rewrite the earlier broken migrations rather than mark them applied:
-- `migrate deploy` has always failed at `20260724000000_add_webhooks`, so no
-- database can hold a successful `_prisma_migrations` checksum for any of them,
-- and `db push` (how every environment is actually built) records no checksum at
-- all.

-- DropIndex
DROP INDEX "anchor_sessions_lease_expires_at_idx";

-- DropIndex
DROP INDEX "anchor_sessions_next_attempt_at_idx";

-- DropIndex
DROP INDEX "anchor_sessions_next_retry_at_idx";

-- DropIndex
DROP INDEX "idx_anchor_sessions_job_claimed_at";

-- DropIndex
DROP INDEX "audit_logs_created_at_idx";

-- DropIndex
DROP INDEX "expenses_group_id_created_at_idx";

-- DropIndex
DROP INDEX "expenses_group_id_idx";

-- DropIndex
DROP INDEX "idx_settlements_job_claimed_at";

-- DropIndex
DROP INDEX "settlements_created_at_idx";

-- DropIndex
DROP INDEX "settlements_next_retry_at_idx";

-- AlterTable
ALTER TABLE "account_balances" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "anchor_sessions" DROP COLUMN "next_retry_at",
ALTER COLUMN "last_polled_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "job_claimed_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "job_eligible_at" SET NOT NULL,
ALTER COLUMN "job_eligible_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "invitations" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "settlements" DROP COLUMN "job_attempt_count",
DROP COLUMN "job_claimed_at",
DROP COLUMN "job_eligible_at",
DROP COLUMN "job_error_summary",
DROP COLUMN "next_retry_at";

-- AlterTable
ALTER TABLE "treasury_proposals" ADD COLUMN     "tx_hash" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "treasury_transactions" ADD COLUMN     "intended_tx_hash" TEXT;

-- AlterTable
ALTER TABLE "webhooks" ALTER COLUMN "events" DROP DEFAULT;

-- AlterTable
ALTER TABLE "withdrawals" ADD COLUMN     "error_category" TEXT,
ADD COLUMN     "next_attempt_at" TIMESTAMP(3),
ADD COLUMN     "retry_count" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "treasury_approvals" (
    "id" TEXT NOT NULL,
    "proposal_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "signed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "treasury_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "status_history" (
    "id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "source" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "status_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "treasury_approvals_proposal_id_idx" ON "treasury_approvals"("proposal_id");

-- CreateIndex
CREATE INDEX "treasury_approvals_user_id_idx" ON "treasury_approvals"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "treasury_approvals_proposal_id_user_id_key" ON "treasury_approvals"("proposal_id", "user_id");

-- CreateIndex
CREATE INDEX "status_history_entity_type_entity_id_idx" ON "status_history"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "status_history_entity_type_entity_id_created_at_idx" ON "status_history"("entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE INDEX "anchor_sessions_anchor_token_external_transaction_id_idx" ON "anchor_sessions"("anchor_token", "external_transaction_id");

-- CreateIndex
CREATE INDEX "anchor_sessions_status_last_polled_at_idx" ON "anchor_sessions"("status", "last_polled_at");

-- CreateIndex
CREATE INDEX "expense_shares_expense_id_user_id_idx" ON "expense_shares"("expense_id", "user_id");

-- CreateIndex
CREATE INDEX "expenses_group_id_created_at_id_idx" ON "expenses"("group_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "group_members_role_idx" ON "group_members"("role");

-- CreateIndex
CREATE INDEX "settlements_status_updated_at_idx" ON "settlements"("status", "updated_at");

-- CreateIndex
CREATE INDEX "settlements_expense_share_id_idx" ON "settlements"("expense_share_id");

-- CreateIndex
CREATE INDEX "treasury_proposals_status_created_at_idx" ON "treasury_proposals"("status", "created_at");

-- CreateIndex
CREATE INDEX "treasury_transactions_group_id_status_idx" ON "treasury_transactions"("group_id", "status");

-- CreateIndex
CREATE INDEX "withdrawals_status_next_attempt_at_idx" ON "withdrawals"("status", "next_attempt_at");

-- AddForeignKey
ALTER TABLE "treasury_approvals" ADD CONSTRAINT "treasury_approvals_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "treasury_proposals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "treasury_approvals" ADD CONSTRAINT "treasury_approvals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "settlement_expense_share_idempotency" RENAME TO "settlements_expense_share_id_idempotency_key_key";
