import type { FastifyInstance } from 'fastify';
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

export function registerIssueRoutes(server: FastifyInstance, store: PgStore) {
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
    
    // If targetVersion is '__null__', user explicitly wants unversioned issues
    // If targetVersion is undefined, return all versions (no filter)
    // Otherwise, use the provided version
    let resolvedTargetVersion: string | null | undefined;
    if (targetVersion === undefined) {
      resolvedTargetVersion = undefined; // all versions
    } else if (targetVersion === '__null__') {
      resolvedTargetVersion = null; // unversioned
    } else {
      resolvedTargetVersion = targetVersion;
    }

    const products = await store.listIssueProducts({
      repoFullName: repo,
      targetVersion: resolvedTargetVersion,
    });

    return { targetVersion: resolvedTargetVersion ?? null, defaultTargetVersion, products };
  });

  server.get('/issues/clusters', async (req) => {
    const { repo, productLabel } = req.query as { repo: string; productLabel: string };
    const versions = await store.listIssueVersions(repo);
    const defaultTargetVersion = pickLatestVersion(versions.map((v) => v.targetVersion));

    const clusters = await store.listIssueClusters({
      repoFullName: repo,
      productLabel,
    });

    return { targetVersion: null, defaultTargetVersion, productLabel, clusters };
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

    await enqueueIssueRecluster({
      repoFullName: body.repoFullName,
      targetVersion: body.targetVersion ?? null,
      productLabel: body.productLabel,
      threshold: body.threshold,
      topK: body.topK,
    });

    return reply.code(202).send({ status: 'queued' });
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
    const resolvedTargetVersion = query.targetVersion ?? defaultTargetVersion;

    const productLabels = query.productLabels
      ? query.productLabels.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;

    const limit = query.limit ? Number.parseInt(query.limit, 10) : undefined;
    const offset = query.offset ? Number.parseInt(query.offset, 10) : undefined;

    const issues = await store.searchIssues({
      repoFullName: query.repo,
      targetVersion: resolvedTargetVersion ?? null,
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
