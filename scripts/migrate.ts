import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Client } from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('Missing DATABASE_URL');
}

// Resolve migrations relative to this file so it works regardless of the current working dir
// (e.g. when invoked via `pnpm --dir scripts db:migrate`).
const scriptsDir = fileURLToPath(new URL('.', import.meta.url));
const migrationsDir = resolve(scriptsDir, '..', 'migrations');

const client = new Client({ connectionString: databaseUrl });
await client.connect();

try {
  await client.query('begin');
  await client.query(`
    create table if not exists schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    );
  `);
  await client.query('commit');
} catch (error) {
  await client.query('rollback');
  throw error;
}

const applied = await client.query<{ version: string }>('select version from schema_migrations');
const appliedSet = new Set(applied.rows.map((r) => r.version));

const files = (await readdir(migrationsDir))
  .filter((f) => /^\d+_.*\.sql$/.test(f))
  .sort((a, b) => a.localeCompare(b));

for (const file of files) {
  if (appliedSet.has(file)) continue;
  const sql = await readFile(resolve(migrationsDir, file), 'utf-8');

  await client.query('begin');
  try {
    await client.query(sql);
    await client.query('insert into schema_migrations(version) values ($1)', [file]);
    await client.query('commit');
    console.log(`Applied migration ${file}`);
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

await client.end();
