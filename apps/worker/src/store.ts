import type { Pool } from 'pg';

/**
 * Database wrapper type.
 */
export interface Db {
  pool: Pool;
}

/**
 * Update job status and progress.
 */
export async function setJob(
  db: Db,
  sessionId: string,
  type: string,
  status: string,
  progress: number,
  error?: string | null
) {
  const now = new Date().toISOString();
  const startedAt = status === 'running' ? now : null;
  const completedAt = status === 'completed' || status === 'failed' || status === 'skipped' ? now : null;

  await db.pool.query(
    `
    update jobs
    set status = $3,
        progress = $4,
        started_at = coalesce(started_at, $5::timestamptz),
        completed_at = case when $6::timestamptz is null then completed_at else $6::timestamptz end,
        error = $7
    where session_id = $1 and type = $2
    `,
    [sessionId, type, status, progress, startedAt, completedAt, error ?? null]
  );
}

/**
 * Update session status.
 */
export async function setSessionStatus(db: Db, sessionId: string, status: string) {
  await db.pool.query('update sessions set status = $2, updated_at = now() where id = $1', [sessionId, status]);
}

/**
 * Upsert an artifact for a session.
 */
export async function upsertArtifact(db: Db, sessionId: string, kind: string, data: unknown) {
  await db.pool.query(
    `
    insert into session_artifacts (session_id, kind, data, updated_at)
    values ($1, $2, $3::jsonb, now())
    on conflict (session_id, kind) do update set
      data = excluded.data,
      updated_at = now()
    `,
    [sessionId, kind, JSON.stringify(data ?? {})]
  );
}

/**
 * Get an artifact for a session.
 */
export async function getArtifact(db: Db, sessionId: string, kind: string) {
  const res = await db.pool.query(
    'select data from session_artifacts where session_id = $1 and kind = $2',
    [sessionId, kind]
  );
  return res.rows[0]?.data ?? null;
}

/**
 * Update session stats (partial merge).
 */
export async function setSessionStats(db: Db, sessionId: string, statsPatch: Record<string, number>) {
  await db.pool.query(
    `
    update sessions
    set stats = stats || $2::jsonb,
        updated_at = now()
    where id = $1
    `,
    [sessionId, JSON.stringify(statsPatch)]
  );
}

/**
 * Load a session by ID.
 */
export async function loadSession(db: Db, sessionId: string) {
  const sessionRes = await db.pool.query('select * from sessions where id = $1', [sessionId]);
  const session = sessionRes.rows[0];
  if (!session) return null;

  return {
    session,
    repoFullName: session.repo_full_name as string,
    baseRef: session.base_ref as string,
    headRef: session.head_ref as string,
  };
}

/**
 * Set commit summary status (ready/regenerating).
 */
export async function setCommitSummaryStatus(
  db: Db,
  repoFullName: string,
  commitSha: string,
  status: 'ready' | 'regenerating'
) {
  await db.pool.query(
    'update commit_summaries set status = $3, updated_at = now() where repo_full_name = $1 and commit_sha = $2',
    [repoFullName, commitSha, status]
  );
}
