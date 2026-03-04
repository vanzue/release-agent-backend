import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const repo = 'microsoft/PowerToys';
const tv = '__all__';
const r1 = await pool.query('DELETE FROM issue_cluster_map WHERE repo = $1 AND target_version = $2', [repo, tv]);
const r2 = await pool.query('DELETE FROM clusters WHERE repo = $1 AND target_version = $2', [repo, tv]);
console.log('Deleted mappings:', r1.rowCount, 'clusters:', r2.rowCount);
await pool.end();
