-- Add job tracking fields to Settlement for worker claim/lease/retry management
ALTER TABLE settlements ADD COLUMN job_attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE settlements ADD COLUMN job_claimed_at TIMESTAMP;
ALTER TABLE settlements ADD COLUMN job_eligible_at TIMESTAMP DEFAULT NOW();
ALTER TABLE settlements ADD COLUMN job_error_summary TEXT;

-- Create index for finding claimed/stuck jobs
CREATE INDEX IF NOT EXISTS idx_settlements_job_claimed_at ON settlements(job_claimed_at);
CREATE INDEX IF NOT EXISTS idx_settlements_job_eligible_at ON settlements(job_eligible_at) WHERE job_eligible_at IS NOT NULL;

-- Add job tracking fields to AnchorSession for worker claim/lease/retry management
ALTER TABLE anchor_sessions ADD COLUMN job_attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE anchor_sessions ADD COLUMN job_claimed_at TIMESTAMP;
ALTER TABLE anchor_sessions ADD COLUMN job_eligible_at TIMESTAMP DEFAULT NOW();
ALTER TABLE anchor_sessions ADD COLUMN job_error_summary TEXT;

-- Create index for finding claimed/stuck jobs
CREATE INDEX IF NOT EXISTS idx_anchor_sessions_job_claimed_at ON anchor_sessions(job_claimed_at);
CREATE INDEX IF NOT EXISTS idx_anchor_sessions_job_eligible_at ON anchor_sessions(job_eligible_at) WHERE job_eligible_at IS NOT NULL;
