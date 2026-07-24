CREATE TABLE "invitations" (
  "id" TEXT NOT NULL,
  "group_id" TEXT NOT NULL,
  "invitee_public_key" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "invitations_group_id_invitee_public_key_status_key" ON "invitations"("group_id", "invitee_public_key", "status");
CREATE INDEX "invitations_group_id_idx" ON "invitations"("group_id");

ALTER TABLE "invitations" ADD CONSTRAINT "invitations_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
