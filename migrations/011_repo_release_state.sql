-- 011_repo_release_state.sql
-- Persist latest GitHub release metadata per repository for dashboard scoping.

create table if not exists repo_release_state (
  repo text primary key,
  latest_release_tag text null,
  latest_release_name text null,
  latest_release_url text null,
  latest_release_version text null,
  latest_release_published_at timestamptz null,
  updated_at timestamptz not null default now()
);
