/**
 * Extract embeddings only (no clustering, no DB write).
 * Usage: npx tsx --env-file=.env scripts/extract-embeddings.ts
 */
import pg from 'pg';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('Missing DATABASE_URL');

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 2,
  statement_timeout: 600000,    // 10 min
  query_timeout: 600000,
  connectionTimeoutMillis: 30000,
  idle_in_transaction_session_timeout: 600000,
});
const REPO = process.env.DEFAULT_REPO ?? 'microsoft/PowerToys';
const EMBEDDING_MODEL = process.env.ISSUE_EMBEDDING_MODEL_ID?.trim() || null;

async function main() {
  console.log(`Extracting embeddings for ${REPO} (batched)...`);

  // First get issue metadata (fast, no embeddings)
  const { rows: metaRows } = await pool.query(`
    select i.issue_number, i.title, p.product_label,
           i.comments_count, i.reactions_total_count, i.updated_at
    from issues i
    join issue_products p on p.repo = i.repo and p.issue_number = i.issue_number
    where i.repo = $1
      and i.state = 'open'
      and i.embedding is not null
      and ($2::text is null or i.embedding_model = $2)
  `, [REPO, EMBEDDING_MODEL]);
  console.log(`  Found ${metaRows.length} issues, fetching embeddings in batches...`);

  // Fetch embeddings in batches of 500
  const BATCH = 500;
  const issueNumbers = metaRows.map((r: any) => Number(r.issue_number));
  const embMap = new Map<number, number[]>();

  for (let i = 0; i < issueNumbers.length; i += BATCH) {
    const batch = issueNumbers.slice(i, i + BATCH);
    const placeholders = batch.map((_: number, j: number) => `$${j + 2}`).join(',');
    const { rows: embRows } = await pool.query(
      `SELECT issue_number, embedding FROM issues WHERE repo = $1 AND issue_number IN (${placeholders})`,
      [REPO, ...batch],
    );
    for (const r of embRows) {
      embMap.set(Number(r.issue_number), parseVector(r.embedding));
    }
    console.log(`    Batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(issueNumbers.length / BATCH)}: ${embRows.length} embeddings`);
  }

  const issues = metaRows.filter((r: any) => embMap.has(Number(r.issue_number))).map((r: any) => ({
    issueNumber: Number(r.issue_number),
    title: r.title as string,
    productLabel: r.product_label as string,
    embedding: embMap.get(Number(r.issue_number))!,
    commentsCount: Number(r.comments_count ?? 0),
    reactionsCount: Number(r.reactions_total_count ?? 0),
    updatedAt: r.updated_at as string,
  }));

  const outFile = join(__dirname, 'embeddings.json');
  writeFileSync(outFile, JSON.stringify(issues));
  console.log(`Extracted ${issues.length} issues across ${new Set(issues.map(i => i.productLabel)).size} products → ${outFile}`);
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
