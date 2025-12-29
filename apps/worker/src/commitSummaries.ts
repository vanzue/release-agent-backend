import type { Db } from './store.js';

export type CommitSummaryRow = {
  repoFullName: string;
  commitSha: string;
  summaryText: string;
  creditedLogin: string | null;
  prNumber: number | null;
};

/**
 * Batch fetch existing commit summaries for given SHAs.
 * Returns a Map of commitSha -> CommitSummaryRow.
 */
export async function getCommitSummaries(
  db: Db,
  repoFullName: string,
  commitShas: string[]
): Promise<Map<string, CommitSummaryRow>> {
  if (commitShas.length === 0) return new Map();

  const result = await db.pool.query(
    `
    select commit_sha, summary_text, credited_login, pr_number
    from commit_summaries
    where repo_full_name = $1 and commit_sha = any($2::text[])
    `,
    [repoFullName, commitShas]
  );

  const map = new Map<string, CommitSummaryRow>();
  for (const row of result.rows) {
    map.set(row.commit_sha, {
      repoFullName,
      commitSha: row.commit_sha,
      summaryText: row.summary_text,
      creditedLogin: row.credited_login,
      prNumber: row.pr_number,
    });
  }
  return map;
}

export async function upsertCommitSummary(
  db: Db,
  row: CommitSummaryRow
) {
  await db.pool.query(
    `
    insert into commit_summaries (repo_full_name, commit_sha, summary_text, credited_login, pr_number, updated_at)
    values ($1, $2, $3, $4, $5, now())
    on conflict (repo_full_name, commit_sha) do update set
      summary_text = excluded.summary_text,
      credited_login = excluded.credited_login,
      pr_number = excluded.pr_number,
      updated_at = now()
    `,
    [row.repoFullName, row.commitSha, row.summaryText, row.creditedLogin, row.prNumber]
  );
}

