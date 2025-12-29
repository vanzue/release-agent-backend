-- 002_commit_summary_status.sql
-- Add status field to track regeneration state of commit summaries

alter table commit_summaries
  add column if not exists status text not null default 'ready'
  check (status in ('ready', 'regenerating'));

-- Index for finding items being regenerated
create index if not exists commit_summaries_status_idx on commit_summaries (status) where status = 'regenerating';
