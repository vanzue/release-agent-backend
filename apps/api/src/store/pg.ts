import type { Db } from '../db.js';
import { randomUUID } from 'node:crypto';

type SessionStatus = 'draft' | 'generating' | 'ready' | 'exported';
type JobStatus = 'pending' | 'running' | 'completed' | 'failed';
type JobType = 'parse-changes' | 'generate-notes' | 'analyze-hotspots' | 'generate-testplan';

export type Session = {
  id: string;
  repoFullName: string;
  name: string;
  status: SessionStatus;
  baseRef: string;
  headRef: string;
  options: {
    normalizeBy?: 'pr' | 'commit';
    outputLanguage?: 'english' | 'chinese' | 'bilingual';
    strictMode?: boolean;
  };
  stats: {
    changeCount: number;
    releaseNotesCount: number;
    hotspotsCount: number;
    testCasesCount: number;
  };
  createdAt: string;
  updatedAt: string;
};

export type Job = {
  id: string;
  sessionId: string;
  type: JobType;
  status: JobStatus;
  progress: number;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
};

function mapSession(row: any): Session {
  return {
    id: row.id,
    repoFullName: row.repo_full_name,
    name: row.name,
    status: row.status,
    baseRef: row.base_ref,
    headRef: row.head_ref,
    options: row.options ?? {},
    stats: row.stats ?? { changeCount: 0, releaseNotesCount: 0, hotspotsCount: 0, testCasesCount: 0 },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapJob(row: any): Job {
  return {
    id: row.id,
    sessionId: row.session_id,
    type: row.type,
    status: row.status,
    progress: row.progress,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: row.error,
  };
}

export function createPgStore(db: Db) {
  async function listSessions(): Promise<Session[]> {
    const res = await db.pool.query('select * from sessions order by created_at desc');
    return res.rows.map(mapSession);
  }

  async function createSession(input: {
      repoFullName: string;
      name: string;
      baseRef: string;
      headRef: string;
      options: Session['options'];
    }): Promise<Session> {
      const sessionId = randomUUID();

      const sessionRes = await db.pool.query(
        `
        insert into sessions (id, repo_full_name, name, status, base_ref, head_ref, options)
        values ($1, $2, $3, 'generating', $4, $5, $6::jsonb)
        returning *
        `,
        [sessionId, input.repoFullName, input.name, input.baseRef, input.headRef, JSON.stringify(input.options ?? {})]
      );

      const jobTypes: JobType[] = ['parse-changes', 'generate-notes', 'analyze-hotspots', 'generate-testplan'];
      await db.pool.query(
        `
        insert into jobs (id, session_id, type, status, progress)
        select gen_random_uuid(), $1, unnest($2::text[]), 'pending', 0
        `,
        [sessionId, jobTypes]
      );

      return mapSession(sessionRes.rows[0]);
  }

  return {
    listSessions,
    createSession,

    async getSession(sessionId: string): Promise<Session | null> {
      const res = await db.pool.query('select * from sessions where id = $1', [sessionId]);
      return res.rows[0] ? mapSession(res.rows[0]) : null;
    },

    async deleteSession(sessionId: string): Promise<boolean> {
      const res = await db.pool.query('delete from sessions where id = $1 returning id', [sessionId]);
      return res.rowCount !== null && res.rowCount > 0;
    },

    async listJobs(sessionId: string): Promise<Job[]> {
      const res = await db.pool.query('select * from jobs where session_id = $1 order by type asc', [sessionId]);
      return res.rows.map(mapJob);
    },

    async getArtifact(sessionId: string, kind: 'changes' | 'release-notes' | 'hotspots' | 'test-plan') {
      const res = await db.pool.query(
        'select data from session_artifacts where session_id = $1 and kind = $2',
        [sessionId, kind]
      );
      return res.rows[0]?.data ?? null;
    },

    async upsertArtifact(sessionId: string, kind: 'changes' | 'release-notes' | 'hotspots' | 'test-plan', data: any) {
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
    },

    async getCommitSummary(repoFullName: string, commitSha: string) {
      const res = await db.pool.query(
        'select summary_text, credited_login, pr_number, status from commit_summaries where repo_full_name = $1 and commit_sha = $2',
        [repoFullName, commitSha]
      );
      if (!res.rows[0]) return null;
      return {
        summaryText: res.rows[0].summary_text as string,
        creditedLogin: res.rows[0].credited_login as string | null,
        prNumber: res.rows[0].pr_number as number | null,
        status: res.rows[0].status as 'ready' | 'regenerating',
      };
    },

    async setCommitSummaryStatus(repoFullName: string, commitSha: string, status: 'ready' | 'regenerating') {
      await db.pool.query(
        'update commit_summaries set status = $3, updated_at = now() where repo_full_name = $1 and commit_sha = $2',
        [repoFullName, commitSha, status]
      );
    },

    async upsertCommitSummary(row: {
      repoFullName: string;
      commitSha: string;
      summaryText: string;
      creditedLogin: string | null;
      prNumber: number | null;
    }) {
      await db.pool.query(
        `
        insert into commit_summaries (repo_full_name, commit_sha, summary_text, credited_login, pr_number, status, updated_at)
        values ($1, $2, $3, $4, $5, 'ready', now())
        on conflict (repo_full_name, commit_sha) do update set
          summary_text = excluded.summary_text,
          credited_login = excluded.credited_login,
          pr_number = excluded.pr_number,
          status = 'ready',
          updated_at = now()
        `,
        [row.repoFullName, row.commitSha, row.summaryText, row.creditedLogin, row.prNumber]
      );
    },
  };
}

export type PgStore = ReturnType<typeof createPgStore>;
