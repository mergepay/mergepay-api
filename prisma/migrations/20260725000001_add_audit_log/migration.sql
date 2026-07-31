-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN "group_id" TEXT,
ADD COLUMN "details" JSONB,
ALTER COLUMN "entity_type" DROP NOT NULL,
ALTER COLUMN "entity_id" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "audit_logs_group_id_idx" ON "audit_logs"("group_id");

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
