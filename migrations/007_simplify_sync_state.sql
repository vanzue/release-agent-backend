-- 007_simplify_sync_state.sql

-- Add estimated_total_issues and is_syncing to issue_sync_state
-- These replace the separate issue_jobs table for tracking sync progress

alter table issue_sync_state
  add column if not exists estimated_total_issues int null,
  add column if not exists is_syncing boolean not null default false;

-- Drop issue_jobs table as it's no longer needed
-- Progress is now tracked via issue_sync_state.is_syncing + COUNT(*) from issues
drop table if exists issue_jobs;
