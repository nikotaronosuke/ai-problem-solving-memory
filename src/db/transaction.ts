/**
 * Running several statements as one.
 *
 * Until now every write stood alone, so the executor seam was enough: a pool
 * satisfies it, and each statement was its own implicit transaction. Recording
 * a change alongside the change itself is the first thing that genuinely needs
 * more than one statement to succeed or fail together — a Problem edited with
 * no record of it, or a record of an edit that did not happen, are both worse
 * than the write failing outright.
 *
 * The shape is deliberately small: hand in work that takes an executor, get
 * back its result. The work does not see the client, cannot commit or roll
 * back on its own, and cannot keep the connection past the call. Throwing is
 * how work asks for a rollback, which means an unexpected failure rolls back
 * too rather than needing to be anticipated.
 *
 * `pg` stops here. Nothing above this module knows a connection is checked out,
 * and the application layer works through an owner-scoped wrapper rather than
 * this interface directly.
 */

import type { DatabasePool } from './pool.js';
import type { DatabaseExecutor } from './executor.js';

export interface DatabaseTransactionRunner {
  /**
   * Runs `work` in a transaction, committing if it returns and rolling back if
   * it throws.
   *
   * The executor handed to `work` is a single connection for the duration, so
   * everything done through it is inside the same transaction. It must not be
   * kept: once `run` settles, the connection goes back to the pool.
   */
  run<T>(work: (executor: DatabaseExecutor) => Promise<T>): Promise<T>;
}

/**
 * A transaction runner over a connection pool.
 *
 * The rollback is itself attempted inside a `try`. A connection that failed
 * mid-transaction may also fail to roll back — the server may have gone away —
 * and losing the original error to a secondary one would hide what actually
 * went wrong. The rollback failure is deliberately dropped in favour of the
 * cause, and the client is released either way so a failure cannot leak a
 * connection.
 */
export function createTransactionRunner(pool: DatabasePool): DatabaseTransactionRunner {
  return {
    async run<T>(work: (executor: DatabaseExecutor) => Promise<T>): Promise<T> {
      const client = await pool.connect();

      try {
        await client.query('begin');
        const result = await work(client);
        await client.query('commit');
        return result;
      } catch (error) {
        try {
          await client.query('rollback');
        } catch {
          // Report why the work failed, not why the cleanup did.
        }
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
