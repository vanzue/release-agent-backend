import pino from 'pino';
import type { Db } from '../db.js';
import type { IssueReclusterRequest } from './types.js';
import { parseVector, toVectorLiteral, meanVector } from './vector.js';

const logger = pino({ name: 'issue-recluster', level: process.env.LOG_LEVEL ?? 'info' });

function cosineSimilarityFromDistance(cosineDistance: number): number {
  // pgvector cosine distance is (1 - cosine_similarity)
  return 1 - cosineDistance;
}

function issuePopularity(input: { comments: number; reactions: number; updatedAt: string }): number {
  const commentsScore = Math.log1p(Math.max(0, input.comments));
  const reactionsScore = Math.log1p(Math.max(0, input.reactions));

  const updatedAtMs = Date.parse(input.updatedAt);
  const nowMs = Date.now();
  const daysSince = Math.max(0, (nowMs - updatedAtMs) / (1000 * 60 * 60 * 24));
  const recency = Math.max(0, 30 - daysSince) / 30; // 1.0 for <=1 day, 0 at >=30 days

  return 2 * commentsScore + 1 * reactionsScore + recency;
}

// Use '__all__' as a placeholder for NULL targetVersion since the DB schema requires NOT NULL
const ALL_VERSIONS_PLACEHOLDER = '__all__';

export async function reclusterBucket(db: Db, req: IssueReclusterRequest): Promise<{ clusters: number; mapped: number }> {
  const repoFullName = req.repoFullName;
  // If targetVersion is null (All Versions), use placeholder for DB storage
  const targetVersion = req.targetVersion ?? ALL_VERSIONS_PLACEHOLDER;
  const productLabel = req.productLabel;
  const threshold = req.threshold;
  const topK = req.topK;

  logger.info({ repoFullName, productLabel, threshold, topK }, 'Reclustering bucket');

  await db.pool.query(
    `
    delete from issue_cluster_map
    where repo = $1 and product_label = $2
    `,
    [repoFullName, productLabel]
  );
  await db.pool.query(
    `
    delete from clusters
    where repo = $1 and product_label = $2
    `,
    [repoFullName, productLabel]
  );

  const issuesRes = await db.pool.query(
    `
    select i.issue_number, i.embedding, i.comments_count, i.reactions_total_count, i.updated_at
    from issues i
    join issue_products p on p.repo = i.repo and p.issue_number = i.issue_number
    where i.repo = $1
      and i.state = 'open'
      and i.embedding is not null
      and p.product_label = $2
    order by i.issue_number asc
    `,
    [repoFullName, productLabel]
  );

  let mapped = 0;
  for (const row of issuesRes.rows) {
    const issueNumber = row.issue_number as number;
    const embedding = parseVector(row.embedding);
    const embeddingLit = toVectorLiteral(embedding);
    const popularity = issuePopularity({
      comments: Number(row.comments_count ?? 0),
      reactions: Number(row.reactions_total_count ?? 0),
      updatedAt: row.updated_at as string,
    });

    const nearest = await db.pool.query(
      `
      select cluster_id, centroid, size, (centroid <=> $3::vector) as cosine_distance
      from clusters
      where repo = $1 and product_label = $2
      order by centroid <=> $3::vector asc
      limit $4
      `,
      [repoFullName, productLabel, embeddingLit, topK]
    );

    let chosenClusterId: string | null = null;
    let chosenSimilarity = -1;
    let chosenCentroid: number[] | null = null;
    let chosenSize = 0;

    for (const c of nearest.rows) {
      const sim = cosineSimilarityFromDistance(Number(c.cosine_distance));
      if (sim > chosenSimilarity) {
        chosenSimilarity = sim;
        chosenClusterId = c.cluster_id as string;
        chosenCentroid = parseVector(c.centroid);
        chosenSize = Number(c.size);
      }
    }

    if (!chosenClusterId || chosenSimilarity < threshold || !chosenCentroid) {
      const created = await db.pool.query(
        `
        insert into clusters (repo, target_version, product_label, threshold_used, topk_used, centroid, size, popularity, representative_issue_number, updated_at)
        values ($1, $2, $3, $4, $5, $6::vector, 1, $7, $8, now())
        returning cluster_id
        `,
        [repoFullName, targetVersion, productLabel, threshold, topK, embeddingLit, popularity, issueNumber]
      );
      const clusterId = created.rows[0].cluster_id as string;
      await db.pool.query(
        `
        insert into issue_cluster_map (repo, issue_number, target_version, product_label, cluster_id, similarity, assigned_at)
        values ($1, $2, $3, $4, $5, $6, now())
        `,
        [repoFullName, issueNumber, targetVersion, productLabel, clusterId, 1]
      );
      mapped++;
      continue;
    }

    await db.pool.query(
      `
      insert into issue_cluster_map (repo, issue_number, target_version, product_label, cluster_id, similarity, assigned_at)
      values ($1, $2, $3, $4, $5, $6, now())
      `,
      [repoFullName, issueNumber, targetVersion, productLabel, chosenClusterId, chosenSimilarity]
    );

    const nextCentroid = meanVector(chosenCentroid, chosenSize, embedding);
    await db.pool.query(
      `
      update clusters
      set centroid = $2::vector,
          size = size + 1,
          popularity = popularity + $3,
          updated_at = now()
      where cluster_id = $1
      `,
      [chosenClusterId, toVectorLiteral(nextCentroid), popularity]
    );
    mapped++;
  }

  // Best-effort representative: pick the issue closest to the final centroid for each cluster.
  await db.pool.query(
    `
    update clusters c
    set representative_issue_number = (
      select m.issue_number
      from issue_cluster_map m
      join issues i on i.repo = m.repo and i.issue_number = m.issue_number
      where m.cluster_id = c.cluster_id and i.embedding is not null
      order by (c.centroid <=> i.embedding) asc
      limit 1
    )
    where c.repo = $1 and c.product_label = $2
    `,
    [repoFullName, productLabel]
  );

  const clusterCountRes = await db.pool.query(
    `
    select count(*)::int as cnt
    from clusters
    where repo = $1 and product_label = $2
    `,
    [repoFullName, productLabel]
  );
  const clusters = Number(clusterCountRes.rows[0]?.cnt ?? 0);

  logger.info({ repoFullName, productLabel, clusters, mapped }, 'Recluster complete');
  return { clusters, mapped };
}
