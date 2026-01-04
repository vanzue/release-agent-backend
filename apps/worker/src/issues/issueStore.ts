import type { Db } from '../db.js';
import type { GithubIssue } from './types.js';
import { createHash } from 'node:crypto';

function contentHash(input: {
  title: string;
  body: string | null;
  labels: string[];
  milestoneTitle: string | null;
  targetVersion: string | null;
}): string {
  const h = createHash('sha256');
  h.update(input.title ?? '');
  h.update('\n');
  h.update(input.body ?? '');
  h.update('\n');
  h.update((input.labels ?? []).slice().sort().join(','));
  h.update('\n');
  h.update(input.milestoneTitle ?? '');
  h.update('\n');
  h.update(input.targetVersion ?? '');
  return h.digest('hex');
}

export async function getIssueSyncState(db: Db, repoFullName: string): Promise<{
  lastSyncedAt: string | null;
  lastSyncedIssueNumber: number | null;
}> {
  const res = await db.pool.query(
    'select last_synced_at, last_synced_issue_number from issue_sync_state where repo = $1',
    [repoFullName]
  );
  const row = res.rows[0];
  return {
    lastSyncedAt: (row?.last_synced_at as string | null | undefined) ?? null,
    lastSyncedIssueNumber: (row?.last_synced_issue_number as number | null | undefined) ?? null,
  };
}

export async function setIssueSyncState(
  db: Db,
  repoFullName: string,
  input: { 
    lastSyncedAt: string | null; 
    lastSyncedIssueNumber: number | null;
  }
): Promise<void> {
  await db.pool.query(
    `
    insert into issue_sync_state (repo, last_synced_at, last_synced_issue_number, updated_at)
    values ($1, $2::timestamptz, $3, now())
    on conflict (repo) do update set
      last_synced_at = excluded.last_synced_at,
      last_synced_issue_number = excluded.last_synced_issue_number,
      updated_at = now()
    `,
    [repoFullName, input.lastSyncedAt, input.lastSyncedIssueNumber]
  );
}

export function extractIssueType(labels: Array<{ name?: string }> | null | undefined): string | null {
  for (const l of labels ?? []) {
    const name = l?.name?.toLowerCase();
    if (name === 'issue-bug') return 'bug';
    if (name === 'issue-feature') return 'feature';
    if (name === 'issue-docs') return 'docs';
    if (name === 'issue-translation') return 'translation';
    if (name === 'issue-task') return 'task';
    if (name === 'issue-refactoring') return 'refactoring';
    if (name === 'issue-dcr') return 'dcr';
    if (name === 'issue-question') return 'question';
  }
  return null;
}

export async function upsertIssue(
  db: Db,
  input: {
    repoFullName: string;
    issue: GithubIssue;
    targetVersion: string | null;
    milestoneTitle: string | null;
  }
): Promise<{ needsEmbedding: boolean }> {
  const labels = (input.issue.labels ?? []).map((l) => l?.name).filter((x): x is string => Boolean(x));
  const body = input.issue.body ?? null;

  const hash = contentHash({
    title: input.issue.title,
    body,
    labels,
    milestoneTitle: input.milestoneTitle,
    targetVersion: input.targetVersion,
  });

  const bodySnip = body ? body.slice(0, 500) : null;
  const reactionsTotal = input.issue.reactions?.total_count ?? 0;
  const issueType = extractIssueType(input.issue.labels);

  const res = await db.pool.query(
    `
    insert into issues (
      repo, issue_number, gh_id,
      title, body, body_snip,
      labels_json, milestone_title, target_version,
      state, created_at, updated_at, closed_at,
      comments_count, reactions_total_count,
      content_hash, fetched_at, issue_type
    )
    values (
      $1, $2, $3,
      $4, $5, $6,
      $7::jsonb, $8, $9,
      $10, $11::timestamptz, $12::timestamptz, $13::timestamptz,
      $14, $15,
      $16, now(), $17
    )
    on conflict (repo, issue_number) do update set
      gh_id = excluded.gh_id,
      title = excluded.title,
      body = excluded.body,
      body_snip = excluded.body_snip,
      labels_json = excluded.labels_json,
      milestone_title = excluded.milestone_title,
      target_version = excluded.target_version,
      state = excluded.state,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      closed_at = excluded.closed_at,
      comments_count = excluded.comments_count,
      reactions_total_count = excluded.reactions_total_count,
      content_hash = excluded.content_hash,
      embedding = case when issues.content_hash <> excluded.content_hash then null else issues.embedding end,
      embedding_model = case when issues.content_hash <> excluded.content_hash then null else issues.embedding_model end,
      fetched_at = now(),
      issue_type = excluded.issue_type
    returning embedding is null as needs_embedding
    `,
    [
      input.repoFullName,
      input.issue.number,
      input.issue.id,
      input.issue.title,
      body,
      bodySnip,
      JSON.stringify(input.issue.labels ?? []),
      input.milestoneTitle,
      input.targetVersion,
      input.issue.state,
      input.issue.created_at,
      input.issue.updated_at,
      input.issue.closed_at,
      input.issue.comments ?? 0,
      reactionsTotal,
      hash,
      issueType,
    ]
  );
  return { needsEmbedding: Boolean(res.rows[0]?.needs_embedding) };
}

export async function replaceIssueProducts(
  db: Db,
  input: { repoFullName: string; issueNumber: number; productLabels: string[] }
): Promise<void> {
  await db.pool.query('delete from issue_products where repo = $1 and issue_number = $2', [
    input.repoFullName,
    input.issueNumber,
  ]);

  const labels = (input.productLabels ?? []).filter(Boolean);
  if (labels.length === 0) return;

  await db.pool.query(
    `
    insert into issue_products (repo, issue_number, product_label)
    select $1, $2, unnest($3::text[])
    on conflict do nothing
    `,
    [input.repoFullName, input.issueNumber, labels]
  );
}
