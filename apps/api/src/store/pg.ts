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

function parseVersionTuple(version: string | null | undefined): [number, number, number] | null {
  if (!version) return null;
  const match = version.match(/^(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = Number.parseInt(match[3] ?? '0', 10);

  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null;
  if (major !== 0) return null;
  if (minor < 0 || minor > 299) return null;
  if (patch < 0 || patch > 99) return null;

  return [major, minor, patch];
}

function compareVersionTuple(a: [number, number, number], b: [number, number, number]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}

function latestVersionFromList(versions: Array<string | null>): string | null {
  let best: string | null = null;
  let bestTuple: [number, number, number] | null = null;

  for (const version of versions) {
    const tuple = parseVersionTuple(version);
    if (!tuple) continue;
    if (!bestTuple || compareVersionTuple(tuple, bestTuple) > 0) {
      best = version;
      bestTuple = tuple;
    }
  }

  return best;
}

function buildVersionCandidates(version: string | null): string[] {
  if (!version) return [];
  const tuple = parseVersionTuple(version);
  if (!tuple) return [version];

  const majorMinor = `${tuple[0]}.${tuple[1]}`;
  const full = `${tuple[0]}.${tuple[1]}.${tuple[2]}`;
  if (version === majorMinor) return [majorMinor, full];
  return [full, majorMinor];
}

function pickPrimaryProductLabel(issues: Array<{ productLabels: string[] }>): string | null {
  const scores = new Map<string, number>();
  for (const issue of issues) {
    for (const label of issue.productLabels) {
      scores.set(label, (scores.get(label) ?? 0) + 1);
    }
  }

  let bestLabel: string | null = null;
  let bestScore = -1;
  for (const [label, score] of scores.entries()) {
    if (score > bestScore) {
      bestLabel = label;
      bestScore = score;
    }
  }
  return bestLabel;
}

function isCanonicalPowertoysVersion(version: string | null | undefined): boolean {
  return parseVersionTuple(version) !== null;
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
        where repo = $1
          and state = 'open'
          and (target_version is null or target_version ~ '^0\\.(?:[0-9]|[1-9][0-9]|[1-2][0-9]{2})(?:\\.[0-9]{1,2})?$')
        group by target_version
        order by
          -- Sort by numeric version parts: major.minor.patch
          (regexp_match(target_version, '^(\\d+)'))[1]::int desc nulls last,
          (regexp_match(target_version, '^\\d+\\.(\\d+)'))[1]::int desc nulls last,
          (regexp_match(target_version, '^\\d+\\.\\d+\\.(\\d+)'))[1]::int desc nulls last,
          target_version desc nulls last
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
      targetVersion: string | null | undefined; // undefined = all versions
    }): Promise<Array<{ productLabel: string; issueCount: number; clusterCount: number }>> {
      const filterByVersion = input.targetVersion !== undefined;
      const res = await db.pool.query(
        `
        with product_issue_counts as (
          select p.product_label, count(distinct i.issue_number)::int as issue_count
          from issue_products p
          join issues i on i.repo = p.repo and i.issue_number = p.issue_number
          where i.repo = $1
            and i.state = 'open'
            and (i.target_version is null or i.target_version ~ '^0\\.(?:[0-9]|[1-9][0-9]|[1-2][0-9]{2})(?:\\.[0-9]{1,2})?$')
            and ($2::boolean = false or i.target_version is not distinct from $3)
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
        [input.repoFullName, filterByVersion, input.targetVersion ?? null]
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

    async getIssueDashboard(input: {
      repoFullName: string;
      semanticLimit?: number;
      issuesPerSemantic?: number;
      minSimilarity?: number;
    }): Promise<{
      latestRelease: {
        tag: string | null;
        name: string | null;
        url: string | null;
        publishedAt: string | null;
        version: string | null;
        versionCandidates: string[];
        source: 'github_release' | 'issues_fallback' | 'none';
      };
      hottestIssue: {
        issueNumber: number;
        title: string;
        state: 'open' | 'closed';
        updatedAt: string;
        reactionsCount: number;
        commentsCount: number;
        hotScore: number;
        productLabels: string[];
      } | null;
      semanticGroups: Array<{
        semanticId: string;
        productLabel: string | null;
        representativeIssueNumber: number;
        representativeTitle: string;
        hotScore: number;
        issueCount: number;
        openIssueCount: number;
        issues: Array<{
          issueNumber: number;
          title: string;
          state: 'open' | 'closed';
          updatedAt: string;
          reactionsCount: number;
          commentsCount: number;
          similarity: number;
          productLabels: string[];
        }>;
      }>;
      generatedAt: string;
    }> {
      const semanticLimit = Math.min(Math.max(input.semanticLimit ?? 6, 1), 12);
      const issuesPerSemantic = Math.min(Math.max(input.issuesPerSemantic ?? 8, 2), 20);
      const minSimilarity = input.minSimilarity ?? 0.84;

      const hasReleaseStateTableRes = await db.pool.query(
        `select to_regclass('public.repo_release_state') is not null as exists`
      );
      const hasReleaseStateTable = Boolean(hasReleaseStateTableRes.rows[0]?.exists);

      const releaseRes = hasReleaseStateTable
        ? await db.pool.query(
            `
            select
              latest_release_tag,
              latest_release_name,
              latest_release_url,
              latest_release_version,
              latest_release_published_at
            from repo_release_state
            where repo = $1
            `,
            [input.repoFullName]
          )
        : { rows: [] as any[] };
      const releaseRow = releaseRes.rows[0];

      let source: 'github_release' | 'issues_fallback' | 'none' = 'none';
      let latestVersion = (releaseRow?.latest_release_version as string | null | undefined) ?? null;
      if (latestVersion && isCanonicalPowertoysVersion(latestVersion)) {
        source = 'github_release';
      } else {
        latestVersion = null;
      }

      if (!latestVersion) {
        const versionRes = await db.pool.query(
          `
          select target_version, count(*)::int as issue_count
          from issues
          where repo = $1
            and target_version is not null
            and target_version ~ '^0\\.(?:[0-9]|[1-9][0-9]|[1-2][0-9]{2})(?:\\.[0-9]{1,2})?$'
          group by target_version
          `,
          [input.repoFullName]
        );
        const versionRows = versionRes.rows.map((r: any) => ({
          targetVersion: r.target_version as string | null,
          issueCount: Number(r.issue_count ?? 0),
        }));

        const stableCandidates = versionRows.filter((v) => v.issueCount >= 5).map((v) => v.targetVersion);
        const fallbackCandidates = stableCandidates.length > 0
          ? stableCandidates
          : versionRows.map((v) => v.targetVersion);

        latestVersion = latestVersionFromList(fallbackCandidates);
        if (latestVersion) source = 'issues_fallback';
      }

      const versionCandidates = buildVersionCandidates(latestVersion);
      if (versionCandidates.length === 0) {
        return {
          latestRelease: {
            tag: (releaseRow?.latest_release_tag as string | null | undefined) ?? null,
            name: (releaseRow?.latest_release_name as string | null | undefined) ?? null,
            url: (releaseRow?.latest_release_url as string | null | undefined) ?? null,
            publishedAt: (releaseRow?.latest_release_published_at as string | null | undefined) ?? null,
            version: latestVersion,
            versionCandidates: [],
            source,
          },
          hottestIssue: null,
          semanticGroups: [],
          generatedAt: new Date().toISOString(),
        };
      }

      const anchorScanLimit = Math.max(semanticLimit * 6, 20);
      const anchorsRes = await db.pool.query(
        `
        select
          i.issue_number,
          i.title,
          i.state,
          i.updated_at,
          i.reactions_total_count,
          i.comments_count,
          coalesce(array_agg(distinct p.product_label) filter (where p.product_label is not null), '{}') as product_labels,
          (
            3 * ln(1 + greatest(i.reactions_total_count, 0)) +
            2 * ln(1 + greatest(i.comments_count, 0)) +
            case when i.state = 'open' then 1 else 0 end
          ) as hot_score
        from issues i
        left join issue_products p on p.repo = i.repo and p.issue_number = i.issue_number
        where i.repo = $1
          and i.target_version = any($2::text[])
          and i.embedding is not null
        group by
          i.issue_number,
          i.title,
          i.state,
          i.updated_at,
          i.reactions_total_count,
          i.comments_count
        order by
          case when i.state = 'open' then 0 else 1 end asc,
          hot_score desc,
          i.updated_at desc
        limit $3
        `,
        [input.repoFullName, versionCandidates, anchorScanLimit]
      );

      const anchorRows = anchorsRes.rows.map((r: any) => ({
        issueNumber: Number(r.issue_number),
        title: r.title as string,
        state: r.state as 'open' | 'closed',
        updatedAt: r.updated_at as string,
        reactionsCount: Number(r.reactions_total_count ?? 0),
        commentsCount: Number(r.comments_count ?? 0),
        hotScore: Number(r.hot_score ?? 0),
        productLabels: (r.product_labels as string[] | null) ?? [],
      }));

      const seen = new Set<number>();
      const semanticGroups: Array<{
        semanticId: string;
        productLabel: string | null;
        representativeIssueNumber: number;
        representativeTitle: string;
        hotScore: number;
        issueCount: number;
        openIssueCount: number;
        issues: Array<{
          issueNumber: number;
          title: string;
          state: 'open' | 'closed';
          updatedAt: string;
          reactionsCount: number;
          commentsCount: number;
          similarity: number;
          productLabels: string[];
        }>;
      }> = [];

      for (const anchor of anchorRows) {
        if (seen.has(anchor.issueNumber)) continue;

        const overlapProducts = anchor.productLabels ?? [];
        const requireOverlap = overlapProducts.length > 0;

        const similarRes = await db.pool.query(
          `
          with anchor_issue as (
            select embedding
            from issues
            where repo = $1 and issue_number = $2 and embedding is not null
          )
          select
            i.issue_number,
            i.title,
            i.state,
            i.updated_at,
            i.reactions_total_count,
            i.comments_count,
            1 - (i.embedding <=> a.embedding) as similarity,
            coalesce(array_agg(distinct p.product_label) filter (where p.product_label is not null), '{}') as product_labels
          from issues i
          cross join anchor_issue a
          left join issue_products p on p.repo = i.repo and p.issue_number = i.issue_number
          where i.repo = $1
            and i.issue_number <> $2
            and i.target_version = any($3::text[])
            and i.embedding is not null
            and 1 - (i.embedding <=> a.embedding) >= $4
            and (
              $5::boolean = false
              or exists (
                select 1
                from issue_products p2
                where p2.repo = i.repo
                  and p2.issue_number = i.issue_number
                  and p2.product_label = any($6::text[])
              )
            )
          group by
            i.issue_number,
            i.title,
            i.state,
            i.updated_at,
            i.reactions_total_count,
            i.comments_count,
            i.embedding,
            a.embedding
          order by similarity desc, i.updated_at desc
          limit $7
          `,
          [
            input.repoFullName,
            anchor.issueNumber,
            versionCandidates,
            minSimilarity,
            requireOverlap,
            overlapProducts,
            issuesPerSemantic - 1,
          ]
        );

        const groupIssues = [
          {
            issueNumber: anchor.issueNumber,
            title: anchor.title,
            state: anchor.state,
            updatedAt: anchor.updatedAt,
            reactionsCount: anchor.reactionsCount,
            commentsCount: anchor.commentsCount,
            similarity: 1,
            productLabels: anchor.productLabels,
          },
          ...similarRes.rows
            .map((r: any) => ({
              issueNumber: Number(r.issue_number),
              title: r.title as string,
              state: r.state as 'open' | 'closed',
              updatedAt: r.updated_at as string,
              reactionsCount: Number(r.reactions_total_count ?? 0),
              commentsCount: Number(r.comments_count ?? 0),
              similarity: Number(r.similarity ?? 0),
              productLabels: (r.product_labels as string[] | null) ?? [],
            }))
            .filter((row) => !seen.has(row.issueNumber)),
        ];

        for (const issue of groupIssues) {
          seen.add(issue.issueNumber);
        }

        semanticGroups.push({
          semanticId: `${anchor.issueNumber}`,
          productLabel: pickPrimaryProductLabel(groupIssues),
          representativeIssueNumber: anchor.issueNumber,
          representativeTitle: anchor.title,
          hotScore: anchor.hotScore,
          issueCount: groupIssues.length,
          openIssueCount: groupIssues.filter((i) => i.state === 'open').length,
          issues: groupIssues,
        });

        if (semanticGroups.length >= semanticLimit) break;
      }

      return {
        latestRelease: {
          tag: (releaseRow?.latest_release_tag as string | null | undefined) ?? null,
          name: (releaseRow?.latest_release_name as string | null | undefined) ?? null,
          url: (releaseRow?.latest_release_url as string | null | undefined) ?? null,
          publishedAt: (releaseRow?.latest_release_published_at as string | null | undefined) ?? null,
          version: latestVersion,
          versionCandidates,
          source,
        },
        hottestIssue: anchorRows[0] ?? null,
        semanticGroups,
        generatedAt: new Date().toISOString(),
      };
    },

    async getIssueSyncStatus(repoFullName: string): Promise<{
      currentCount: number;
      lastSyncedAt: string | null;
    }> {
      const countRes = await db.pool.query(
        'SELECT COUNT(*) as cnt FROM issues WHERE repo = $1',
        [repoFullName]
      );
      const currentCount = Number(countRes.rows[0]?.cnt ?? 0);
      
      const stateRes = await db.pool.query(
        'SELECT last_synced_at FROM issue_sync_state WHERE repo = $1',
        [repoFullName]
      );
      const row = stateRes.rows[0];
      const lastSyncedAt = row?.last_synced_at as string | null ?? null;
      
      return {
        currentCount,
        lastSyncedAt,
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

    async resetIssueSyncData(input: {
      repoFullName: string;
      hardDeleteIssues?: boolean;
    }): Promise<{
      mode: 'soft' | 'hard';
      clearedEmbeddings: number;
      deletedIssueClusterMap: number;
      deletedClusters: number;
      deletedIssueProducts: number;
      deletedIssues: number;
      deletedSyncStateRows: number;
    }> {
      const repoFullName = input.repoFullName;
      const hardDeleteIssues = Boolean(input.hardDeleteIssues);

      await db.pool.query('begin');
      try {
        let clearedEmbeddings = 0;
        let deletedIssueClusterMap = 0;
        let deletedClusters = 0;
        let deletedIssueProducts = 0;
        let deletedIssues = 0;

        const deleteMapRes = await db.pool.query('delete from issue_cluster_map where repo = $1', [repoFullName]);
        deletedIssueClusterMap = deleteMapRes.rowCount ?? 0;

        const deleteClustersRes = await db.pool.query('delete from clusters where repo = $1', [repoFullName]);
        deletedClusters = deleteClustersRes.rowCount ?? 0;

        if (hardDeleteIssues) {
          const deleteProductsRes = await db.pool.query('delete from issue_products where repo = $1', [repoFullName]);
          deletedIssueProducts = deleteProductsRes.rowCount ?? 0;

          const deleteIssuesRes = await db.pool.query('delete from issues where repo = $1', [repoFullName]);
          deletedIssues = deleteIssuesRes.rowCount ?? 0;
        } else {
          const hasEmbeddingInputHashRes = await db.pool.query(
            `
            select exists (
              select 1
              from information_schema.columns
              where table_schema = 'public'
                and table_name = 'issues'
                and column_name = 'embedding_input_hash'
            ) as has_col
            `
          );
          const hasEmbeddingInputHash = Boolean(hasEmbeddingInputHashRes.rows[0]?.has_col);

          const clearEmbeddingsSql = hasEmbeddingInputHash
            ? `
              update issues
              set embedding = null,
                  embedding_model = null,
                  embedding_input_hash = null,
                  fetched_at = now()
              where repo = $1
                and (embedding is not null or embedding_model is not null or embedding_input_hash is not null)
            `
            : `
              update issues
              set embedding = null,
                  embedding_model = null,
                  fetched_at = now()
              where repo = $1
                and (embedding is not null or embedding_model is not null)
            `;

          const clearEmbeddingsRes = await db.pool.query(clearEmbeddingsSql, [repoFullName]);
          clearedEmbeddings = clearEmbeddingsRes.rowCount ?? 0;
        }

        const deleteSyncStateRes = await db.pool.query('delete from issue_sync_state where repo = $1', [repoFullName]);
        const deletedSyncStateRows = deleteSyncStateRes.rowCount ?? 0;

        await db.pool.query('commit');
        return {
          mode: hardDeleteIssues ? 'hard' : 'soft',
          clearedEmbeddings,
          deletedIssueClusterMap,
          deletedClusters,
          deletedIssueProducts,
          deletedIssues,
          deletedSyncStateRows,
        };
      } catch (error) {
        await db.pool.query('rollback');
        throw error;
      }
    },

    async findSimilarIssues(input: {
      repoFullName: string;
      issueNumber: number;
      productLabel?: string;
      minSimilarity?: number; // default 0.85
      limit?: number; // default 10
    }): Promise<
      Array<{
        issueNumber: number;
        title: string;
        state: 'open' | 'closed';
        similarity: number;
        productLabels: string[];
        updatedAt: string;
      }>
    > {
      const minSim = input.minSimilarity ?? 0.85;
      const limit = Math.min(input.limit ?? 10, 100);

      // Build the HAVING clause for product label filtering
      const productFilter = input.productLabel
        ? `having array_agg(distinct p.product_label) @> $5`
        : '';

      const sql = `
        with target as (
          select embedding
          from issues
          where repo = $1 and issue_number = $2 and embedding is not null
        )
        select
          i.issue_number,
          i.title,
          i.state,
          i.updated_at,
          1 - (i.embedding <=> t.embedding) as similarity,
          coalesce(array_agg(distinct p.product_label) filter (where p.product_label is not null), '{}') as product_labels
        from issues i
        cross join target t
        left join issue_products p on p.repo = i.repo and p.issue_number = i.issue_number
        where i.repo = $1
          and i.issue_number <> $2
          and i.embedding is not null
          and 1 - (i.embedding <=> t.embedding) >= $3
        group by i.issue_number, i.title, i.state, i.updated_at, i.embedding, t.embedding
        ${productFilter}
        order by similarity desc
        limit $4
      `;

      const params = input.productLabel
        ? [input.repoFullName, input.issueNumber, minSim, limit, [input.productLabel]]
        : [input.repoFullName, input.issueNumber, minSim, limit];

      const res = await db.pool.query(sql, params);
      return res.rows.map((r: any) => ({
        issueNumber: Number(r.issue_number),
        title: r.title as string,
        state: r.state as 'open' | 'closed',
        similarity: Number(r.similarity ?? 0),
        productLabels: (r.product_labels as string[]) ?? [],
        updatedAt: r.updated_at as string,
      }));
    },

    /**
     * Search issues by embedding vector (for semantic search with pre-computed embeddings).
     */
    async searchIssuesByEmbedding(input: {
      repoFullName: string;
      embedding: number[];
      productLabel?: string;
      minSimilarity?: number; // default 0.85
      limit?: number; // default 20
    }): Promise<
      Array<{
        issueNumber: number;
        title: string;
        state: 'open' | 'closed';
        similarity: number;
        productLabels: string[];
        updatedAt: string;
      }>
    > {
      const minSim = input.minSimilarity ?? 0.85;
      const limit = Math.min(input.limit ?? 20, 100);

      // Convert embedding array to pgvector literal format
      const embeddingLiteral = `[${input.embedding.map((v) => (Number.isFinite(v) ? v : 0)).join(',')}]`;

      const params: any[] = [input.repoFullName, embeddingLiteral, minSim];
      
      let productFilter = '';
      if (input.productLabel) {
        params.push([input.productLabel]);
        productFilter = `having array_agg(distinct p.product_label) @> $${params.length}`;
      }

      const sql = `
        select
          i.issue_number,
          i.title,
          i.state,
          i.updated_at,
          1 - (i.embedding <=> $2::vector) as similarity,
          coalesce(array_agg(distinct p.product_label) filter (where p.product_label is not null), '{}') as product_labels
        from issues i
        left join issue_products p on p.repo = i.repo and p.issue_number = i.issue_number
        where i.repo = $1
          and i.embedding is not null
          and 1 - (i.embedding <=> $2::vector) >= $3
        group by i.issue_number, i.title, i.state, i.updated_at, i.embedding
        ${productFilter}
        order by similarity desc
        limit $${params.length + 1}
      `;

      params.push(limit);
      const res = await db.pool.query(sql, params);
      return res.rows.map((r: any) => ({
        issueNumber: Number(r.issue_number),
        title: r.title as string,
        state: r.state as 'open' | 'closed',
        similarity: Number(r.similarity ?? 0),
        productLabels: (r.product_labels as string[]) ?? [],
        updatedAt: r.updated_at as string,
      }));
    },

    /**
     * Find issues similar to a given issue based on embedding cosine similarity.
     * Optionally filter by product label. Returns top N issues with similarity > minSimilarity.
     */
    async getTopIssuesByReactions(input: {
      repoFullName: string;
      targetVersion: string | null | undefined; // undefined = all versions
      productLabel?: string;
      limit?: number;
    }): Promise<
      Array<{
        issueNumber: number;
        title: string;
        state: 'open' | 'closed';
        reactionsCount: number;
        commentsCount: number;
        updatedAt: string;
      }>
    > {
      const limit = Math.min(input.limit ?? 20, 100);
      const filterByVersion = input.targetVersion !== undefined;
      const filterByProduct = !!input.productLabel;
      
      // Build query conditionally to avoid referencing p.product_label when not joining
      const productJoin = filterByProduct 
        ? 'join issue_products p on p.repo = i.repo and p.issue_number = i.issue_number' 
        : '';
      const productFilter = filterByProduct 
        ? 'and p.product_label = $5' 
        : '';
      
      const res = await db.pool.query(
        `
        select
          i.issue_number,
          i.title,
          i.state,
          i.reactions_total_count,
          i.comments_count,
          i.updated_at
        from issues i
        ${productJoin}
        where i.repo = $1
          and i.state = 'open'
          and (i.target_version is null or i.target_version ~ '^0\\.(?:[0-9]|[1-9][0-9]|[1-2][0-9]{2})(?:\\.[0-9]{1,2})?$')
          and ($2::boolean = false or i.target_version is not distinct from $3)
          ${productFilter}
        order by i.reactions_total_count desc, i.comments_count desc, i.updated_at desc
        limit $4
        `,
        filterByProduct
          ? [input.repoFullName, filterByVersion, input.targetVersion ?? null, limit, input.productLabel]
          : [input.repoFullName, filterByVersion, input.targetVersion ?? null, limit]
      );
      return res.rows.map((r: any) => ({
        issueNumber: Number(r.issue_number),
        title: r.title as string,
        state: r.state as 'open' | 'closed',
        reactionsCount: Number(r.reactions_total_count ?? 0),
        commentsCount: Number(r.comments_count ?? 0),
        updatedAt: r.updated_at as string,
      }));
    },
  };
}

export type PgStore = ReturnType<typeof createPgStore>;
