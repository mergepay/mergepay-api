-- AddIndex
CREATE INDEX "expenses_group_id_created_at_idx" ON "expenses"("group_id", "created_at");

-- AddIndex
CREATE INDEX "settlements_created_at_idx" ON "settlements"("created_at");

-- AddIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- AddIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");
