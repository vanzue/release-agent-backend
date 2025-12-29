-- Add 'skipped' status to jobs table

-- Drop existing check constraint and recreate with new values
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check 
  CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped'));
