import pino from 'pino';
import { createHash } from 'node:crypto';
import type { Db } from '../db.js';
import { embedTextAzureOpenAI } from './embeddings.js';
import { findReusableEmbedding } from './issueStore.js';
import { toVectorLiteral } from './vector.js';

const logger = pino({ name: 'issue-embed', level: process.env.LOG_LEVEL ?? 'info' });

function buildEmbeddingText(title: string, body: string | null): string {
  const cleanedBody = (body ?? '').trim();
  const truncated = cleanedBody.length > 12000 ? cleanedBody.slice(0, 12000) : cleanedBody;
  return `${title}\n\n${truncated}`.trim();
}

function embeddingInputHash(title: string, body: string | null): string {
  return createHash('sha256').update(buildEmbeddingText(title, body)).digest('hex');
}

export async function embedPendingIssues(
  db: Db,
  input: { repoFullName: string; limit?: number; maxBatches?: number }
): Promise<{ embedded: number }> {
  const limit = input.limit ?? 200;
  const maxBatches = input.maxBatches ?? Number.POSITIVE_INFINITY;
  const repoFullName = input.repoFullName;
  const configuredEmbeddingModelId = process.env.ISSUE_EMBEDDING_MODEL_ID ?? '';
  const embeddingReuseCache = new Map<string, { embeddingVectorLiteral: string; modelId: string }>();

  let embedded = 0;
  let batches = 0;
  while (batches < maxBatches) {
    const res = await db.pool.query(
      `
      select repo, issue_number, title, body
      from issues
      where repo = $1 and embedding is null
      order by updated_at asc
      limit $2
      `,
      [repoFullName, limit]
    );

    if (res.rows.length === 0) break;
    batches++;

    for (const row of res.rows) {
      const issueNumber = row.issue_number as number;
      const title = row.title as string;
      const body = (row.body as string | null) ?? null;

      try {
        logger.info({ repoFullName, issueNumber }, 'Embedding issue');
        const embedHash = embeddingInputHash(title, body);
        const cacheKey = `${configuredEmbeddingModelId}:${embedHash}`;
        const cached = embeddingReuseCache.get(cacheKey) ??
          (configuredEmbeddingModelId
            ? await findReusableEmbedding(db, {
                repoFullName,
                issueNumber,
                embeddingInputHash: embedHash,
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
            [repoFullName, issueNumber, cached.embeddingVectorLiteral, cached.modelId, embedHash]
          );
          embeddingReuseCache.set(cacheKey, cached);
          embedded++;
        } else {
          const text = buildEmbeddingText(title, body);
          const result = await embedTextAzureOpenAI(text);
          logger.info({ repoFullName, issueNumber, model: result.model, dim: result.embedding.length }, 'Embedding success');
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
            [repoFullName, issueNumber, embeddingVectorLiteral, result.model, embedHash]
          );
          embeddingReuseCache.set(cacheKey, {
            embeddingVectorLiteral,
            modelId: result.model,
          });
          embedded++;
        }
      } catch (e) {
        logger.warn({ err: e, repoFullName, issueNumber }, 'Embedding failed; leaving as pending');
      }
    }
  }

  return { embedded };
}
