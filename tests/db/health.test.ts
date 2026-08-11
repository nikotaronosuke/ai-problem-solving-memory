import { describe, expect, it } from 'vitest';

import { checkDatabaseConnection } from '../../src/db/health.js';
import type { DatabasePool } from '../../src/db/pool.js';

type ProbeResult = { rows: { ok: number }[] };

/** Minimal stand-in for a pool, so health can be tested without a database. */
function stubPool(query: () => Promise<ProbeResult>): DatabasePool {
  return { query } as unknown as DatabasePool;
}

describe('checkDatabaseConnection', () => {
  it('reports a reachable database', async () => {
    const health = await checkDatabaseConnection(
      stubPool(() => Promise.resolve({ rows: [{ ok: 1 }] })),
    );

    expect(health.reachable).toBe(true);
    expect(health.error).toBeUndefined();
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reports failure instead of throwing, so Memory trouble cannot stop the caller', async () => {
    const health = await checkDatabaseConnection(
      stubPool(() => Promise.reject(new Error('connection refused'))),
    );

    expect(health.reachable).toBe(false);
    expect(health.error).toBe('connection refused');
  });

  it('treats an unexpected probe result as unreachable', async () => {
    const health = await checkDatabaseConnection(stubPool(() => Promise.resolve({ rows: [] })));

    expect(health.reachable).toBe(false);
    expect(health.error).toBe('unexpected probe result');
  });
});
