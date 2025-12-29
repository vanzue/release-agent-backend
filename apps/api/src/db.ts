import pg from 'pg';

const { Pool } = pg;

export type Db = {
  pool: pg.Pool;
};

export function createDb(): Db {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('Missing DATABASE_URL');
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    max: Number.parseInt(process.env.DB_POOL_MAX ?? '10', 10),
  });

  return { pool };
}

