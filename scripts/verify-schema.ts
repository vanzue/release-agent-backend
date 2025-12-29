import 'dotenv/config';
import { Client } from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('Missing DATABASE_URL');
}

interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: string;
}

interface IndexInfo {
  indexname: string;
}

interface ConstraintInfo {
  constraint_name: string;
  constraint_type: string;
}

// Expected schema definition
const expectedTables: Record<string, { columns: string[]; indexes?: string[] }> = {
  schema_migrations: {
    columns: ['version', 'applied_at'],
  },
  sessions: {
    columns: [
      'id', 'repo_full_name', 'name', 'status', 'base_ref', 'head_ref',
      'base_sha', 'head_sha', 'run_key', 'options', 'stats', 'created_at', 'updated_at'
    ],
    indexes: ['sessions_status_idx', 'sessions_repo_full_name_idx', 'sessions_run_key_idx'],
  },
  jobs: {
    columns: ['id', 'session_id', 'type', 'status', 'progress', 'started_at', 'completed_at', 'error'],
    indexes: ['jobs_session_id_idx', 'jobs_status_idx'],
  },
  session_artifacts: {
    columns: ['session_id', 'kind', 'data', 'updated_at'],
  },
  exports: {
    columns: ['id', 'session_id', 'created_at', 'results'],
  },
  commit_summaries: {
    columns: ['repo_full_name', 'commit_sha', 'summary_text', 'credited_login', 'pr_number', 'updated_at', 'status'],
    indexes: ['commit_summaries_updated_at_idx', 'commit_summaries_status_idx'],
  },
};

async function verifySchema() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  let allPassed = true;
  const results: { table: string; status: 'PASS' | 'FAIL'; details?: string }[] = [];

  try {
    // Check each expected table
    for (const [tableName, expected] of Object.entries(expectedTables)) {
      console.log(`\n🔍 Checking table: ${tableName}`);

      // Check if table exists
      const tableExists = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' AND table_name = $1
        )`,
        [tableName]
      );

      if (!tableExists.rows[0].exists) {
        console.log(`  ❌ Table does not exist`);
        results.push({ table: tableName, status: 'FAIL', details: 'Table does not exist' });
        allPassed = false;
        continue;
      }

      console.log(`  ✅ Table exists`);

      // Check columns
      const columns = await client.query<ColumnInfo>(
        `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1
         ORDER BY ordinal_position`,
        [tableName]
      );

      const actualColumns = columns.rows.map(r => r.column_name);
      const missingColumns = expected.columns.filter(c => !actualColumns.includes(c));
      const extraColumns = actualColumns.filter(c => !expected.columns.includes(c));

      if (missingColumns.length > 0) {
        console.log(`  ❌ Missing columns: ${missingColumns.join(', ')}`);
        results.push({ table: tableName, status: 'FAIL', details: `Missing columns: ${missingColumns.join(', ')}` });
        allPassed = false;
      } else {
        console.log(`  ✅ All expected columns present (${expected.columns.length})`);
      }

      if (extraColumns.length > 0) {
        console.log(`  ⚠️  Extra columns (not in expected): ${extraColumns.join(', ')}`);
      }

      // Check indexes if specified
      if (expected.indexes) {
        const indexes = await client.query<IndexInfo>(
          `SELECT indexname FROM pg_indexes WHERE tablename = $1`,
          [tableName]
        );

        const actualIndexes = indexes.rows.map(r => r.indexname);
        const missingIndexes = expected.indexes.filter(i => !actualIndexes.includes(i));

        if (missingIndexes.length > 0) {
          console.log(`  ❌ Missing indexes: ${missingIndexes.join(', ')}`);
          results.push({ table: tableName, status: 'FAIL', details: `Missing indexes: ${missingIndexes.join(', ')}` });
          allPassed = false;
        } else {
          console.log(`  ✅ All expected indexes present (${expected.indexes.length})`);
        }
      }

      if (!results.find(r => r.table === tableName)) {
        results.push({ table: tableName, status: 'PASS' });
      }
    }

    // Check applied migrations
    console.log(`\n🔍 Checking applied migrations:`);
    const migrations = await client.query<{ version: string; applied_at: Date }>(
      `SELECT version, applied_at FROM schema_migrations ORDER BY version`
    );

    for (const row of migrations.rows) {
      console.log(`  ✅ ${row.version} (applied at ${row.applied_at.toISOString()})`);
    }

    // Summary
    console.log(`\n${'='.repeat(50)}`);
    console.log(`📊 Schema Verification Summary:`);
    console.log(`${'='.repeat(50)}`);

    const passed = results.filter(r => r.status === 'PASS').length;
    const failed = results.filter(r => r.status === 'FAIL').length;

    console.log(`  Tables checked: ${results.length}`);
    console.log(`  ✅ Passed: ${passed}`);
    console.log(`  ❌ Failed: ${failed}`);

    if (allPassed) {
      console.log(`\n🎉 All schema checks PASSED!`);
    } else {
      console.log(`\n💥 Some schema checks FAILED. Please review above.`);
      process.exitCode = 1;
    }

  } finally {
    await client.end();
  }
}

verifySchema().catch((err) => {
  console.error('Schema verification error:', err);
  process.exitCode = 1;
});
