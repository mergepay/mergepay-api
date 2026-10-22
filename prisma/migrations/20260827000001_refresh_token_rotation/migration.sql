-- Rotating single-use refresh tokens for SEP-10 sessions.
--
-- Only the SHA-256 hash of a token is stored, so a leaked row is not itself a
-- usable credential. The unique index on "token_hash" is also the concurrency
-- control for rotation: two requests racing to redeem the same token both try
-- to mark it rotated, and only one can win.
--
-- "family_id" ties every token descended from one SEP-10 login together. When
-- an already-rotated token is presented again — the signature of a stolen
-- token being replayed — the whole family is revoked rather than just the
-- token presented, because there is no way to tell the thief's copy from the
-- legitimate holder's. See src/services/refresh-token.ts.

CREATE TABLE IF NOT EXISTS "refresh_tokens" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotated_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "refresh_tokens_token_hash_key"
    ON "refresh_tokens"("token_hash");

-- Revoking a compromised chain reads every token sharing its family.
CREATE INDEX IF NOT EXISTS "refresh_tokens_family_id_idx"
    ON "refresh_tokens"("family_id");

-- Logout revokes every live token belonging to one user.
CREATE INDEX IF NOT EXISTS "refresh_tokens_user_id_idx"
    ON "refresh_tokens"("user_id");

-- Expired tokens carry no value and are swept.
CREATE INDEX IF NOT EXISTS "refresh_tokens_expires_at_idx"
    ON "refresh_tokens"("expires_at");

ALTER TABLE "refresh_tokens"
    ADD CONSTRAINT "refresh_tokens_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
