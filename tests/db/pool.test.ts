import { describe, expect, it } from 'vitest';

import { resolveDatabaseConfig } from '../../src/db/config.js';
import { closePool, createPool } from '../../src/db/pool.js';

/**
 * Points at a closed port on the local machine. Creating a pool for it must
 * still succeed, which is what proves connection is lazy.
 */
const unreachableLocalUrl = 'postgresql://postgres:not-a-real-password@127.0.0.1:1/postgres';

function unreachableConfig() {
  return resolveDatabaseConfig({
    nodeEnv: 'test',
    source: { DATABASE_URL: unreachableLocalUrl },
    connectionTimeoutMillis: 500,
  });
}

describe('createPool', () => {
  it('does not connect when the pool is created', async () => {
    const pool = createPool(unreachableConfig());

    // No client has been requested, so nothing has reached the network.
    expect(pool.totalCount).toBe(0);
    expect(pool.idleCount).toBe(0);

    await closePool(pool);
  });
});

describe('closePool', () => {
  it('closes an open pool', async () => {
    const pool = createPool(unreachableConfig());

    await closePool(pool);

    expect(pool.ended).toBe(true);
  });

  it('is safe to call twice, so shutdown paths need no bookkeeping', async () => {
    const pool = createPool(unreachableConfig());

    await closePool(pool);
    await expect(closePool(pool)).resolves.toBeUndefined();
  });
});
