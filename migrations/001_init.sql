-- 001_init.sql

create extension if not exists pgcrypto;

create table if not exists schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  repo_full_name text not null,
  name text not null,
  status text not null check (status in ('draft', 'generating', 'ready', 'exported')),
  base_ref text not null,
  head_ref text not null,
  -- Resolved SHAs populated after ref resolution.
  base_sha text null,
  head_sha text null,
  -- Dedupe key: hash(repo_full_name + base_sha + head_sha). Used to avoid regenerating for same commit range.
  run_key text null,
  options jsonb not null default '{}'::jsonb,
  stats jsonb not null default '{"changeCount":0,"releaseNotesCount":0,"hotspotsCount":0,"testCasesCount":0}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sessions_status_idx on sessions (status);
create index if not exists sessions_repo_full_name_idx on sessions (repo_full_name);
create index if not exists sessions_run_key_idx on sessions (run_key);

create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  type text not null check (type in ('parse-changes','generate-notes','analyze-hotspots','generate-testplan')),
  status text not null check (status in ('pending','running','completed','failed')),
  progress int not null default 0 check (progress >= 0 and progress <= 100),
  started_at timestamptz null,
  completed_at timestamptz null,
  error text null
);

create index if not exists jobs_session_id_idx on jobs (session_id);
create index if not exists jobs_status_idx on jobs (status);

-- Store generated artifacts as JSON documents for MVP.
create table if not exists session_artifacts (
  session_id uuid not null references sessions(id) on delete cascade,
  kind text not null check (kind in ('changes','release-notes','hotspots','test-plan')),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (session_id, kind)
);

create table if not exists exports (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  created_at timestamptz not null default now(),
  results jsonb not null default '{}'::jsonb
);

-- Cache one summary per (repo, commit sha). Overwritten on regenerate.
create table if not exists commit_summaries (
  repo_full_name text not null,
  commit_sha text not null,
  summary_text text not null,
  credited_login text null,
  pr_number int null,
  updated_at timestamptz not null default now(),
  primary key (repo_full_name, commit_sha)
);

create index if not exists commit_summaries_updated_at_idx on commit_summaries (updated_at desc);
