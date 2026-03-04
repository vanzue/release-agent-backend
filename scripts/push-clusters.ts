/**
 * Push clusters.json results to the remote database.
 * Reads clusters.json (cluster assignments) and embeddings.json (vectors)
 * to compute centroids and write to clusters + issue_cluster_map tables.
 *
 * Usage: npx tsx --env-file=.env ../../scripts/push-clusters.ts [targetVersion]
 *   targetVersion defaults to "__all__"
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import pg from 'pg';
const { Pool } = pg;

const REPO = 'microsoft/PowerToys';
const DATABASE_URL = process.env.DATABASE_URL!;

interface ClusterItem {
  issueNumber: number;
  productLabel: string;
  title: string;
  clusterId: number;
  similarity: number;
}

interface EmbeddingItem {
  issueNumber: number;
  productLabel: string;
  embedding: number[];
  commentsCount: number;
  reactionsCount: number;
  updatedAt: string;
}

async function main() {
  const targetVersion = process.argv[2] ?? '__all__';
  const scriptDir = join(import.meta.dirname ?? __dirname);
  const clustersFile = join(scriptDir, 'clusters.json');
  const embeddingsFile = join(scriptDir, 'embeddings.json');

  console.log(`Loading data...`);
  const clusters: ClusterItem[] = JSON.parse(readFileSync(clustersFile, 'utf-8'));
  const embeddings: EmbeddingItem[] = JSON.parse(readFileSync(embeddingsFile, 'utf-8'));

  // Build embedding lookup
  const embMap = new Map<string, EmbeddingItem>();
  for (const e of embeddings) {
    embMap.set(`${e.productLabel}:${e.issueNumber}`, e);
  }

  // Group cluster items by product+clusterId (skip noise = clusterId < 0)
  const groups = new Map<string, ClusterItem[]>();
  let noiseCount = 0;
  for (const c of clusters) {
    if (c.clusterId < 0) { noiseCount++; continue; }
    const key = `${c.productLabel}::${c.clusterId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }

  console.log(`Found ${groups.size} cluster groups, ${noiseCount} unique issues (skipped)`);
  console.log(`Target version: ${targetVersion}\n`);

  const pool = new Pool({
    connectionString: DATABASE_URL,
    max: 3,
    statement_timeout: 600000,
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Delete existing clusters (CASCADE deletes issue_cluster_map)
    console.log(`Clearing existing clusters for target_version='${targetVersion}'...`);
    const { rowCount: clusterDeleted } = await client.query(
      `DELETE FROM clusters WHERE repo = $1 AND target_version = $2`,
      [REPO, targetVersion],
    );
    // Also clean up any orphaned mappings
    await client.query(
      `DELETE FROM issue_cluster_map WHERE repo = $1 AND target_version = $2`,
      [REPO, targetVersion],
    );
    console.log(`  Deleted ${clusterDeleted} clusters (+ cascaded mappings)\n`);

    // Insert new clusters
    let totalMappings = 0;
    let totalClusters = 0;

    for (const [key, members] of groups) {
    const productLabel = members[0].productLabel;

    // Compute centroid from embeddings
    const memberEmbs = members
      .map(m => embMap.get(`${m.productLabel}:${m.issueNumber}`)?.embedding)
      .filter((e): e is number[] => !!e && e.length > 0);

    if (memberEmbs.length === 0) continue;

    const dim = memberEmbs[0].length;
    const centroid = new Array(dim).fill(0);
    for (const emb of memberEmbs) {
      for (let i = 0; i < dim; i++) centroid[i] += emb[i];
    }
    for (let i = 0; i < dim; i++) centroid[i] /= memberEmbs.length;

    // Popularity score
    const popularity = members.reduce((sum, m) => {
      const iss = embMap.get(`${m.productLabel}:${m.issueNumber}`);
      if (!iss) return sum;
      return sum + 2 * Math.log1p(iss.commentsCount) + Math.log1p(iss.reactionsCount) +
        Math.max(0, 30 - (Date.now() - Date.parse(iss.updatedAt)) / 86400000) / 30;
    }, 0);

    // Best representative = highest similarity to centroid
    const bestMember = members.reduce((best, m) => m.similarity > best.similarity ? m : best, members[0]);

    const centroidLit = `[${centroid.map(v => Number.isFinite(v) ? v : 0).join(',')}]`;

    const { rows: [cluster] } = await client.query(`
      INSERT INTO clusters (repo, target_version, product_label, threshold_used, topk_used, centroid, size, popularity, representative_issue_number, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8, $9, now())
      RETURNING cluster_id
    `, [REPO, targetVersion, productLabel, 0.85, 0, centroidLit, members.length, popularity, bestMember.issueNumber]);

    const clusterId = cluster.cluster_id;

    for (const m of members) {
      await client.query(`
        INSERT INTO issue_cluster_map (repo, issue_number, target_version, product_label, cluster_id, similarity, assigned_at)
        VALUES ($1, $2, $3, $4, $5, $6, now())
        ON CONFLICT (repo, issue_number, target_version, product_label)
        DO UPDATE SET cluster_id = EXCLUDED.cluster_id, similarity = EXCLUDED.similarity, assigned_at = now()
      `, [REPO, m.issueNumber, targetVersion, productLabel, clusterId, m.similarity]);
    }

    totalClusters++;
    totalMappings += members.length;
  }

    await client.query('COMMIT');
    console.log(`\n=== Done! ===`);
    console.log(`  Inserted ${totalClusters} clusters, ${totalMappings} issue mappings`);
    console.log(`  Target version: ${targetVersion}`);

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
