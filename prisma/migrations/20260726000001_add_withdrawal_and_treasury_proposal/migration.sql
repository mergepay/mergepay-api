-- CreateTable: Withdrawal (SEP-24 fiat off-ramp request, Issue #40)
CREATE TABLE "withdrawals" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "amount" DECIMAL(20, 7) NOT NULL,
  "asset_code" TEXT NOT NULL,
  "asset_issuer" TEXT,
  "memo" TEXT,
  "anchor_tx_id" TEXT,
  "interactive_url" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "failure_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "withdrawals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "withdrawals_user_id_idx" ON "withdrawals"("user_id");
CREATE INDEX "withdrawals_status_idx" ON "withdrawals"("status");
CREATE INDEX "withdrawals_anchor_tx_id_idx" ON "withdrawals"("anchor_tx_id");

ALTER TABLE "withdrawals"
  ADD CONSTRAINT "withdrawals_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: TreasuryProposal (multisig proposal/signature collection, Issue #41)
CREATE TABLE "treasury_proposals" (
  "id" TEXT NOT NULL,
  "group_id" TEXT NOT NULL,
  "creator_id" TEXT NOT NULL,
  "xdr" TEXT NOT NULL,
  "threshold" INTEGER NOT NULL DEFAULT 1,
  "signatures" JSONB NOT NULL DEFAULT '[]',
  "status" TEXT NOT NULL DEFAULT 'pending',
  "stellar_tx_hash" TEXT,
  "failure_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "treasury_proposals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "treasury_proposals_group_id_idx" ON "treasury_proposals"("group_id");
CREATE INDEX "treasury_proposals_status_idx" ON "treasury_proposals"("status");
CREATE INDEX "treasury_proposals_creator_id_idx" ON "treasury_proposals"("creator_id");

ALTER TABLE "treasury_proposals"
  ADD CONSTRAINT "treasury_proposals_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "groups"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "treasury_proposals"
  ADD CONSTRAINT "treasury_proposals_creator_id_fkey"
  FOREIGN KEY ("creator_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
