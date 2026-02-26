-- 010_issue_embedding_dedup.sql
-- Add hash key for embedding input so we can reuse vectors for identical issue text.

alter table if exists issues
  add column if not exists embedding_input_hash text null;

update issues
set embedding_input_hash = encode(
  digest(
    trim(coalesce(title, '') || E'\n\n' || left(trim(coalesce(body, '')), 12000)),
    'sha256'
  ),
  'hex'
)
where embedding_input_hash is null;

create index if not exists issues_repo_embedding_model_input_hash_idx
  on issues (repo, embedding_model, embedding_input_hash)
  where embedding is not null and embedding_input_hash is not null;
