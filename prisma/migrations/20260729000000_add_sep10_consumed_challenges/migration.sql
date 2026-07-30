CREATE TABLE "Sep10ConsumedChallenge" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Sep10ConsumedChallenge_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Sep10ConsumedChallenge_expiresAt_idx"
    ON "Sep10ConsumedChallenge"("expiresAt");
