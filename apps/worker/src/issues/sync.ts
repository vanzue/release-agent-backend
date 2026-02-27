import pino from 'pino';
import type { Db } from '../db.js';
import { getLatestRelease, listIssuesUpdatedSince, streamIssuesByCreated, listIssuesNewerThanNumber } from './githubIssues.js';
import { findReusableEmbedding, getIssueSyncState, setIssueSyncState, upsertIssue, replaceIssueProducts, upsertRepoLatestRelease } from './issueStore.js';
import {
  extractPowertoysAreaProductLabels,
  extractPowertoysReportedVersion,
  normalizeAreaToProductLabel,
  normalizePowertoysVersion,
} from './powertoysTemplate.js';
import type { IssueSyncRequest, GithubIssue } from './types.js';
import { embedTextAzureOpenAI } from './embeddings.js';
import { toVectorLiteral } from './vector.js';

const logger = pino({ name: 'issue-sync', level: process.env.LOG_LEVEL ?? 'info' });

function extractVersionFromMilestoneTitle(title: string | null): string | null {
  if (!title) return null;
  return normalizePowertoysVersion(title);
}

function productLabelsFromGithubLabels(labels: Array<{ name?: string }> | null | undefined): string[] {
  const out: string[] = [];
  for (const l of labels ?? []) {
    const name = l?.name?.trim();
    if (!name) continue;
    if (/^product-/i.test(name)) {
      const raw = name.replace(/^product-/i, '');
      const normalized = normalizeAreaToProductLabel(raw);
      if (normalized) out.push(normalized);
      continue;
    }
    if (/^area-/i.test(name)) {
      const raw = name.replace(/^area-/i, '');
      const normalized = normalizeAreaToProductLabel(raw);
      if (normalized) out.push(normalized);
      continue;
    }
  }
  return out;
}

function buildEmbeddingText(title: string, body: string | null): string {
  const cleanedBody = (body ?? '').trim();
  const truncated = cleanedBody.length > 12000 ? cleanedBody.slice(0, 12000) : cleanedBody;
  return `${title}\n\n${truncated}`.trim();
}

