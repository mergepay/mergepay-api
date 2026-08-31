-- Webhook endpoints and their delivery queue.
--
-- src/services/webhook.ts already reached for these tables through
-- `(prisma as any)`, which type-checked but had no schema behind it, so any
-- call to it failed at runtime. This migration creates what that code
-- expects and adds the durable delivery state the worker needs.

CREATE TABLE IF NOT EXISTS "webhooks" (
  "id"         TEXT NOT NULL,
  "group_id"   TEXT,
  "user_id"    TEXT,
  "url"        TEXT NOT NULL,
  "secret"     TEXT NOT NULL,
  "events"     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "enabled"    BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "webhooks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "webhooks_group_id_idx" ON "webhooks" ("group_id");
CREATE INDEX IF NOT EXISTS "webhooks_user_id_idx"  ON "webhooks" ("user_id");
CREATE INDEX IF NOT EXISTS "webhooks_enabled_idx"  ON "webhooks" ("enabled");

CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
  "id"                   TEXT NOT NULL,
  "webhook_id"           TEXT NOT NULL,
  "event_type"           TEXT NOT NULL,
  "payload"              TEXT NOT NULL,
  "status"               TEXT NOT NULL DEFAULT 'pending',
  "attempts"             INTEGER NOT NULL DEFAULT 0,
  "response_status_code" INTEGER,
  "response_body"        TEXT,
  "next_attempt_at"      TIMESTAMP(3),
  "last_attempt_at"      TIMESTAMP(3),
  "claimed_by"           TEXT,
  "lease_expires_at"     TIMESTAMP(3),
  "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "webhook_deliveries_webhook_id_idx" ON "webhook_deliveries" ("webhook_id");
-- The worker's claim query: pending rows whose backoff has elapsed.
CREATE INDEX IF NOT EXISTS "webhook_deliveries_status_next_attempt_at_idx"
  ON "webhook_deliveries" ("status", "next_attempt_at");
-- Recovering deliveries abandoned by a crashed worker.
CREATE INDEX IF NOT EXISTS "webhook_deliveries_lease_expires_at_idx"
  ON "webhook_deliveries" ("lease_expires_at");

-- Deleting a group, user, or endpoint takes its webhooks and their delivery
-- history with it; a delivery record has no meaning without its endpoint.
ALTER TABLE "webhooks"
  ADD CONSTRAINT "webhooks_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "groups" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "webhooks"
  ADD CONSTRAINT "webhooks_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "webhook_deliveries"
  ADD CONSTRAINT "webhook_deliveries_webhook_id_fkey"
  FOREIGN KEY ("webhook_id") REFERENCES "webhooks" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
