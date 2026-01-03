import pino from 'pino';
import type { Db } from '../db.js';
import { embedTextAzureOpenAI } from './embeddings.js';
import { toVectorLiteral } from './vector.js';

const logger = pino({ name: 'issue-embed', level: process.env.LOG_LEVEL ?? 'info' });

function buildEmbeddingText(title: string, body: string | null): string {
  const cleanedBody = (body ?? '').trim();
  const truncated = cleanedBody.length > 12000 ? cleanedBody.slice(0, 12000) : cleanedBody;
  return `${title}\n\n${truncated}`.trim();
}

export async function embedPendingIssues(
  db: Db,
  input: { repoFullName: string; limit?: number; maxBatches?: number }
): Promise<{ embedded: number }> {
  const limit = input.limit ?? 200;
  const maxBatches = input.maxBatches ?? Number.POSITIVE_INFINITY;
  const repoFullName = input.repoFullName;

  let embedded = 0;
  let batches = 0;
  while (batches < maxBatches) {
    const res = await db.pool.query(
      `
      select repo, issue_number, title, body
      from issues
      where repo = $1 and state = 'open' and embedding is null
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
        const text = buildEmbeddingText(title, body);
        const result = await embedTextAzureOpenAI(text);
        logger.info({ repoFullName, issueNumber, model: result.model, dim: result.embedding.length }, 'Embedding success');
        await db.pool.query(
          `
          update issues
          set embedding = $3::vector,
              embedding_model = $4,
              fetched_at = now()
          where repo = $1 and issue_number = $2
          `,
          [repoFullName, issueNumber, toVectorLiteral(result.embedding), result.model]
        );
        embedded++;
      } catch (e) {
        logger.warn({ err: e, repoFullName, issueNumber }, 'Embedding failed; leaving as pending');
      }
    }
  }

  return { embedded };
}
