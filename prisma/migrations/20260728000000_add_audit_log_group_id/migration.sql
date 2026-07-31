-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN "group_id" TEXT;

-- CreateIndex
CREATE INDEX "audit_logs_group_id_created_at_idx" ON "audit_logs"("group_id", "created_at");

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
