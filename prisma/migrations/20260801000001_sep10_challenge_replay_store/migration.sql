-- Single-use redemption for SEP-10 challenges.
--
-- The unique index on "fingerprint" is the concurrency control: verification
-- inserts a row and whichever request lands it first has authenticated, so a
-- replayed (or concurrently verified) challenge conflicts and is rejected.
-- See src/services/sep10.ts.

CREATE TABLE IF NOT EXISTS "sep10_challenges" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "client_account" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sep10_challenges_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "sep10_challenges_fingerprint_key"
    ON "sep10_challenges"("fingerprint");

-- Redeemed challenges past their window carry no security value and are swept.
CREATE INDEX IF NOT EXISTS "sep10_challenges_expires_at_idx"
    ON "sep10_challenges"("expires_at");

-- Superseded by the table above; the earlier name was never referenced by the
-- Prisma schema.
DROP TABLE IF EXISTS "Sep10ConsumedChallenge";
