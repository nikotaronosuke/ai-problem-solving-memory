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
    expect(health.reason).toBeUndefined();
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

    // P1-05 adds `owners`, P1-06 `projects`, P1-07 `environments`, P1-08
    // `problems`, P1-09 `events`, P1-10 `verifications`, P2-08 `relations`.
    // UsageLog and ChangeLog are still to come.
    expect(result.rows.map((row) => row.table_name).sort()).toEqual([
      'change_logs',
      'client_credentials',
      'clients',
      'environments',
      'events',
      'owners',
      'problems',
      'projects',
      'relations',
      'retrieval_artifacts',
      'usage_logs',
      'verifications',
    ]);
  });
});

/**
 * What a real failed probe reports (P3-10 §14).
 *
 * Against real drivers rather than stubs, because the thing being replaced was
 * the driver's own message and a stub cannot produce one. Measured before the
 * change, `HealthReport.detail` held `connect ECONNREFUSED 127.0.0.1:1`,
 * `getaddrinfo ENOTFOUND <database host>` and
 * `password authentication failed for user "postgres"` — a port, a host and an
 * account, each of them on its way to an operational log.
 */
describe.skipIf(databaseUrl === undefined)('a database that will not answer', () => {
  /** Everything in the report, as it would reach a log line. */
  function asWritten(report: unknown): string {
    return JSON.stringify(report);
  }

  it('reports a refused connection without the address it was refused at', async () => {
    const unreachable = createPool({
      poolConfig: {
        connectionString: 'postgresql://memory:pw@127.0.0.1:1/memorydb',
        connectionTimeoutMillis: 3_000,
      },
      host: '127.0.0.1',
      isLocal: true,
    });

    const health = await checkDatabaseConnection(unreachable);

    expect(health.reachable).toBe(false);
    expect(health.reason).toBe('CONNECTION_FAILED');
    expect(Object.keys(health).sort()).toEqual(['latencyMs', 'reachable', 'reason']);
    expect(asWritten(health)).not.toContain('ECONNREFUSED');
    expect(asWritten(health)).not.toContain('127.0.0.1');
    expect(asWritten(health)).not.toContain(':1');

    await closePool(unreachable);
  });

  it('reports a rejected account without naming it', async () => {
    // A live server, reached and refused — which is the case that carries a
    // user name in the driver's message.
    const url = new URL(databaseUrl!);
    url.username = 'p310_rejected_account';
    url.password = 'p310-wrong-password';

    const refused = createPool({
      poolConfig: { connectionString: url.toString(), connectionTimeoutMillis: 3_000 },
      host: url.hostname,
      isLocal: true,
    });

    const health = await checkDatabaseConnection(refused);

    expect(health.reachable).toBe(false);
    // The server answered and refused, which is a different fact from nothing
    // answering, and the classifier is expected to tell them apart. Accepting
    // either would let the distinction rot without failing.
    expect(health.reason).toBe('AUTHENTICATION_FAILED');
    expect(Object.keys(health).sort()).toEqual(['latencyMs', 'reachable', 'reason']);
    expect(asWritten(health)).not.toContain('p310_rejected_account');
    expect(asWritten(health)).not.toContain('p310-wrong-password');
    expect(asWritten(health)).not.toContain('password authentication failed');
    expect(asWritten(health)).not.toContain(url.hostname);

    await closePool(refused);
  });
});
