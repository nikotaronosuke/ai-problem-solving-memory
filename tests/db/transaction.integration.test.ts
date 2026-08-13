/**
 * The transaction runner, against the real database.
 *
 * Small surface, but everything about change logging rests on it: if a
 * rollback did not actually roll back, a Problem could end up edited with a
 * history entry that describes something else, and nothing above would notice.
 *
 * The connection accounting matters as much as the commit. A runner that
 * leaked a client on failure would work perfectly until the pool ran dry.
 *
 * Skipped when `DATABASE_URL` is not set.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { createProject } from '../../src/db/projects.js';
import { createTransactionRunner } from '../../src/db/transaction.js';
import { generateOwnerId, type OwnerContext, type OwnerId } from '../../src/domain/owner.js';

const databaseUrl = readDatabaseUrl();

describe.skipIf(databaseUrl === undefined)('transaction runner', () => {
  let pool: DatabasePool;
  const ownersCreated: OwnerId[] = [];

  async function makeOwnerContext(): Promise<OwnerContext> {
    const ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);
    return { ownerId } as OwnerContext;
  }

  async function countProjects(ownerId: string): Promise<number> {
    const result = await pool.query<{ count: string }>(
      'select count(*)::text as count from public.projects where owner_id = $1',
      [ownerId],
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  beforeAll(() => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
  });

  afterAll(async () => {
    if (ownersCreated.length > 0) {
      for (const table of ['change_logs', 'problems', 'environments', 'projects', 'owners']) {
        await pool.query(`delete from public.${table} where owner_id = any($1::uuid[])`, [
          ownersCreated,
        ]);
      }
    }
    await closePool(pool);
  });

  it('commits what the work did, and returns its result', async () => {
    const runner = createTransactionRunner(pool);
    const context = await makeOwnerContext();

    const created = await runner.run(async (executor) => {
      const first = await createProject(executor, context, { projectName: 'one' });
      const second = await createProject(executor, context, { projectName: 'two' });
      return [first.projectName, second.projectName];
    });

    expect(created).toEqual(['one', 'two']);
    expect(await countProjects(context.ownerId)).toBe(2);
  });

  it('rolls everything back when the work throws', async () => {
    const runner = createTransactionRunner(pool);
    const context = await makeOwnerContext();

    await expect(
      runner.run(async (executor) => {
        await createProject(executor, context, { projectName: 'written first' });
        throw new Error('changed my mind');
      }),
    ).rejects.toThrow('changed my mind');

    // The first write is gone too. Throwing is how work asks for a rollback,
    // and an unexpected failure gets the same treatment without having to be
    // anticipated.
    expect(await countProjects(context.ownerId)).toBe(0);
  });

  it('rolls back when the database itself refuses', async () => {
    const runner = createTransactionRunner(pool);
    const context = await makeOwnerContext();

    await expect(
      runner.run(async (executor) => {
        await createProject(executor, context, { projectName: 'written first' });
        // No such owner, so the foreign key refuses.
        await executor.query(
          'insert into public.projects (project_id, owner_id, project_name) values ($1, $2, $3)',
          [generateOwnerId(), generateOwnerId(), 'orphan'],
        );
      }),
    ).rejects.toThrow(/violates foreign key constraint/);

    expect(await countProjects(context.ownerId)).toBe(0);
  });

  it('sees its own uncommitted writes inside the transaction', async () => {
    const runner = createTransactionRunner(pool);
    const context = await makeOwnerContext();

    const seenInside = await runner.run(async (executor) => {
      await createProject(executor, context, { projectName: 'inside' });
      const result = await executor.query<{ count: string }>(
        'select count(*)::text as count from public.projects where owner_id = $1',
        [context.ownerId],
      );
      return Number(result.rows[0]?.count ?? '0');
    });

    // One connection for the duration, so the work reads what it just wrote.
    expect(seenInside).toBe(1);
  });

  it('does not leak a connection, whether the work succeeds or fails', async () => {
    const runner = createTransactionRunner(pool);
    const context = await makeOwnerContext();
    const before = pool.totalCount;

    for (let index = 0; index < 12; index += 1) {
      await runner.run((executor) =>
        createProject(executor, context, { projectName: `p${index}` }),
      );
      await expect(runner.run(() => Promise.reject(new Error('no')))).rejects.toThrow('no');
    }

    // Twenty-four transactions through a pool that would exhaust well before
    // that if failure kept a client checked out.
    expect(pool.idleCount).toBeGreaterThan(0);
    expect(pool.totalCount).toBeLessThanOrEqual(Math.max(before, 1) + 2);
    expect(await countProjects(context.ownerId)).toBe(12);
  });

  it('reports why the work failed, not why the cleanup did', async () => {
    const runner = createTransactionRunner(pool);

    await expect(
      runner.run(async (executor) => {
        // Leaves the transaction aborted, so anything afterwards fails too.
        await expect(executor.query('select 1 from nonexistent_table')).rejects.toThrow();
        throw new Error('the reason that matters');
      }),
    ).rejects.toThrow('the reason that matters');
  });
});
