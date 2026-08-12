/**
 * Integration test against a real PostgreSQL.
 *
 * Skipped when `DATABASE_URL` is not set, so the suite still passes on a
 * machine with no local stack running. Start one with `npm run supabase:start`
 * and copy the DB URL into `.env` to exercise this file.
 *
 * `resolveDatabaseConfig` refuses a non-local host while NODE_ENV is test, so
 * this cannot reach a real deployment.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { checkDatabaseConnection } from '../../src/db/health.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';

const databaseUrl = readDatabaseUrl();

describe.skipIf(databaseUrl === undefined)('database connection', () => {
  let pool: DatabasePool;

  beforeAll(() => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
  });

  afterAll(async () => {
    await closePool(pool);
  });

  it('answers a health probe', async () => {
    const health = await checkDatabaseConnection(pool);

    expect(health.reachable).toBe(true);
    expect(health.error).toBeUndefined();
  });

  it('runs a query through the pool', async () => {
    const result = await pool.query<{ value: number }>('select 1 + 1 as value');

    expect(result.rows[0]?.value).toBe(2);
  });

  it('has the migration ledger, so migrations have been applied', async () => {
    const result = await pool.query<{ count: string }>(
      'select count(*)::text as count from supabase_migrations.schema_migrations',
    );

    expect(Number(result.rows[0]?.count)).toBeGreaterThanOrEqual(1);
  });

  it('has only the tables the phase has reached', async () => {
    const result = await pool.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public'",
    );

    // P1-05 adds `owners`, P1-06 `projects`, P1-07 `environments`. Problem,
    // Event, Verification and Relation are designed from P1-08 onward.
    expect(result.rows.map((row) => row.table_name).sort()).toEqual([
      'environments',
      'owners',
      'projects',
    ]);
  });
});
