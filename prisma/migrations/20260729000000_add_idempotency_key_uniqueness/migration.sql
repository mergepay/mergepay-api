-- Ensure an idempotency key is unique for an authenticated user and operation.
-- The scope prevents a key used by one endpoint from colliding with another.
CREATE UNIQUE INDEX IF NOT EXISTS "IdempotencyKey_userId_scope_key_key"
ON "IdempotencyKey" ("userId", "scope", "key");
