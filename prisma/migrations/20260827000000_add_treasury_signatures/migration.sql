-- Treasury multisig signature collection: split the JSON `signatures` blob
-- on treasury_proposals into a proper TreasurySignature table so each
-- partial signature carries its own verified on-chain signer weight, and
-- move the proposal status values to the PENDING_SIGNATURES / READY /
-- SUBMITTED / FAILED lifecycle.

-- CreateTable: TreasurySignature
CREATE TABLE "treasury_signatures" (
  "id" TEXT NOT NULL,
  "proposal_id" TEXT NOT NULL,
  "signer_public_key" TEXT NOT NULL,
  "signature" TEXT NOT NULL,
  "weight" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "treasury_signatures_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "treasury_signatures_proposal_id_signer_public_key_key"
  ON "treasury_signatures"("proposal_id", "signer_public_key");
CREATE INDEX "treasury_signatures_proposal_id_idx" ON "treasury_signatures"("proposal_id");

ALTER TABLE "treasury_signatures"
  ADD CONSTRAINT "treasury_signatures_proposal_id_fkey"
  FOREIGN KEY ("proposal_id") REFERENCES "treasury_proposals"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: previously-collected signatures were stored as a JSON array of
-- `{ publicKey, signature, signedAt }` with no recorded weight, so migrated
-- rows default to weight 1 (the same assumption the old headcount-based
-- threshold check made).
INSERT INTO "treasury_signatures" ("id", "proposal_id", "signer_public_key", "signature", "weight", "created_at")
SELECT
  'sig_' || substr(md5(random()::text || tp."id" || sig->>'publicKey'), 1, 24),
  tp."id",
  sig->>'publicKey',
  sig->>'signature',
  1,
  COALESCE(NULLIF(sig->>'signedAt', '')::timestamp, tp."created_at")
FROM "treasury_proposals" tp,
     jsonb_array_elements(tp."signatures") AS sig
WHERE jsonb_typeof(tp."signatures") = 'array'
  AND jsonb_array_length(tp."signatures") > 0
  AND sig->>'publicKey' IS NOT NULL
ON CONFLICT DO NOTHING;

-- Move existing statuses onto the new PENDING_SIGNATURES/READY/SUBMITTED/FAILED
-- lifecycle before dropping the old default.
UPDATE "treasury_proposals" SET "status" = 'PENDING_SIGNATURES' WHERE "status" IN ('pending', 'awaiting_signatures');
UPDATE "treasury_proposals" SET "status" = 'SUBMITTED' WHERE "status" IN ('submitted', 'confirmed');
UPDATE "treasury_proposals" SET "status" = 'FAILED' WHERE "status" = 'failed';

ALTER TABLE "treasury_proposals" ALTER COLUMN "status" SET DEFAULT 'PENDING_SIGNATURES';
ALTER TABLE "treasury_proposals" DROP COLUMN "signatures";
