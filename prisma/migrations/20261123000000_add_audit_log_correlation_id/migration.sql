-- Add request/job correlation IDs to audit logs for incident tracing.
ALTER TABLE "audit_logs" ADD COLUMN "correlation_id" TEXT;

CREATE INDEX "audit_logs_correlation_id_idx" ON "audit_logs"("correlation_id");
