-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN "actor_type" TEXT NOT NULL DEFAULT 'user';
