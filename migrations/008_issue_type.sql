-- 008_issue_type.sql

-- Add issue_type field to issues table
-- Extracted from labels like Issue-Bug, Issue-Feature, Issue-Docs, etc.

alter table issues
  add column if not exists issue_type text null;

-- Create index for filtering by issue_type
create index if not exists issues_repo_issue_type_idx 
  on issues (repo, issue_type) 
  where issue_type is not null;
