-- Worker-query indexes (issue #200).
--
-- Each index below mirrors the actual filter/order of a high-frequency
-- worker or sweep query in src/worker/index.ts and src/worker/*.ts, so the
-- database can serve those queries without scanning the table:

-- recoverStaleSettlements(): status IN (submitted, verifying) AND
-- lease_expires_at < now. The composite covers both the status filter and
-- the expired-lease predicate in one index.
CREATE INDEX IF NOT EXISTS "settlements_status_lease_expires_at_idx"
  ON "settlements" ("status", "lease_expires_at");

-- recoverStaleAnchorSessions(): lease_expires_at < now. Anchor sessions had
-- no index on this column at all, so every recovery sweep scanned the table.
CREATE INDEX IF NOT EXISTS "anchor_sessions_lease_expires_at_idx"
  ON "anchor_sessions" ("lease_expires_at");

-- expireInvites(): expires_at IS NOT NULL AND expires_at < now.
CREATE INDEX IF NOT EXISTS "invites_expires_at_idx"
  ON "invites" ("expires_at");

-- expireStaleProposals(): status = 'pending' AND created_at < cutoff
-- ORDER BY created_at ASC (oldest first). The composite matches the sweep's
-- filter and its sort order in one index.
CREATE INDEX IF NOT EXISTS "treasury_proposals_status_created_at_idx"
  ON "treasury_proposals" ("status", "created_at");
