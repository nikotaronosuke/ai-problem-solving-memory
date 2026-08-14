/**
 * What happens when a delete races something else, against a real PostgreSQL.
 *
 * The interesting failures of a multi-table delete are not the ones a single
 * request produces. They are the ones that need two connections: an Event
 * arriving while the rows it belongs to are being removed, two deletes for the
 * same Problem, a transaction that gets partway and then fails. None of those
 * can be reproduced with a fake — they are properties of the database's
 * locking and of the transaction the production code opens — so this file uses
 * two real connections and the production functions.
 *
 * The failure is introduced from the test, never from the server: the rollback
 * case runs the real `deleteProblemAggregate` inside a real transaction and
 * then throws in the test's own callback. Nothing in `src/` gains a flag, a
 * hook, or a branch that exists to be broken.
 *
 * Skipped when `DATABASE_URL` is not set.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { createEnvironment } from '../../src/db/environments.js';
import { ProblemNotAvailableError } from '../../src/db/errors.js';
import { appendEvent } from '../../src/db/events.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { deleteProblemAggregate } from '../../src/db/problem-deletion.js';
import { createProblem } from '../../src/db/problems.js';
import { createProject } from '../../src/db/projects.js';
import { createRelation } from '../../src/db/relations.js';
import { createTransactionRunner } from '../../src/db/transaction.js';
import { createUsageLog } from '../../src/db/usage-logs.js';
import { generateClientEventId } from '../../src/domain/client-event-id.js';
import { generateOwnerId, type OwnerContext, type OwnerId } from '../../src/domain/owner.js';
import { MEMORY_OWNER_ID_VAR, resolveOwnerContext } from '../../src/owner/context.js';
import type { ProblemId } from '../../src/domain/problem.js';

const databaseUrl = readDatabaseUrl();

interface Fixture {
  readonly context: OwnerContext;
  readonly targetId: ProblemId;
  readonly neighbourId: ProblemId;
  readonly version: number;
}

describe.skipIf(databaseUrl === undefined)('a delete racing other work', () => {
  let pool: DatabasePool;
  const ownersCreated: OwnerId[] = [];

  /**
   * A Problem with a child, an incoming relation and an incoming usage log.
   *
   * Built through the database layer rather than HTTP: this file is about
   * connections and locks, and going through the API would add a second
   * connection pool to reason about for no gain.
   */
  async function seed(): Promise<Fixture> {
    const ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);
    // The production resolver, which confirms the owner exists — the same way
    // every other database-level test establishes a context.
    const context = await resolveOwnerContext(pool, { [MEMORY_OWNER_ID_VAR]: ownerId });

    const project = await createProject(pool, context, { projectName: 'concurrency' });
    const environment = await createEnvironment(pool, context, {
      projectId: project.projectId,
      snapshot: { runtime: 'node 22' },
    });

    const make = async (title: string) =>
      createProblem(pool, context, {
        projectId: project.projectId,
        environmentId: environment.environmentId,
        title,
        symptoms: 'symptoms',
      });

    const target = await make('target');
    const neighbour = await make('neighbour');

    await appendEvent(pool, context, {
      problemId: target.problemId,
      eventType: 'HYPOTHESIS',
      summary: 'a first thought',
      clientEventId: generateClientEventId(),
    });
    await createRelation(pool, context, {
      fromId: neighbour.problemId,
      toId: target.problemId,
      relationType: 'SIMILAR_TO',
      reason: 'points at the target',
    });
    await createUsageLog(pool, context, {
      problemId: neighbour.problemId,
      memoryId: target.problemId,
      sourceAi: 'claude-code',
      action: 'ADOPTED',
      reason: 'used the target as memory',
    });

    return {
      context,
      targetId: target.problemId,
      neighbourId: neighbour.problemId,
      version: target.version,
    };
  }

  async function countsFor(fixture: Fixture): Promise<Record<string, number>> {
    const one = async (sql: string): Promise<number> => {
      const result = await pool.query<{ n: string }>(sql, [
        fixture.context.ownerId,
        fixture.targetId,
      ]);
      return Number(result.rows[0]?.n ?? '0');
    };

    return {
      problems: await one(
        `select count(*) n from public.problems where owner_id = $1 and problem_id = $2`,
      ),
      events: await one(
        `select count(*) n from public.events where owner_id = $1 and problem_id = $2`,
      ),
      relations: await one(
        `select count(*) n from public.relations where owner_id = $1 and (from_id = $2 or to_id = $2)`,
      ),
      usageLogs: await one(
        `select count(*) n from public.usage_logs where owner_id = $1 and (problem_id = $2 or memory_id = $2)`,
      ),
    };
  }

  beforeAll(() => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
  });

  afterAll(async () => {
    if (ownersCreated.length > 0) {
      for (const table of [
        'change_logs',
        'usage_logs',
        'relations',
        'verifications',
        'events',
        'problems',
        'environments',
        'projects',
        'owners',
      ]) {
        await pool.query(`delete from public.${table} where owner_id = any($1::uuid[])`, [
          ownersCreated,
        ]);
      }
    }
    await closePool(pool);
  });

  it('rolls the whole thing back when the transaction fails partway', async () => {
    const fixture = await seed();
    const before = await countsFor(fixture);
    expect(before).toEqual({ problems: 1, events: 1, relations: 1, usageLogs: 1 });

    const runner = createTransactionRunner(pool);
    const boom = new Error('something failed after the deletes');

    await expect(
      runner.run(async (transactional) => {
        // The real function, doing the real deletes.
        const outcome = await deleteProblemAggregate(
          transactional,
          fixture.context,
          fixture.targetId,
          fixture.version,
        );
        expect(outcome).toBe('DELETED');

        // Inside the transaction the rows are already gone, which is what
        // makes the assertion after the rollback worth making.
        const seen = await transactional.query<{ n: string }>(
          `select count(*) n from public.events where owner_id = $1 and problem_id = $2`,
          [fixture.context.ownerId, fixture.targetId],
        );
        expect(seen.rows[0]?.n).toBe('0');

        throw boom;
      }),
    ).rejects.toBe(boom);

    // Every row back. Not "the Problem survived" — a delete that took the
    // events and left the Problem would be a Problem quietly missing its
    // history, with nothing recording that it happened.
    expect(await countsFor(fixture)).toEqual(before);
  });

  it('makes an event appended during the delete fail rather than orphan itself', async () => {
    const fixture = await seed();

    const client = await pool.connect();
    let appended: Promise<unknown> | undefined;

    try {
      await client.query('begin');
      // Takes the row lock and removes everything, but does not commit yet.
      const outcome = await deleteProblemAggregate(
        client,
        fixture.context,
        fixture.targetId,
        fixture.version,
      );
      expect(outcome).toBe('DELETED');

      // On another connection, against the Problem being deleted. This blocks:
      // inserting a row whose foreign key names the locked Problem has to wait
      // for the lock to be released.
      appended = appendEvent(pool, fixture.context, {
        problemId: fixture.targetId,
        eventType: 'DISCOVERY',
        summary: 'arrived mid-delete',
        clientEventId: generateClientEventId(),
      });

      // Long enough to be sure it is waiting rather than merely slow. If the
      // lock were not taken, this insert would already have succeeded and the
      // commit below would fail on the foreign key instead.
      const raced = await Promise.race([
        appended.then(() => 'appended' as const).catch(() => 'failed' as const),
        new Promise<'waiting'>((resolve) =>
          setTimeout(() => {
            resolve('waiting');
          }, 300),
        ),
      ]);
      expect(raced).toBe('waiting');

      await client.query('commit');
    } finally {
      client.release();
    }

    // Once the delete commits, the Problem the append names is gone, so the
    // insert fails the way appending to a Problem that is not there fails.
    await expect(appended).rejects.toBeInstanceOf(ProblemNotAvailableError);

    expect(await countsFor(fixture)).toEqual({
      problems: 0,
      events: 0,
      relations: 0,
      usageLogs: 0,
    });
  });

  it('lets only one of two concurrent deletes succeed', async () => {
    const fixture = await seed();
    const runner = createTransactionRunner(pool);

    const attempt = () =>
      runner.run((transactional) =>
        deleteProblemAggregate(transactional, fixture.context, fixture.targetId, fixture.version),
      );

    const [first, second] = await Promise.all([attempt(), attempt()]);

    // One deletes; the other finds nothing where it expected a Problem. What
    // must not happen is both reporting success, or the second failing with
    // something a caller would read as a conflict to retry.
    expect([first, second].filter((outcome) => outcome === 'DELETED')).toHaveLength(1);
    expect([first, second].filter((outcome) => outcome === 'NOT_FOUND')).toHaveLength(1);

    expect(await countsFor(fixture)).toEqual({
      problems: 0,
      events: 0,
      relations: 0,
      usageLogs: 0,
    });
  });

  it('refuses a stale version without removing anything', async () => {
    const fixture = await seed();
    const runner = createTransactionRunner(pool);

    const outcome = await runner.run((transactional) =>
      deleteProblemAggregate(transactional, fixture.context, fixture.targetId, fixture.version + 1),
    );

    expect(outcome).toBe('VERSION_CONFLICT');
    expect(await countsFor(fixture)).toEqual({
      problems: 1,
      events: 1,
      relations: 1,
      usageLogs: 1,
    });
  });
});
