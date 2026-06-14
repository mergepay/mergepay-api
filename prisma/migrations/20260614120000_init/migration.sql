-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "stellar_public_key" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "avatar_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "groups" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_by_user_id" TEXT NOT NULL,
    "treasury_enabled" BOOLEAN NOT NULL DEFAULT false,
    "treasury_account_public_key" TEXT,
    "treasury_required_signers" INTEGER,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_members" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "payer_user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "amount" DECIMAL(20,7) NOT NULL,
    "asset_code" TEXT NOT NULL,
    "asset_issuer" TEXT,
    "split_type" TEXT NOT NULL,
    "memo" TEXT,
    "receipt_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_shares" (
    "id" TEXT NOT NULL,
    "expense_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "share_amount" DECIMAL(20,7) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',

    CONSTRAINT "expense_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlements" (
    "id" TEXT NOT NULL,
    "short_code" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "from_user_id" TEXT NOT NULL,
    "to_user_id" TEXT NOT NULL,
    "amount" DECIMAL(20,7) NOT NULL,
    "asset_code" TEXT NOT NULL,
    "asset_issuer" TEXT,
    "stellar_tx_hash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "memo" TEXT,
    "expense_id" TEXT,
    "expense_share_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "treasury_transactions" (
    "id" TEXT NOT NULL,
    "short_code" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "user_id" TEXT,
    "direction" TEXT NOT NULL,
    "amount" DECIMAL(20,7) NOT NULL,
    "asset_code" TEXT NOT NULL,
    "asset_issuer" TEXT,
    "destination" TEXT,
    "stellar_tx_hash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "memo" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "treasury_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invites" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3),
    "created_by_user_id" TEXT NOT NULL,
    "max_uses" INTEGER,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "anchor_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "anchor_name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "asset_code" TEXT NOT NULL,
    "interactive_url" TEXT,
    "external_transaction_id" TEXT,
    "anchor_token" TEXT,
    "status" TEXT NOT NULL DEFAULT 'incomplete',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "anchor_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateUniqueIndex
CREATE UNIQUE INDEX "users_stellar_public_key_key" ON "users"("stellar_public_key");

-- CreateUniqueIndex
CREATE UNIQUE INDEX "group_members_group_id_user_id_key" ON "group_members"("group_id", "user_id");

-- CreateUniqueIndex
CREATE UNIQUE INDEX "settlements_short_code_key" ON "settlements"("short_code");

-- CreateUniqueIndex
CREATE UNIQUE INDEX "treasury_transactions_short_code_key" ON "treasury_transactions"("short_code");

-- CreateUniqueIndex
CREATE UNIQUE INDEX "invites_code_key" ON "invites"("code");

-- CreateIndex
CREATE INDEX "groups_created_by_user_id_idx" ON "groups"("created_by_user_id");

-- CreateIndex
CREATE INDEX "group_members_user_id_idx" ON "group_members"("user_id");

-- CreateIndex
CREATE INDEX "expenses_group_id_idx" ON "expenses"("group_id");

-- CreateIndex
CREATE INDEX "expense_shares_expense_id_idx" ON "expense_shares"("expense_id");

-- CreateIndex
CREATE INDEX "expense_shares_user_id_idx" ON "expense_shares"("user_id");

-- CreateIndex
CREATE INDEX "settlements_group_id_idx" ON "settlements"("group_id");

-- CreateIndex
CREATE INDEX "settlements_from_user_id_idx" ON "settlements"("from_user_id");

-- CreateIndex
CREATE INDEX "settlements_to_user_id_idx" ON "settlements"("to_user_id");

-- CreateIndex
CREATE INDEX "settlements_status_idx" ON "settlements"("status");

-- CreateIndex
CREATE INDEX "treasury_transactions_group_id_idx" ON "treasury_transactions"("group_id");

-- CreateIndex
CREATE INDEX "treasury_transactions_status_idx" ON "treasury_transactions"("status");

-- CreateIndex
CREATE INDEX "invites_group_id_idx" ON "invites"("group_id");

-- CreateIndex
CREATE INDEX "anchor_sessions_user_id_idx" ON "anchor_sessions"("user_id");

-- CreateIndex
CREATE INDEX "anchor_sessions_external_transaction_id_idx" ON "anchor_sessions"("external_transaction_id");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_idx" ON "audit_logs"("user_id");

-- AddForeignKey
ALTER TABLE "groups" ADD CONSTRAINT "groups_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_payer_user_id_fkey" FOREIGN KEY ("payer_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_shares" ADD CONSTRAINT "expense_shares_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "expenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_shares" ADD CONSTRAINT "expense_shares_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_expense_share_id_fkey" FOREIGN KEY ("expense_share_id") REFERENCES "expense_shares"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "treasury_transactions" ADD CONSTRAINT "treasury_transactions_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "treasury_transactions" ADD CONSTRAINT "treasury_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anchor_sessions" ADD CONSTRAINT "anchor_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
