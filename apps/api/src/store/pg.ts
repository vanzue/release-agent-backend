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

    // -----------------------------
    // Issue clustering (MVP)
    // -----------------------------

    async listIssueVersions(repoFullName: string): Promise<Array<{ targetVersion: string | null; issueCount: number }>> {
      const res = await db.pool.query(
        `
        select target_version, count(*)::int as issue_count
        from issues
        where repo = $1 and state = 'open'
        group by target_version
        `,
        [repoFullName]
      );
      return res.rows.map((r: any) => ({
        targetVersion: (r.target_version as string | null) ?? null,
        issueCount: Number(r.issue_count ?? 0),
      }));
    },

    async listIssueProducts(input: {
      repoFullName: string;
      targetVersion: string | null;
    }): Promise<Array<{ productLabel: string; issueCount: number; clusterCount: number }>> {
      const res = await db.pool.query(
        `
        with product_issue_counts as (
          select p.product_label, count(distinct i.issue_number)::int as issue_count
          from issue_products p
          join issues i on i.repo = p.repo and i.issue_number = p.issue_number
          where i.repo = $1
            and i.state = 'open'
            and i.target_version is not distinct from $2
          group by p.product_label
        )
        select
          pic.product_label,
          pic.issue_count,
          (select count(*)::int from clusters c
           where c.repo = $1
             and c.product_label = pic.product_label) as cluster_count
        from product_issue_counts pic
        order by pic.issue_count desc, pic.product_label asc
        `,
        [input.repoFullName, input.targetVersion]
      );

      return res.rows.map((r: any) => ({
        productLabel: r.product_label as string,
        issueCount: Number(r.issue_count ?? 0),
        clusterCount: Number(r.cluster_count ?? 0),
      }));
    },

    async listIssueClusters(input: {
      repoFullName: string;
      productLabel: string;
    }): Promise<
      Array<{
        clusterId: string;
        size: number;
        updatedAt: string;
        popularity: number;
        representativeIssueNumber: number | null;
        representativeTitle: string | null;
      }>
    > {
      const res = await db.pool.query(
        `
        select
          c.cluster_id,
          c.size,
          c.updated_at,
          c.popularity,
          c.representative_issue_number,
          i.title as representative_title
        from clusters c
        left join issues i on i.repo = c.repo and i.issue_number = c.representative_issue_number
        where c.repo = $1
          and c.product_label = $2
        order by c.popularity desc, c.size desc, c.updated_at desc
        `,
        [input.repoFullName, input.productLabel]
      );
      return res.rows.map((r: any) => ({
        clusterId: r.cluster_id as string,
        size: Number(r.size ?? 0),
        updatedAt: r.updated_at as string,
        popularity: Number(r.popularity ?? 0),
        representativeIssueNumber: (r.representative_issue_number as number | null) ?? null,
        representativeTitle: (r.representative_title as string | null) ?? null,
      }));
    },

    async getIssueCluster(input: {
      repoFullName: string;
      clusterId: string;
    }): Promise<{
      clusterId: string;
      repoFullName: string;
      targetVersion: string | null;
      productLabel: string;
      thresholdUsed: number;
      topkUsed: number;
      size: number;
      popularity: number;
      representativeIssueNumber: number | null;
      updatedAt: string;
    } | null> {
      const res = await db.pool.query(
        `
        select *
        from clusters
        where repo = $1 and cluster_id = $2
        `,
        [input.repoFullName, input.clusterId]
      );
      const r = res.rows[0];
      if (!r) return null;
      return {
        clusterId: r.cluster_id as string,
        repoFullName: r.repo as string,
        targetVersion: null,
        productLabel: r.product_label as string,
        thresholdUsed: Number(r.threshold_used ?? 0),
        topkUsed: Number(r.topk_used ?? 0),
        size: Number(r.size ?? 0),
        popularity: Number(r.popularity ?? 0),
        representativeIssueNumber: (r.representative_issue_number as number | null) ?? null,
        updatedAt: r.updated_at as string,
      };
    },

    async listIssuesInCluster(input: {
      repoFullName: string;
      clusterId: string;
    }): Promise<
      Array<{
        issueNumber: number;
        title: string;
        state: 'open' | 'closed';
        labelsJson: any;
        updatedAt: string;
        similarity: number;
      }>
    > {
      const res = await db.pool.query(
        `
        select
          i.issue_number,
          i.title,
          i.state,
          i.labels_json,
          i.updated_at,
          m.similarity
        from issue_cluster_map m
        join issues i on i.repo = m.repo and i.issue_number = m.issue_number
        where m.repo = $1 and m.cluster_id = $2
        order by m.similarity desc, i.updated_at desc, i.issue_number asc
        `,
        [input.repoFullName, input.clusterId]
      );
      return res.rows.map((r: any) => ({
        issueNumber: Number(r.issue_number),
        title: r.title as string,
        state: r.state as 'open' | 'closed',
        labelsJson: r.labels_json,
        updatedAt: r.updated_at as string,
        similarity: Number(r.similarity ?? 0),
      }));
    },

    async searchIssues(input: {
      repoFullName: string;
      targetVersion: string | null;
      productLabels?: string[];
      state?: 'open' | 'closed';
      clusterId?: string;
      q?: string;
      limit?: number;
      offset?: number;
    }): Promise<
      Array<{
        issueNumber: number;
        title: string;
        state: 'open' | 'closed';
        targetVersion: string | null;
        labelsJson: any;
        productLabels: string[];
        updatedAt: string;
      }>
    > {
      const conditions: string[] = ['i.repo = $1'];
      const params: any[] = [input.repoFullName];

      if (input.targetVersion !== undefined) {
        params.push(input.targetVersion);
        conditions.push(`i.target_version is not distinct from $${params.length}`);
      }

      if (input.state) {
        params.push(input.state);
        conditions.push(`i.state = $${params.length}`);
      }

      if (input.clusterId) {
        params.push(input.clusterId);
        conditions.push(`m.cluster_id = $${params.length}`);
      }

      if (input.productLabels && input.productLabels.length > 0) {
        params.push(input.productLabels);
        conditions.push(`p.product_label = any($${params.length}::text[])`);
      }

      if (input.q && input.q.trim()) {
        params.push(`%${input.q.trim()}%`);
        conditions.push(`(i.title ilike $${params.length} or i.body ilike $${params.length})`);
      }

      const limit = Math.min(input.limit ?? 50, 200);
      const offset = input.offset ?? 0;
      params.push(limit);
      params.push(offset);

      const sql = `
        select
          i.issue_number,
          i.title,
          i.state,
          i.target_version,
          i.labels_json,
          i.updated_at,
          array_agg(distinct p.product_label) as product_labels
        from issues i
        left join issue_products p on p.repo = i.repo and p.issue_number = i.issue_number
        left join issue_cluster_map m on m.repo = i.repo and m.issue_number = i.issue_number
        where ${conditions.join(' and ')}
        group by i.issue_number, i.title, i.state, i.target_version, i.labels_json, i.updated_at
        order by i.updated_at desc, i.issue_number asc
        limit $${params.length - 1} offset $${params.length}
      `;

      const res = await db.pool.query(sql, params);
      return res.rows.map((r: any) => ({
        issueNumber: Number(r.issue_number),
        title: r.title as string,
        state: r.state as 'open' | 'closed',
        targetVersion: (r.target_version as string | null) ?? null,
        labelsJson: r.labels_json,
        productLabels: (r.product_labels as string[] | null) ?? [],
        updatedAt: r.updated_at as string,
      }));
    },

    async getIssueSyncStatus(repoFullName: string): Promise<{
      currentCount: number;
      estimatedTotal: number | null;
      isSyncing: boolean;
      lastSyncedAt: string | null;
      progress: number;
    }> {
      const countRes = await db.pool.query(
        'SELECT COUNT(*) as cnt FROM issues WHERE repo = $1',
        [repoFullName]
      );
      const currentCount = Number(countRes.rows[0]?.cnt ?? 0);
      
      const stateRes = await db.pool.query(
        'SELECT estimated_total_issues, is_syncing, last_synced_at FROM issue_sync_state WHERE repo = $1',
        [repoFullName]
      );
      const row = stateRes.rows[0];
      const estimatedTotal = row?.estimated_total_issues ? Number(row.estimated_total_issues) : null;
      const isSyncing = Boolean(row?.is_syncing);
      const lastSyncedAt = row?.last_synced_at as string | null ?? null;
      
      // Calculate progress
      let progress = 0;
      if (estimatedTotal && estimatedTotal > 0) {
        progress = Math.min(100, Math.floor((currentCount / estimatedTotal) * 100));
      } else if (currentCount > 0) {
        progress = isSyncing ? 50 : 100; // Unknown total, show 50% if syncing
      }
      
      return {
        currentCount,
        estimatedTotal,
        isSyncing,
        lastSyncedAt,
        progress,
      };
    },

    async getIssueStats(repoFullName: string): Promise<{
      totalIssues: number;
      openIssues: number;
      embeddedOpenIssues: number;
    }> {
      const res = await db.pool.query(
        `
        select
          count(*)::int as total_issues,
          count(*) filter (where state = 'open')::int as open_issues,
          count(*) filter (where state = 'open' and embedding is not null)::int as embedded_open_issues
        from issues
        where repo = $1
        `,
        [repoFullName]
      );
      const row = res.rows[0] ?? {};
      return {
        totalIssues: Number(row.total_issues ?? 0),
        openIssues: Number(row.open_issues ?? 0),
        embeddedOpenIssues: Number(row.embedded_open_issues ?? 0),
      };
    },
  };
}

export type PgStore = ReturnType<typeof createPgStore>;
