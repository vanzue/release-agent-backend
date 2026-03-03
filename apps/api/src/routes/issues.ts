import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import type { PgStore } from '../store/pg.js';
import type { IssueReclusterRequest, IssueSyncRequest } from '@release-agent/contracts';
import { createIssueReclusterEnqueuer, createIssueSyncEnqueuer } from '../queue.js';

// Embedding helper (inline to avoid worker dependency)
async function embedTextForSearch(text: string): Promise<number[]> {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION;
  const modelId = process.env.ISSUE_EMBEDDING_MODEL_ID;
  
  if (!endpoint || !apiKey || !modelId) {
    throw new Error('Missing Azure OpenAI configuration for embeddings');
  }

  const baseURL = endpoint.replace(/\/?$/, '/');
  const url = apiVersion
    ? `${baseURL}openai/deployments/${encodeURIComponent(modelId)}/embeddings?api-version=${encodeURIComponent(apiVersion)}`
    : `${baseURL}openai/v1/embeddings`;

  const res: any = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify({
      ...(apiVersion ? {} : { model: modelId }),
      input: text,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Azure OpenAI embeddings error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as any;
  const embedding = data?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) {
    throw new Error('Invalid embeddings response');
  }

  return embedding.map((n: any) => Number(n));
}

function parseVersionKey(v: string): [number, number, number] | null {
  const m = v.match(/^(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  return [Number.parseInt(m[1], 10), Number.parseInt(m[2], 10), Number.parseInt(m[3] ?? '0', 10)];
}

function compareVersionKeys(a: [number, number, number], b: [number, number, number]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}

function pickLatestVersion(versions: Array<string | null>): string | null {
  const candidates = versions.filter((v): v is string => typeof v === 'string');
  let best: string | null = null;
  let bestKey: [number, number, number] | null = null;

  for (const v of candidates) {
    const key = parseVersionKey(v);
    if (!key) continue;
    if (!bestKey || compareVersionKeys(key, bestKey) > 0) {
      bestKey = key;
      best = v;
    }
  }

  return best ?? null;
}

const ISSUE_CLUSTER_TARGET_VERSION_ALL = '__all__';
const ISSUE_CLUSTER_TARGET_VERSION_UNVERSIONED = '__null__';

function parseTargetVersionQuery(targetVersion: string | undefined): string | null | undefined {
  if (targetVersion === undefined) return undefined;
  if (targetVersion === ISSUE_CLUSTER_TARGET_VERSION_ALL) return undefined;
  if (targetVersion === ISSUE_CLUSTER_TARGET_VERSION_UNVERSIONED) return null;
  return targetVersion;
}

function toReclusterTargetVersionToken(targetVersion: string | null | undefined): string {
  if (targetVersion === null || targetVersion === undefined) return ISSUE_CLUSTER_TARGET_VERSION_ALL;
  return targetVersion;
}

function parseBooleanQuery(value: unknown, defaultValue = false): boolean {
  if (typeof value !== 'string') return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return defaultValue;
}

export function registerIssueRoutes(server: FastifyInstance, store: PgStore, db: Db) {
  const enqueueIssueSync = createIssueSyncEnqueuer(server);
  const enqueueIssueRecluster = createIssueReclusterEnqueuer(server);

  server.get('/issues/versions', async (req) => {
    const { repo } = req.query as { repo: string };
    const versions = await store.listIssueVersions(repo);
    const defaultTargetVersion = pickLatestVersion(versions.map((v) => v.targetVersion));
    return { versions, defaultTargetVersion };
  });

  server.get('/issues/products', async (req) => {
    const { repo, targetVersion } = req.query as { repo: string; targetVersion?: string };
    const versions = await store.listIssueVersions(repo);
    const defaultTargetVersion = pickLatestVersion(versions.map((v) => v.targetVersion));
    const resolvedTargetVersion = parseTargetVersionQuery(targetVersion);

    const products = await store.listIssueProducts({
      repoFullName: repo,
      targetVersion: resolvedTargetVersion,
    });

    return { targetVersion: resolvedTargetVersion ?? null, defaultTargetVersion, products };
  });

  server.get('/issues/clusters', async (req) => {
    const { repo, targetVersion, productLabel, limit } = req.query as {
      repo: string;
      targetVersion?: string;
      productLabel: string;
      limit?: string;
    };
    const versions = await store.listIssueVersions(repo);
    const defaultTargetVersion = pickLatestVersion(versions.map((v) => v.targetVersion));
    const resolvedTargetVersion = parseTargetVersionQuery(targetVersion);

    const parsedLimit = limit ? Number.parseInt(limit, 10) : undefined;

    const clusterResult = await store.listIssueClusters({
      repoFullName: repo,
      targetVersion: resolvedTargetVersion,
      productLabel,
      limit: Number.isFinite(parsedLimit as number) ? parsedLimit : undefined,
    });

    return {
      targetVersion: resolvedTargetVersion ?? null,
      defaultTargetVersion,
      productLabel,
      clusters: clusterResult.clusters,
      isTruncated: clusterResult.isTruncated,
      limit: clusterResult.limit,
    };
  });

  server.get('/issues/clusters/:clusterId', async (req, reply) => {
    const { clusterId } = req.params as { clusterId: string };
    const { repo } = req.query as { repo: string };

    const cluster = await store.getIssueCluster({ repoFullName: repo, clusterId });
    if (!cluster) return reply.code(404).send({ message: 'Cluster not found' });

    const issues = await store.listIssuesInCluster({ repoFullName: repo, clusterId });
    return { cluster, issues };
  });

  server.post('/issues/sync', async (req, reply) => {
    const body = req.body as IssueSyncRequest;
    if (!body?.repoFullName) return reply.code(400).send({ message: 'repoFullName is required' });

    if (!enqueueIssueSync) return reply.code(501).send({ message: 'Issue sync queue is not configured' });

    await enqueueIssueSync(body);
    return reply.code(202).send({ status: 'queued' });
  });

  server.post('/issues/sync-reset', async (req, reply) => {
    const body = req.body as {
      repoFullName?: string;
      mode?: 'soft' | 'hard';
      queueFullSync?: boolean;
    };

    if (!body?.repoFullName) {
      return reply.code(400).send({ message: 'repoFullName is required' });
    }

    const mode = body.mode === 'hard' ? 'hard' : 'soft';
    const reset = await store.resetIssueSyncData({
      repoFullName: body.repoFullName,
      hardDeleteIssues: mode === 'hard',
    });

    const shouldQueueFullSync = body.queueFullSync ?? true;
    let queuedFullSync = false;
    if (shouldQueueFullSync && enqueueIssueSync) {
      await enqueueIssueSync({ repoFullName: body.repoFullName, fullSync: true });
      queuedFullSync = true;
    }

    return reply.code(200).send({
      status: 'ok',
      mode,
      queueAvailable: Boolean(enqueueIssueSync),
      queuedFullSync,
      reset,
    });
  });

  server.post('/issues/recluster', async (req, reply) => {
    const body = req.body as IssueReclusterRequest;
    if (!body?.repoFullName || !body?.productLabel) return reply.code(400).send({ message: 'Invalid request body' });
    if (typeof body.threshold !== 'number' || typeof body.topK !== 'number') {
      return reply.code(400).send({ message: 'threshold and topK must be numbers' });
    }

    if (!enqueueIssueRecluster) return reply.code(501).send({ message: 'Issue recluster queue is not configured' });

    const targetVersionToken = toReclusterTargetVersionToken(body.targetVersion);
    await enqueueIssueRecluster({
      repoFullName: body.repoFullName,
      targetVersion: targetVersionToken,
      productLabel: body.productLabel,
      threshold: body.threshold,
      topK: body.topK,
    });

    return reply.code(202).send({ status: 'queued' });
  });

  server.get('/issues/recluster-scope', async (req, reply) => {
    const { repo, targetVersion, productLabel } = req.query as {
      repo?: string;
      targetVersion?: string;
      productLabel?: string;
    };
    if (!repo || !productLabel) {
      return reply.code(400).send({ message: 'repo and productLabel query parameters are required' });
    }

    const resolvedTargetVersion = parseTargetVersionQuery(targetVersion);
    const scope = await store.getIssueReclusterScope({
      repoFullName: repo,
      targetVersion: resolvedTargetVersion,
      productLabel,
      embeddingModel: process.env.ISSUE_EMBEDDING_MODEL_ID?.trim() || null,
    });

    return scope;
  });

  server.get('/issues/search', async (req) => {
    const query = req.query as {
      repo: string;
      targetVersion?: string;
      productLabels?: string;
      state?: 'open' | 'closed';
      clusterId?: string;
      q?: string;
      limit?: string;
      offset?: string;
    };

    const versions = await store.listIssueVersions(query.repo);
    const defaultTargetVersion = pickLatestVersion(versions.map((v) => v.targetVersion));
    let resolvedTargetVersion: string | null | undefined;
    if (query.targetVersion === undefined) {
      resolvedTargetVersion = defaultTargetVersion;
    } else if (query.targetVersion === '__all__') {
      resolvedTargetVersion = undefined;
    } else if (query.targetVersion === '__null__') {
      resolvedTargetVersion = null;
    } else {
      resolvedTargetVersion = query.targetVersion;
    }

    const productLabels = query.productLabels
      ? query.productLabels.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;

    const limit = query.limit ? Number.parseInt(query.limit, 10) : undefined;
    const offset = query.offset ? Number.parseInt(query.offset, 10) : undefined;

    const issues = await store.searchIssues({
      repoFullName: query.repo,
      targetVersion: resolvedTargetVersion,
      productLabels,
      state: query.state,
      clusterId: query.clusterId,
      q: query.q,
      limit,
      offset,
    });

    return { targetVersion: resolvedTargetVersion ?? null, defaultTargetVersion, issues };
  });

  server.get('/issues/sync-status', async (req) => {
    const { repo } = req.query as { repo: string };
    const status = await store.getIssueSyncStatus(repo);
    return status;
  });

  server.get('/issues/stats', async (req) => {
    const { repo } = req.query as { repo: string };
    const stats = await store.getIssueStats(repo);
    return stats;
  });

  server.get('/issues/dashboard', async (req, reply) => {
    const { repo, semanticLimit, issuesPerSemantic, minSimilarity } = req.query as {
      repo?: string;
      semanticLimit?: string;
      issuesPerSemantic?: string;
      minSimilarity?: string;
    };

    if (!repo) {
      return reply.code(400).send({ message: 'repo query parameter is required' });
    }

    const dashboard = await store.getIssueDashboard({
      repoFullName: repo,
      semanticLimit: semanticLimit ? Number.parseInt(semanticLimit, 10) : undefined,
      issuesPerSemantic: issuesPerSemantic ? Number.parseInt(issuesPerSemantic, 10) : undefined,
      minSimilarity: minSimilarity ? Number.parseFloat(minSimilarity) : undefined,
      embeddingModel: process.env.ISSUE_EMBEDDING_MODEL_ID?.trim() || undefined,
    });

    return dashboard;
  });

  server.get('/issues/top-by-reactions', async (req) => {
    const { repo, targetVersion, productLabel, limit } = req.query as {
      repo: string;
      targetVersion?: string;
      productLabel?: string;
      limit?: string;
    };
    const versions = await store.listIssueVersions(repo);
    const defaultTargetVersion = pickLatestVersion(versions.map((v) => v.targetVersion));
    
    // If targetVersion is '__null__', user explicitly wants unversioned issues
    // If targetVersion is undefined, return all versions (no filter)
    let resolvedTargetVersion: string | null | undefined;
    if (targetVersion === undefined) {
      resolvedTargetVersion = undefined; // all versions
    } else if (targetVersion === '__null__') {
      resolvedTargetVersion = null; // unversioned
    } else {
      resolvedTargetVersion = targetVersion;
    }

    const issues = await store.getTopIssuesByReactions({
      repoFullName: repo,
      targetVersion: resolvedTargetVersion,
      productLabel,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
    });

    return { targetVersion: resolvedTargetVersion ?? null, issues };
  });

  /**
   * Get details for a specific issue.
   * Query params:
   *   - repo: repository full name (required)
   *   - includeSimilar: when true, include semantic similar issues in response (optional, default false)
   *   - minSimilarity: minimum similarity threshold for similar issues (optional, default 0.84)
   *   - limit: max similar issues (optional, default 20)
   */
  server.get('/issues/:issueNumber/detail', async (req, reply) => {
    const { issueNumber } = req.params as { issueNumber: string };
    const { repo, includeSimilar, minSimilarity, limit } = req.query as {
      repo?: string;
      includeSimilar?: string;
      minSimilarity?: string;
      limit?: string;
    };

    if (!repo) {
      return reply.code(400).send({ message: 'repo query parameter is required' });
    }

    const issueNum = Number.parseInt(issueNumber, 10);
    if (Number.isNaN(issueNum)) {
      return reply.code(400).send({ message: 'Invalid issue number' });
    }

    const includeSimilarIssues = parseBooleanQuery(includeSimilar, false);
    if (includeSimilarIssues) {
      const detail = await store.getIssueDetail({
        repoFullName: repo,
        issueNumber: issueNum,
        minSimilarity: minSimilarity ? Number.parseFloat(minSimilarity) : undefined,
        limit: limit ? Number.parseInt(limit, 10) : undefined,
      });

      if (!detail) {
        return reply.code(404).send({ message: 'Issue not found' });
      }

      return detail;
    }

    const issueRes = await db.pool.query(
      `
      select
        i.issue_number,
        i.gh_id,
        i.title,
        i.body,
        i.body_snip,
        i.labels_json,
        i.milestone_title,
        i.target_version,
        i.state,
        i.created_at,
        i.updated_at,
        i.closed_at,
        i.comments_count,
        i.reactions_total_count,
        i.embedding_model,
        coalesce(
          array_agg(distinct p.product_label) filter (where p.product_label is not null),
          '{}'
        ) as product_labels
      from issues i
      left join issue_products p on p.repo = i.repo and p.issue_number = i.issue_number
      where i.repo = $1 and i.issue_number = $2
      group by
        i.issue_number,
        i.gh_id,
        i.title,
        i.body,
        i.body_snip,
        i.labels_json,
        i.milestone_title,
        i.target_version,
        i.state,
        i.created_at,
        i.updated_at,
        i.closed_at,
        i.comments_count,
        i.reactions_total_count,
        i.embedding_model
      `,
      [repo, issueNum]
    );
    const issueRow = issueRes.rows[0];
    if (!issueRow) {
      return reply.code(404).send({ message: 'Issue not found' });
    }

    const clusterRes = await db.pool.query(
      `
      select
        m.cluster_id,
        m.target_version,
        m.product_label,
        m.similarity,
        m.assigned_at,
        c.size as cluster_size,
        c.popularity as cluster_popularity,
        c.representative_issue_number,
        c.updated_at as cluster_updated_at
      from issue_cluster_map m
      left join clusters c on c.repo = m.repo and c.cluster_id = m.cluster_id
      where m.repo = $1 and m.issue_number = $2
      order by m.similarity desc, m.assigned_at desc
      `,
      [repo, issueNum]
    );

    return {
      issue: {
        issueNumber: Number(issueRow.issue_number),
        ghId: issueRow.gh_id as string,
        title: issueRow.title as string,
        body: (issueRow.body as string | null) ?? null,
        bodySnip: (issueRow.body_snip as string | null) ?? null,
        labelsJson: issueRow.labels_json,
        milestoneTitle: (issueRow.milestone_title as string | null) ?? null,
        targetVersion: (issueRow.target_version as string | null) ?? null,
        state: issueRow.state as 'open' | 'closed',
        createdAt: issueRow.created_at as string,
        updatedAt: issueRow.updated_at as string,
        closedAt: (issueRow.closed_at as string | null) ?? null,
        commentsCount: Number(issueRow.comments_count ?? 0),
        reactionsCount: Number(issueRow.reactions_total_count ?? 0),
        embeddingModel: (issueRow.embedding_model as string | null) ?? null,
        productLabels: (issueRow.product_labels as string[] | null) ?? [],
      },
      clusterMemberships: clusterRes.rows.map((r: any) => ({
        clusterId: r.cluster_id as string,
        targetVersion: (r.target_version as string | null) ?? null,
        productLabel: r.product_label as string,
        similarity: Number(r.similarity ?? 0),
        assignedAt: r.assigned_at as string,
        clusterSize: Number(r.cluster_size ?? 0),
        clusterPopularity: Number(r.cluster_popularity ?? 0),
        representativeIssueNumber: (r.representative_issue_number as number | null) ?? null,
        clusterUpdatedAt: (r.cluster_updated_at as string | null) ?? null,
      })),
      similarIssues: [],
    };
  });

  /**
   * Find issues similar to a given issue based on embedding similarity.
   * Query params:
   *   - repo: repository full name (required)
   *   - issueNumber: the issue to find similar issues for (required)
   *   - productLabel: filter to same product label (optional)
   *   - minSimilarity: minimum similarity threshold, default 0.85 (optional)
   *   - limit: max results, default 10 (optional)
   */
  server.get('/issues/:issueNumber/similar', async (req, reply) => {
    const { issueNumber } = req.params as { issueNumber: string };
    const { repo, productLabel, minSimilarity, limit } = req.query as {
      repo: string;
      productLabel?: string;
      minSimilarity?: string;
      limit?: string;
    };

    if (!repo) {
      return reply.code(400).send({ message: 'repo query parameter is required' });
    }

    const issueNum = Number.parseInt(issueNumber, 10);
    if (Number.isNaN(issueNum)) {
      return reply.code(400).send({ message: 'Invalid issue number' });
    }

    const minSim = minSimilarity ? Number.parseFloat(minSimilarity) : undefined;
    const limitNum = limit ? Number.parseInt(limit, 10) : undefined;

    const similarIssues = await store.findSimilarIssues({
      repoFullName: repo,
      issueNumber: issueNum,
      productLabel,
      minSimilarity: minSim,
      limit: limitNum,
    });

    return {
      issueNumber: issueNum,
      productLabel: productLabel ?? null,
      minSimilarity: minSim ?? 0.85,
      similarIssues,
    };
  });

  /**
   * Semantic search for issues.
   * Supports two modes:
   * 1. By issue number: uses the issue's embedding
   * 2. By query text: embeds the text on-the-fly and searches
   * 
   * Query params:
   *   - repo: repository full name (required)
   *   - issueNumber: find similar issues to this issue (optional)
   *   - q: text query to embed and search (optional, used if issueNumber not provided)
   *   - productLabel: filter to specific product label (optional)
   *   - minSimilarity: minimum similarity threshold, default 0.80 (optional)
   *   - limit: max results, default 20 (optional)
   */
  server.get('/issues/semantic-search', async (req, reply) => {
    const { repo, issueNumber, q, productLabel, minSimilarity, limit } = req.query as {
      repo: string;
      issueNumber?: string;
      q?: string;
      productLabel?: string;
      minSimilarity?: string;
      limit?: string;
    };

    if (!repo) {
      return reply.code(400).send({ message: 'repo query parameter is required' });
    }

    const minSim = minSimilarity ? Number.parseFloat(minSimilarity) : 0.80;
    const limitNum = limit ? Number.parseInt(limit, 10) : 20;
    
    // Normalize productLabel: if it doesn't start with 'Product-', add the prefix
    const normalizedProductLabel = productLabel && !productLabel.startsWith('Product-') 
      ? `Product-${productLabel}`
      : productLabel;

    // Mode 1: Search by issue number
    if (issueNumber) {
      const issueNum = Number.parseInt(issueNumber, 10);
      if (Number.isNaN(issueNum)) {
        return reply.code(400).send({ message: 'Invalid issue number' });
      }

      const similarIssues = await store.findSimilarIssues({
        repoFullName: repo,
        issueNumber: issueNum,
        productLabel: normalizedProductLabel,
        minSimilarity: minSim,
        limit: limitNum,
      });

      return {
        mode: 'issue',
        issueNumber: issueNum,
        query: null,
        productLabel: normalizedProductLabel ?? null,
        minSimilarity: minSim,
        results: similarIssues,
      };
    }

    // Mode 2: Search by text query
    if (q && q.trim()) {
      const queryText = q.trim();
      
      try {
        const embedding = await embedTextForSearch(queryText);
        
        const results = await store.searchIssuesByEmbedding({
          repoFullName: repo,
          embedding,
          embeddingModel: process.env.ISSUE_EMBEDDING_MODEL_ID?.trim() || undefined,
          productLabel: normalizedProductLabel,
          minSimilarity: minSim,
          limit: limitNum,
        });

        return {
          mode: 'query',
          issueNumber: null,
          query: queryText,
          productLabel: normalizedProductLabel ?? null,
          minSimilarity: minSim,
          results,
        };
      } catch (e: any) {
        req.log.error({ err: e }, 'Semantic search embedding failed');
        return reply.code(500).send({ message: e.message ?? 'Embedding failed' });
      }
    }

    return reply.code(400).send({ message: 'Either issueNumber or q (query) is required' });
  });
}
