-- Add explicit timestamps for settlement state transitions.
-- submitted_at is set when the user submits a signed XDR (pending -> submitted).
-- confirmed_at is set when Horizon confirms the transaction (verifying -> confirmed).
ALTER TABLE "settlements"
  ADD COLUMN "submitted_at" TIMESTAMP(3),
  ADD COLUMN "confirmed_at" TIMESTAMP(3);
