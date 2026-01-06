-- 009_session_failed_status.sql
-- Add 'failed' status to sessions table

ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_status_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_status_check 
  CHECK (status IN ('draft', 'generating', 'ready', 'exported', 'failed'));
