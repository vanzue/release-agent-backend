import { Pool } from 'pg';

export type Db = {
  pool: Pool;
};

export function createDb(): Db {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('Missing DATABASE_URL');
  }

  const pool = new Pool({
    connectionString,
    max: Number.parseInt(process.env.DB_POOL_MAX ?? '10', 10),
  });

  return { pool };
}

