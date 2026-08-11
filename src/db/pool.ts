/**
 * Connection pool lifecycle.
 *
 * Importing this module opens no connection. A pool exists only once a caller
 * asks for one, and the caller owns closing it.
 */

import pg from 'pg';

import type { DatabaseConfig } from './config.js';

export type DatabasePool = pg.Pool;

/**
 * Creates a connection pool.
 *
 * `pg` connects lazily, so this does not reach the database by itself. Use
 * `checkDatabaseConnection` to verify reachability.
 */
export function createPool(config: DatabaseConfig): DatabasePool {
  return new pg.Pool(config.poolConfig);
}

/**
 * Closes a pool and waits for its clients to drain.
 *
 * Safe to call more than once: a pool that has already ended is left alone, so
 * shutdown paths do not need to track whether they ran.
 */
export async function closePool(pool: DatabasePool): Promise<void> {
  if (pool.ending || pool.ended) {
    return;
  }

  await pool.end();
}
