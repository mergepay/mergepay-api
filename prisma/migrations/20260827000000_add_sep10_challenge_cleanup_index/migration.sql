-- Supports the worker's retention query for consumed and expired SEP-10 challenges.
CREATE INDEX IF NOT EXISTS "sep10_challenges_consumed_at_expires_at_idx"
    ON "sep10_challenges"("consumed_at", "expires_at");
