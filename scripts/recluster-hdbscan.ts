/**
 * Extract issue embeddings from DB → embeddings.json
 * Run HDBSCAN (Python) → clusters.json
 * Write cluster results back to DB
 *
 * Usage: npx tsx --env-file=.env scripts/recluster-hdbscan.ts [min_cluster_size] [min_samples]
 */

import pg from 'pg';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('Missing DATABASE_URL');

const pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
const REPO = process.env.DEFAULT_REPO ?? 'microsoft/PowerToys';
const EMBEDDING_MODEL = process.env.ISSUE_EMBEDDING_MODEL_ID?.trim() || null;
const MIN_CLUSTER_SIZE = process.argv[2] ?? '3';
const MIN_SAMPLES = process.argv[3] ?? '2';

async function main() {
  console.log(`\n=== HDBSCAN Recluster for ${REPO} ===\n`);

  // Step 1: Extract embeddings
  console.log('Step 1: Extracting embeddings from DB...');
  const { rows } = await pool.query(`
    select i.issue_number, i.title, i.embedding, p.product_label,
           i.comments_count, i.reactions_total_count, i.updated_at
    from issues i
    join issue_products p on p.repo = i.repo and p.issue_number = i.issue_number
    where i.repo = $1
      and i.state = 'open'
      and i.embedding is not null
      and ($2::text is null or i.embedding_model = $2)
  `, [REPO, EMBEDDING_MODEL]);

  const issues = rows.map((r: any) => ({
    issueNumber: Number(r.issue_number),
    title: r.title as string,
    productLabel: r.product_label as string,
    embedding: parseVector(r.embedding),
    commentsCount: Number(r.comments_count ?? 0),
    reactionsCount: Number(r.reactions_total_count ?? 0),
    updatedAt: r.updated_at as string,
  }));

  console.log(`  Extracted ${issues.length} issues across ${new Set(issues.map(i => i.productLabel)).size} products`);

  const embeddingsFile = join(__dirname, 'embeddings.json');
  const clustersFile = join(__dirname, 'clusters.json');
  writeFileSync(embeddingsFile, JSON.stringify(issues));

  // Step 2: Run HDBSCAN
  console.log('\nStep 2: Running HDBSCAN clustering...');
  const pythonScript = join(__dirname, 'hdbscan_cluster.py');
  execSync(
    `python "${pythonScript}" "${embeddingsFile}" "${clustersFile}" ${MIN_CLUSTER_SIZE} ${MIN_SAMPLES}`,
    { stdio: 'inherit' },
  );

  // Step 3: Read results and write to DB
  console.log('\nStep 3: Writing cluster results to DB...');
  const clusterResults: Array<{
    issueNumber: number;
    productLabel: string;
    clusterId: number;
    similarity: number;
  }> = JSON.parse(readFileSync(clustersFile, 'utf-8'));

  // Group by product
  const byProduct = new Map<string, typeof clusterResults>();
  for (const r of clusterResults) {
    if (!byProduct.has(r.productLabel)) byProduct.set(r.productLabel, []);
    byProduct.get(r.productLabel)!.push(r);
  }

  const targetVersion = '__all__';
  const threshold = 0.85;
  const topK = 5;

  for (const [productLabel, items] of byProduct) {
    // Clear old clusters
    await pool.query(
      `DELETE FROM issue_cluster_map WHERE repo = $1 AND product_label = $2 AND target_version = $3`,
      [REPO, productLabel, targetVersion],
    );
    await pool.query(
      `DELETE FROM clusters WHERE repo = $1 AND product_label = $2 AND target_version = $3`,
      [REPO, productLabel, targetVersion],
    );

    // Group items by HDBSCAN cluster ID (skip noise = -1)
    const clusterGroups = new Map<number, typeof items>();
    let noiseCount = 0;
    for (const item of items) {
      if (item.clusterId < 0) { noiseCount++; continue; }
      if (!clusterGroups.has(item.clusterId)) clusterGroups.set(item.clusterId, []);
      clusterGroups.get(item.clusterId)!.push(item);
    }

    for (const [_hdbLabel, members] of clusterGroups) {
      // Compute centroid from member embeddings
      const memberEmbeddings = members.map(m => {
        const issue = issues.find(i => i.issueNumber === m.issueNumber && i.productLabel === m.productLabel);
        return issue?.embedding ?? [];
      }).filter(e => e.length > 0);

      if (memberEmbeddings.length === 0) continue;

      const dim = memberEmbeddings[0].length;
      const centroid = new Array(dim).fill(0);
      for (const emb of memberEmbeddings) {
        for (let i = 0; i < dim; i++) centroid[i] += emb[i];
      }
      for (let i = 0; i < dim; i++) centroid[i] /= memberEmbeddings.length;

      // Popularity = sum of member popularities
      const popularity = members.reduce((sum, m) => {
        const iss = issues.find(i => i.issueNumber === m.issueNumber && i.productLabel === m.productLabel);
        if (!iss) return sum;
        return sum + 2 * Math.log1p(iss.commentsCount) + Math.log1p(iss.reactionsCount) +
          Math.max(0, 30 - (Date.now() - Date.parse(iss.updatedAt)) / 86400000) / 30;
      }, 0);

      // Best representative = member with highest similarity to centroid
      const bestMember = members.reduce((best, m) => m.similarity > best.similarity ? m : best, members[0]);

      const centroidLit = `[${centroid.map(v => Number.isFinite(v) ? v : 0).join(',')}]`;

      const { rows: [cluster] } = await pool.query(`
        INSERT INTO clusters (repo, target_version, product_label, threshold_used, topk_used, centroid, size, popularity, representative_issue_number, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8, $9, now())
        RETURNING cluster_id
      `, [REPO, targetVersion, productLabel, threshold, topK, centroidLit, members.length, popularity, bestMember.issueNumber]);

      const clusterId = cluster.cluster_id;

      for (const m of members) {
        await pool.query(`
          INSERT INTO issue_cluster_map (repo, issue_number, target_version, product_label, cluster_id, similarity, assigned_at)
          VALUES ($1, $2, $3, $4, $5, $6, now())
        `, [REPO, m.issueNumber, targetVersion, productLabel, clusterId, m.similarity]);
      }
    }

    console.log(`  ${productLabel}: ${clusterGroups.size} clusters, ${noiseCount} outliers skipped`);
  }

  // Cleanup temp files
  try { unlinkSync(embeddingsFile); } catch {}
  try { unlinkSync(clustersFile); } catch {}

  console.log('\n=== Done! ===\n');
  await pool.end();
}

function parseVector(text: unknown): number[] {
  if (Array.isArray(text)) return text.map((n: any) => Number(n));
  if (typeof text !== 'string') throw new Error(`Invalid vector: ${typeof text}`);
  const trimmed = text.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) throw new Error(`Bad format: ${trimmed.slice(0, 32)}`);
  return trimmed.slice(1, -1).split(',').map(s => parseFloat(s.trim()));
}

main().catch(e => { console.error(e); process.exit(1); });