export async function syncIssues(
  db: Db,
  request: IssueSyncRequest,
): Promise<{ fetched: number; embedded: number; lastSyncedAt: string | null; lastSyncedIssueNumber: number | null }> {
  const repoFullName = request.repoFullName;
  const fullSync = Boolean(request.fullSync);

  const syncState = await getIssueSyncState(db, repoFullName);
  // For incremental sync, use stored state; for full sync, still use lastIssueNumber to resume from interruption
  const since = fullSync ? null : syncState.lastSyncedAt;
  const lastIssueNumber = syncState.lastSyncedIssueNumber; // Always use for resume capability

  logger.info({ repoFullName, since, lastIssueNumber, fullSync }, 'Syncing issues');

  try {
    const latestRelease = await getLatestRelease({ repoFullName });
    await upsertRepoLatestRelease(db, {
      repoFullName,
      tag: latestRelease?.tag_name ?? null,
      name: latestRelease?.name ?? null,
      url: latestRelease?.html_url ?? null,
      version: normalizePowertoysVersion(latestRelease?.tag_name) ?? normalizePowertoysVersion(latestRelease?.name) ?? null,
      publishedAt: latestRelease?.published_at ?? null,
    });
  } catch (e) {
    logger.warn({ err: e, repoFullName }, 'Failed to refresh latest release metadata');
  }

  // Always update lastSyncedAt to current time to mark when we ran the sync
  // (incremental syncs may refetch older issues, so we can't rely on max issue.updated_at)
  let maxUpdatedAt = new Date().toISOString();
  let maxIssueNumber = lastIssueNumber ?? null;
  
  // For resume: count how many issues we already have in DB
  const existingCountRes = await db.pool.query(
    'SELECT COUNT(*) as cnt FROM issues WHERE repo = $1',
    [repoFullName]
  );
  const existingCount = Number(existingCountRes.rows[0]?.cnt ?? 0);
  
  let processed = existingCount; // Start from existing count for accurate progress
  let embedded = 0;
  const configuredEmbeddingModelId = process.env.ISSUE_EMBEDDING_MODEL_ID ?? '';
  const embeddingReuseCache = new Map<string, { embeddingVectorLiteral: string; modelId: string }>();

  // Helper to process a single issue
  const processIssue = async (issue: GithubIssue) => {
    const milestoneTitle = issue.milestone?.title ?? null;
    const milestoneVersion = extractVersionFromMilestoneTitle(milestoneTitle);
    const templateVersion = extractPowertoysReportedVersion(issue.body ?? null);
    const targetVersion = templateVersion ?? milestoneVersion ?? null;

    const { needsEmbedding, embeddingInputHash } = await upsertIssue(db, {
      repoFullName,
      issue,
      targetVersion,
      milestoneTitle,
      expectedEmbeddingModel: configuredEmbeddingModelId || null,
    });

    const productLabels = productLabelsFromGithubLabels(issue.labels);
    const templateProducts = extractPowertoysAreaProductLabels(issue.body ?? null);
    const combined = new Set<string>();
    if (templateProducts.length > 0) {
      for (const p of templateProducts) combined.add(p);
    } else {
      for (const p of productLabels) combined.add(p);
    }
    if (combined.size === 0) combined.add('Product-Uncategorized');

    await replaceIssueProducts(db, { repoFullName, issueNumber: issue.number, productLabels: [...combined] });

    if (needsEmbedding) {
      try {
        const cacheKey = `${configuredEmbeddingModelId}:${embeddingInputHash}`;
        const cached = embeddingReuseCache.get(cacheKey) ??
          (configuredEmbeddingModelId
            ? await findReusableEmbedding(db, {
                repoFullName,
                issueNumber: issue.number,
                embeddingInputHash,
                modelId: configuredEmbeddingModelId,
              })
            : null);

        if (cached) {
          await db.pool.query(
            `
            update issues
            set embedding = $3::vector,
                embedding_model = $4,
                embedding_input_hash = $5,
                fetched_at = now()
            where repo = $1 and issue_number = $2
            `,
            [repoFullName, issue.number, cached.embeddingVectorLiteral, cached.modelId, embeddingInputHash]
          );
          embeddingReuseCache.set(cacheKey, cached);
          embedded++;
        } else {
          const text = buildEmbeddingText(issue.title, issue.body ?? null);
          const result = await embedTextAzureOpenAI(text);
          const embeddingVectorLiteral = toVectorLiteral(result.embedding);
          await db.pool.query(
            `
            update issues
            set embedding = $3::vector,
                embedding_model = $4,
                embedding_input_hash = $5,
                fetched_at = now()
            where repo = $1 and issue_number = $2
            `,
            [repoFullName, issue.number, embeddingVectorLiteral, result.model, embeddingInputHash]
          );
          embeddingReuseCache.set(cacheKey, {
            embeddingVectorLiteral,
            modelId: result.model,
          });
          embedded++;
        }
      } catch (e) {
        logger.warn({ err: e, repoFullName, issueNumber: issue.number }, 'Embedding failed during sync');
      }
    }

    // Track max issue number for resume capability
    if (!maxIssueNumber || issue.number > maxIssueNumber) maxIssueNumber = issue.number;

    processed++;
  };

  if (fullSync || lastIssueNumber === null) {
    // Full sync: stream issues and process each batch immediately
    // Use lastIssueNumber to resume from where we left off if interrupted
    logger.info({ repoFullName, resumeFromIssue: lastIssueNumber }, 'Starting full sync (streaming)');
    
    for await (const batch of streamIssuesByCreated({ 
      repoFullName, 
      state: 'all', 
      direction: 'asc',
      sinceIssueNumber: lastIssueNumber, // Skip already-processed issues
    })) {
      logger.info({ repoFullName, batchSize: batch.issues.length, processedSoFar: processed, page: batch.page }, 'Processing batch');
      for (const issue of batch.issues) {
        await processIssue(issue);
      }
      
      // Save checkpoint after each batch so we can resume from here if interrupted
      await setIssueSyncState(db, repoFullName, { 
        lastSyncedAt: maxUpdatedAt, 
        lastSyncedIssueNumber: maxIssueNumber,
      });
      logger.debug({ repoFullName, maxIssueNumber, processed }, 'Checkpoint saved');
    }
  } else {
    // Incremental sync: collect then process (may have duplicates between updated and new)
    const issueMap = new Map<number, GithubIssue>();
    const updatedIssues = await listIssuesUpdatedSince({ repoFullName, since, state: 'all' });
    const newIssues = await listIssuesNewerThanNumber({
      repoFullName,
      state: 'all',
      lastIssueNumber: lastIssueNumber,
    });
    for (const issue of updatedIssues) issueMap.set(issue.number, issue);
    for (const issue of newIssues) issueMap.set(issue.number, issue);

    const issues = [...issueMap.values()].sort((a, b) => a.number - b.number);
    logger.info({ repoFullName, count: issues.length }, 'Fetched issues from GitHub (incremental)');

    for (const issue of issues) {
      await processIssue(issue);
    }
  }

  await setIssueSyncState(db, repoFullName, { lastSyncedAt: maxUpdatedAt, lastSyncedIssueNumber: maxIssueNumber });
  const newlyFetched = processed - existingCount;
  logger.info({ repoFullName, processed, newlyFetched, embedded, lastSyncedAt: maxUpdatedAt, lastSyncedIssueNumber: maxIssueNumber }, 'Issue sync complete');
  return { fetched: newlyFetched, embedded, lastSyncedAt: maxUpdatedAt, lastSyncedIssueNumber: maxIssueNumber };
}
