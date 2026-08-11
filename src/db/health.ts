/**
 * Database reachability check.
 *
 * Separate from pool creation: creating a pool is a configuration concern,
 * while checking reachability is an observation about the running system.
 */

import type { DatabasePool } from './pool.js';

export interface DatabaseHealth {
  readonly reachable: boolean;
  /** Round-trip time of the probe query, in milliseconds. */
  readonly latencyMs: number;
  /**
   * Why the probe failed. Derived from the driver's message, which describes
   * the failure without echoing the connection string.
   */
  readonly error?: string;
}

/**
 * Runs a trivial query to confirm the database answers.
 *
 * Never throws: an unreachable database is a reportable state, not an
 * exception, because Memory failure must not stop the caller's real work.
 */
export async function checkDatabaseConnection(pool: DatabasePool): Promise<DatabaseHealth> {
  const startedAt = performance.now();

  try {
    const result = await pool.query<{ ok: number }>('select 1 as ok');
    const latencyMs = Math.round(performance.now() - startedAt);

    if (result.rows[0]?.ok !== 1) {
      return { reachable: false, latencyMs, error: 'unexpected probe result' };
    }

    return { reachable: true, latencyMs };
  } catch (error) {
    return {
      reachable: false,
      latencyMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : 'unknown error',
    };
  }
}
