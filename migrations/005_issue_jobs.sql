-- 005_issue_jobs.sql

create table if not exists issue_jobs (
  id uuid primary key default gen_random_uuid(),
  repo text not null,
  type text not null check (type in ('issue-sync','issue-recluster')),
  status text not null check (status in ('running','completed','failed')),
  progress int not null default 0,
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  error text null,
  started_at timestamptz not null default now(),
  completed_at timestamptz null,
  updated_at timestamptz not null default now()
);

create index if not exists issue_jobs_repo_started_at_idx on issue_jobs (repo, started_at desc);
