import type { FastifyInstance } from 'fastify';
import type { PgStore } from '../store/pg.js';
import type { IssueReclusterRequest, IssueSyncRequest } from '@release-agent/contracts';
import { createIssueReclusterEnqueuer, createIssueSyncEnqueuer } from '../queue.js';

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
}
