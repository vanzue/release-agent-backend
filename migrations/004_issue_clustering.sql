-- 004_issue_clustering.sql

-- Vector support for embeddings/centroids (pgvector)
create extension if not exists vector;

-- Track incremental sync progress per repo.
create table if not exists issue_sync_state (
  repo text primary key,
  last_synced_at timestamptz null,
  updated_at timestamptz not null default now()
);

-- GitHub issues (excluding PRs).
create table if not exists issues (
  repo text not null,
  issue_number int not null,
  gh_id bigint not null,

  title text not null,
  body text null,
  body_snip text null,

  labels_json jsonb not null default '[]'::jsonb,
  milestone_title text null,
  target_version text null,

  state text not null check (state in ('open','closed')),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  closed_at timestamptz null,

  comments_count int not null default 0,
  reactions_total_count int not null default 0,

  content_hash text not null,
  embedding_model text null,
  embedding vector null,

  fetched_at timestamptz not null default now(),

  primary key (repo, issue_number)
);

create index if not exists issues_repo_target_version_updated_at_idx on issues (repo, target_version, updated_at desc);
create index if not exists issues_repo_state_updated_at_idx on issues (repo, state, updated_at desc);

-- Product labels per issue. An issue can belong to multiple products.
create table if not exists issue_products (
  repo text not null,
  issue_number int not null,
  product_label text not null,
  primary key (repo, issue_number, product_label),
  foreign key (repo, issue_number) references issues(repo, issue_number) on delete cascade
);

create index if not exists issue_products_repo_product_label_idx on issue_products (repo, product_label);

-- Clusters are scoped to a (repo, target_version, product_label) bucket.
create table if not exists clusters (
  cluster_id uuid primary key default gen_random_uuid(),
  repo text not null,
  target_version text null,
  product_label text not null,

  threshold_used float not null,
  topk_used int not null,

  centroid vector not null,
  size int not null default 0,
  popularity float not null default 0,
  representative_issue_number int null,

  updated_at timestamptz not null default now()
);

create index if not exists clusters_repo_target_version_product_label_idx
  on clusters (repo, target_version, product_label);

-- Map issues into clusters per bucket.
create table if not exists issue_cluster_map (
  repo text not null,
  issue_number int not null,
  target_version text null,
  product_label text not null,
  cluster_id uuid not null references clusters(cluster_id) on delete cascade,
  similarity float not null,
  assigned_at timestamptz not null default now(),
  primary key (repo, issue_number, target_version, product_label),
  foreign key (repo, issue_number) references issues(repo, issue_number) on delete cascade
);

create index if not exists issue_cluster_map_repo_bucket_cluster_id_idx
  on issue_cluster_map (repo, target_version, product_label, cluster_id);

