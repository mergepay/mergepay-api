-- CreateTable: TreasuryTxProposal / TreasurySignature — signature-collector
-- flow for treasury transactions built from a caller-supplied unsigned XDR.
CREATE TABLE "treasury_tx_proposals" (
  "id" TEXT NOT NULL,
  "group_id" TEXT NOT NULL,
  "creator_id" TEXT NOT NULL,
  "xdr" TEXT NOT NULL,
  "tx_hash" TEXT NOT NULL,
  "source_account" TEXT NOT NULL,
  "required_weight" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING_SIGNATURES',
  "stellar_tx_hash" TEXT,
  "failure_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "treasury_tx_proposals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "treasury_tx_proposals_group_id_idx" ON "treasury_tx_proposals"("group_id");
CREATE INDEX "treasury_tx_proposals_status_idx" ON "treasury_tx_proposals"("status");
CREATE INDEX "treasury_tx_proposals_creator_id_idx" ON "treasury_tx_proposals"("creator_id");

ALTER TABLE "treasury_tx_proposals"
  ADD CONSTRAINT "treasury_tx_proposals_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "groups"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "treasury_tx_proposals"
  ADD CONSTRAINT "treasury_tx_proposals_creator_id_fkey"
  FOREIGN KEY ("creator_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "treasury_signatures" (
  "id" TEXT NOT NULL,
  "proposal_id" TEXT NOT NULL,
  "signer_user_id" TEXT NOT NULL,
  "signer_public_key" TEXT NOT NULL,
  "signature" TEXT NOT NULL,
  "weight" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "treasury_signatures_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "treasury_signatures_proposal_id_signer_user_id_key" ON "treasury_signatures"("proposal_id", "signer_user_id");
CREATE INDEX "treasury_signatures_proposal_id_idx" ON "treasury_signatures"("proposal_id");

ALTER TABLE "treasury_signatures"
  ADD CONSTRAINT "treasury_signatures_proposal_id_fkey"
  FOREIGN KEY ("proposal_id") REFERENCES "treasury_tx_proposals"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "treasury_signatures"
  ADD CONSTRAINT "treasury_signatures_signer_user_id_fkey"
  FOREIGN KEY ("signer_user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
