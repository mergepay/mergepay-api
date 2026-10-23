-- CreateIndex
-- Audit reads filter by action type and order by time (newest first), so the
-- composite index serves the filter and the sort together.
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at");
