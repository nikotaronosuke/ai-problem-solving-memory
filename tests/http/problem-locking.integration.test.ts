/**
 * Optimistic locking on a Problem, over a real database.
 *
 * A Problem is a record of what was tried and what was learned, often by more
 * than one person or assistant. Two callers that both read version 4 and both
 * write would leave one of their findings gone with nobody aware of it — which
 * is worse than an error, because it looks like it worked. So every write says
 * which version it is acting on, and one of them is told to look again.
 *
 * The concurrent cases are why the write is a compare-and-swap rather than a
 * check followed by an update. A read-then-write passes every sequential test
 * here and loses all three of the racing ones.
 *
 * Both write paths share one version deliberately, so the third racing test —
 * an ordinary patch against a status transition — is the one that proves they
 * are not two locks that cannot see each other.
 *
 * Fixtures are made and removed here. Nothing depends on the developer's owner
 * or on what a previous run left.
 *
 * Skipped when `DATABASE_URL` is not set.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  createEventService,
  createHealthService,
  createProblemService,
  createProblemStatusService,
  createProjectEnvironmentService,
  createRelationService,
  createUsageLogService,
  createChangeLogService,
  createMemoryControlService,
  createProblemCloseService,
  createRequestContextService,
  createVerificationService,
} from '../../src/app/index.js';
import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { createTransactionRunner } from '../../src/db/transaction.js';
import { generateClientEventId } from '../../src/domain/client-event-id.js';
import { generateOwnerId, type OwnerId } from '../../src/domain/owner.js';
import { generateProblemId } from '../../src/domain/problem.js';
import { buildMemoryHttpApp } from '../../src/http/index.js';
import { MEMORY_OWNER_ID_VAR } from '../../src/owner/context.js';

const databaseUrl = readDatabaseUrl();

interface Actor {
  readonly app: FastifyInstance;
  readonly ownerId: OwnerId;
}

interface Fixture {
  readonly actor: Actor;
  readonly problemId: string;
}

describe.skipIf(databaseUrl === undefined)('Problem optimistic locking', () => {
  let pool: DatabasePool;
  const ownersCreated: OwnerId[] = [];
  const appsCreated: FastifyInstance[] = [];

  async function makeActor(): Promise<Actor> {
    const ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);

    const app = buildMemoryHttpApp({
      healthService: createHealthService(pool),
      requestContextService: createRequestContextService(pool, createTransactionRunner(pool), {
        [MEMORY_OWNER_ID_VAR]: ownerId,
      }),
      projectEnvironmentService: createProjectEnvironmentService(),
      problemService: createProblemService(),
      problemStatusService: createProblemStatusService(),
      eventService: createEventService(),
      verificationService: createVerificationService(),
      relationService: createRelationService(),
      usageLogService: createUsageLogService(),
      changeLogService: createChangeLogService(),
      memoryControlService: createMemoryControlService(),
      problemCloseService: createProblemCloseService(),
      logger: false,
    });
    appsCreated.push(app);

    return { app, ownerId };
  }

  async function makeFixture(existing?: Actor): Promise<Fixture> {
    const actor = existing ?? (await makeActor());

    const project = await actor.app.inject({
      method: 'POST',
      url: '/v1/projects',
      payload: { project_name: 'fixture-project' },
    });
    expect(project.statusCode).toBe(201);
    const projectId = project.json<{ project_id: string }>().project_id;

    const environment = await actor.app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/environments`,
      payload: { snapshot: { runtime: 'node 22.12.0' } },
    });
    expect(environment.statusCode).toBe(201);

    const problem = await actor.app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/problems`,
      payload: {
        environment_id: environment.json<{ environment_id: string }>().environment_id,
        title: 'Sign-in fails after deploying',
        symptoms: 'Works locally, fails on preview.',
      },
    });
    expect(problem.statusCode).toBe(201);
    expect(problem.json<{ version: number }>().version).toBe(1);

    return { actor, problemId: problem.json<{ problem_id: string }>().problem_id };
  }

  /**
   * Patches, supplying `changed_by` unless the caller set it.
   *
   * Every mutation needs one since P2-10, and these tests are about
   * concurrency rather than about who made the change.
   */
  function patch(fixture: Fixture, body: Record<string, unknown>) {
    return fixture.actor.app.inject({
      method: 'PATCH',
      url: `/v1/problems/${fixture.problemId}`,
      payload: { changed_by: 'claude-code', ...body },
    });
  }

  function transition(fixture: Fixture, targetStatus: string, expectedVersion: number) {
    return fixture.actor.app.inject({
      method: 'POST',
      url: `/v1/problems/${fixture.problemId}/status-transitions`,
      payload: {
        target_status: targetStatus,
        expected_version: expectedVersion,
        changed_by: 'claude-code',
      },
    });
  }

  async function readProblem(fixture: Fixture) {
    const response = await fixture.actor.app.inject({
      method: 'GET',
      url: `/v1/problems/${fixture.problemId}`,
    });
    expect(response.statusCode).toBe(200);
    return response.json<Record<string, unknown>>();
  }

  /**
   * Opens the pool's connections before a racing test.
   *
   * The pool creates them lazily, and connecting takes long enough that the
   * first request would finish while the others were still waiting for a
   * socket — which is not a race at all.
   */
  async function warmPool(count = 6) {
    await Promise.all(Array.from({ length: count }, () => pool.query('select 1')));
  }

  beforeAll(() => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
  });

  afterAll(async () => {
    for (const app of appsCreated) {
      await app.close();
    }
    if (ownersCreated.length > 0) {
      // Children first: every foreign key restricts deleting the parent.
      for (const table of [
        'change_logs',
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

  describe('an ordinary update', () => {
    it('moves the version on and returns the new one', async () => {
      const fixture = await makeFixture();

      const response = await patch(fixture, { expected_version: 1, title: 'renamed' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ title: 'renamed', version: 2 });
      expect((await readProblem(fixture))['version']).toBe(2);
    });

    it('refuses a second write from the same version, and changes nothing', async () => {
      const fixture = await makeFixture();
      await patch(fixture, { expected_version: 1, title: 'first' });
      const afterFirst = await readProblem(fixture);

      const stale = await patch(fixture, { expected_version: 1, title: 'second' });

      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({
        error: { code: 'VERSION_CONFLICT', message: 'Problem version conflict.' },
      });
      // Not applied, and not half-applied: the record is byte for byte what
      // the winning write left, `updated_at` included.
      expect(await readProblem(fixture)).toEqual(afterFirst);
    });

    it('lets the caller recover by re-reading', async () => {
      const fixture = await makeFixture();
      await patch(fixture, { expected_version: 1, title: 'first' });
      expect((await patch(fixture, { expected_version: 1, title: 'stale' })).statusCode).toBe(409);

      const latest = await readProblem(fixture);
      const retried = await patch(fixture, {
        expected_version: latest['version'],
        title: 'second',
      });

      // The whole point of the 409: it tells the caller to look again, and
      // looking again is enough.
      expect(retried.statusCode).toBe(200);
      expect(retried.json()).toMatchObject({ title: 'second', version: 3 });
    });

    it('records one of two simultaneous writes and refuses the other', async () => {
      const fixture = await makeFixture();
      await warmPool();

      const [first, second] = await Promise.all([
        patch(fixture, { expected_version: 1, title: 'written by A' }),
        patch(fixture, { expected_version: 1, symptoms: 'written by B' }),
      ]);

      const codes = [first.statusCode, second.statusCode].sort();
      expect(codes).toEqual([200, 409]);

      const winner = first.statusCode === 200 ? first : second;
      const final = await readProblem(fixture);

      // One write, one version. Not two, and no blend of the two payloads —
      // a lost update would show up here as version 2 with both fields
      // changed, or as version 3.
      expect(final['version']).toBe(2);
      expect(final).toEqual(winner.json());
      if (winner === first) {
        expect(final).toMatchObject({ title: 'written by A' });
        expect(final['symptoms']).not.toBe('written by B');
      } else {
        expect(final).toMatchObject({ symptoms: 'written by B' });
        expect(final['title']).not.toBe('written by A');
      }
    });
  });

  describe('a status transition', () => {
    it('moves the version on', async () => {
      const fixture = await makeFixture();

      const response = await transition(fixture, 'FIX_CANDIDATE', 1);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'FIX_CANDIDATE', version: 2 });
    });

    it('refuses one made from a version that has moved on', async () => {
      const fixture = await makeFixture();
      expect((await transition(fixture, 'FIX_CANDIDATE', 1)).statusCode).toBe(200);
      const afterFirst = await readProblem(fixture);

      const stale = await transition(fixture, 'PAUSED', 1);

      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ error: { code: 'VERSION_CONFLICT' } });
      expect(await readProblem(fixture)).toEqual(afterFirst);
      expect(afterFirst).toMatchObject({ status: 'FIX_CANDIDATE', version: 2 });
    });

    it('accepts the same move once the caller has caught up', async () => {
      const fixture = await makeFixture();
      await transition(fixture, 'FIX_CANDIDATE', 1);
      expect((await transition(fixture, 'PAUSED', 1)).statusCode).toBe(409);

      const resumed = await transition(fixture, 'PAUSED', 2);

      expect(resumed.statusCode).toBe(200);
      expect(resumed.json()).toMatchObject({ status: 'PAUSED', version: 3 });
    });

    it('is refused on a stale version even when the move would not be allowed anyway', async () => {
      const fixture = await makeFixture();
      await transition(fixture, 'FIX_CANDIDATE', 1);
      await transition(fixture, 'PAUSED', 2);

      // From PAUSED, VERIFIED is not a legal move — but the caller is working
      // from version 1 and has not seen PAUSED at all. Judging its request
      // against a status it never read would answer a question it did not ask.
      const stale = await transition(fixture, 'VERIFIED', 1);

      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ error: { code: 'VERSION_CONFLICT' } });
    });

    it('lets one of two simultaneous transitions through', async () => {
      const fixture = await makeFixture();
      await warmPool();

      // Both moves are legal from INVESTIGATING, so nothing but the lock can
      // separate them. This is the race P2-06 left open on purpose.
      const [first, second] = await Promise.all([
        transition(fixture, 'FIX_CANDIDATE', 1),
        transition(fixture, 'PAUSED', 1),
      ]);

      expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);

      const winner = first.statusCode === 200 ? first : second;
      const final = await readProblem(fixture);

      expect(final['version']).toBe(2);
      expect(final['status']).toBe(winner.json<{ status: string }>().status);
    });
  });

  describe('the two write paths share one lock', () => {
    it('lets a patch and a transition race, and only one wins', async () => {
      const fixture = await makeFixture();
      await warmPool();

      const [patched, transitioned] = await Promise.all([
        patch(fixture, { expected_version: 1, title: 'edited' }),
        transition(fixture, 'FIX_CANDIDATE', 1),
      ]);

      expect([patched.statusCode, transitioned.statusCode].sort()).toEqual([200, 409]);

      const final = await readProblem(fixture);
      // Two locks that could not see each other would let both through and
      // leave the version at 2 with both changes, or at 3.
      expect(final['version']).toBe(2);
      if (patched.statusCode === 200) {
        expect(final).toMatchObject({ title: 'edited', status: 'INVESTIGATING' });
      } else {
        expect(final).toMatchObject({ status: 'FIX_CANDIDATE' });
        expect(final['title']).not.toBe('edited');
      }
    });

    it('makes a transition invalidate a patch prepared beforehand', async () => {
      const fixture = await makeFixture();
      const read = await readProblem(fixture);

      await transition(fixture, 'FIX_CANDIDATE', read['version'] as number);
      const stale = await patch(fixture, {
        expected_version: read['version'],
        title: 'from before the transition',
      });

      expect(stale.statusCode).toBe(409);
      expect((await readProblem(fixture))['title']).not.toBe('from before the transition');
    });
  });

  describe('verifying, with versions', () => {
    it('runs the whole flow and moves the version only where a write happened', async () => {
      const fixture = await makeFixture();

      const candidate = await transition(fixture, 'FIX_CANDIDATE', 1);
      expect(candidate.json()).toMatchObject({ status: 'FIX_CANDIDATE', version: 2 });

      const verification = await fixture.actor.app.inject({
        method: 'POST',
        url: `/v1/problems/${fixture.problemId}/verifications`,
        payload: {
          verification_type: 'TEST',
          result: true,
          summary: 'Suite green',
          client_event_id: generateClientEventId(),
        },
      });
      expect(verification.statusCode).toBe(201);

      // Recording evidence is not a write to the Problem, so the version has
      // not moved and the transition prepared before it is still valid.
      expect((await readProblem(fixture))['version']).toBe(2);

      const verified = await transition(fixture, 'VERIFIED', 2);
      expect(verified.statusCode).toBe(200);
      expect(verified.json()).toMatchObject({ status: 'VERIFIED', version: 3 });
    });
  });

  describe('appends are not versioned', () => {
    it('records events and verifications whatever version the problem is at', async () => {
      const fixture = await makeFixture();
      await patch(fixture, { expected_version: 1, title: 'one' });
      await patch(fixture, { expected_version: 2, title: 'two' });
      expect((await readProblem(fixture))['version']).toBe(3);

      const event = await fixture.actor.app.inject({
        method: 'POST',
        url: `/v1/problems/${fixture.problemId}/events`,
        payload: {
          event_type: 'ATTEMPT',
          summary: 'Tried something',
          client_event_id: generateClientEventId(),
        },
      });
      const verification = await fixture.actor.app.inject({
        method: 'POST',
        url: `/v1/problems/${fixture.problemId}/verifications`,
        payload: {
          verification_type: 'TEST',
          result: false,
          summary: 'Still failing',
          client_event_id: generateClientEventId(),
        },
      });

      // No expected_version, no check, no increment. Retry safety for an
      // append is `client_event_id`, which is a different problem from two
      // callers overwriting each other's edits.
      expect(event.statusCode).toBe(201);
      expect(verification.statusCode).toBe(201);
      expect((await readProblem(fixture))['version']).toBe(3);
    });

    it.each([
      ['owner_id', 'expected_version'],
      ['event body', 'expected_version'],
    ])('refuses %s carrying %s', async (_label, field) => {
      const fixture = await makeFixture();

      const response = await fixture.actor.app.inject({
        method: 'POST',
        url: `/v1/problems/${fixture.problemId}/events`,
        payload: {
          event_type: 'ATTEMPT',
          summary: 'Tried something',
          client_event_id: generateClientEventId(),
          [field]: 1,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('still appends after a patch was refused as stale', async () => {
      const fixture = await makeFixture();
      await patch(fixture, { expected_version: 1, title: 'first' });

      const stale = await patch(fixture, { expected_version: 1, title: 'stale' });
      expect(stale.statusCode).toBe(409);

      const event = await fixture.actor.app.inject({
        method: 'POST',
        url: `/v1/problems/${fixture.problemId}/events`,
        payload: {
          event_type: 'DEAD_END',
          summary: 'Recording this regardless',
          client_event_id: generateClientEventId(),
        },
      });

      // A conflict on the Problem body must not block recording what was
      // learned. Losing that is the failure the whole record exists to avoid.
      expect(event.statusCode).toBe(201);
    });
  });

  describe('nothing is written when a request is refused', () => {
    it.each([
      ['a patch with only a version', { expected_version: 1 }, 400],
      ['a stale patch', { expected_version: 99, title: 'x' }, 409],
      ['a patch setting status', { expected_version: 1, status: 'VERIFIED' }, 400],
      ['a patch setting version', { expected_version: 1, version: 5 }, 400],
    ])('leaves the record alone for %s', async (_label, body, expected) => {
      const fixture = await makeFixture();
      const before = await readProblem(fixture);

      const response = await patch(fixture, body);

      expect(response.statusCode).toBe(expected);
      expect(await readProblem(fixture)).toEqual(before);
    });

    it.each([
      ['a same-status transition', 'INVESTIGATING', 1, 400],
      ['a disallowed move', 'VERIFIED', 1, 400],
      ['a stale version', 'PAUSED', 99, 409],
    ])('leaves the record alone for %s', async (_label, target, version, expected) => {
      const fixture = await makeFixture();
      const before = await readProblem(fixture);

      const response = await transition(fixture, target, version);

      expect(response.statusCode).toBe(expected);
      expect(await readProblem(fixture)).toEqual(before);
    });
  });

  describe('what one owner can reach of another', () => {
    it('answers not-found rather than conflict for another owner’s problem', async () => {
      const mine = await makeFixture();
      const theirs = await makeFixture();
      const before = await readProblem(theirs);

      // Any version, right or wrong. A 409 would confirm the problem exists
      // and even let someone search for its version.
      const attempts = [
        await mine.actor.app.inject({
          method: 'PATCH',
          url: `/v1/problems/${theirs.problemId}`,
          payload: { changed_by: 'claude-code', expected_version: 1, title: 'stolen' },
        }),
        await mine.actor.app.inject({
          method: 'PATCH',
          url: `/v1/problems/${theirs.problemId}`,
          payload: { changed_by: 'claude-code', expected_version: 99, title: 'stolen' },
        }),
        await mine.actor.app.inject({
          method: 'POST',
          url: `/v1/problems/${theirs.problemId}/status-transitions`,
          payload: { target_status: 'PAUSED', expected_version: 1, changed_by: 'claude-code' },
        }),
      ];

      for (const attempt of attempts) {
        expect(attempt.statusCode).toBe(404);
        expect(attempt.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      }
      expect(await readProblem(theirs)).toEqual(before);
    });

    it('answers the same for another owner’s problem as for one that does not exist', async () => {
      const mine = await makeFixture();
      const theirs = await makeFixture();

      const crossOwner = await mine.actor.app.inject({
        method: 'PATCH',
        url: `/v1/problems/${theirs.problemId}`,
        payload: { changed_by: 'claude-code', expected_version: 1, title: 'x' },
      });
      const unknown = await mine.actor.app.inject({
        method: 'PATCH',
        url: `/v1/problems/${generateProblemId()}`,
        payload: { changed_by: 'claude-code', expected_version: 1, title: 'x' },
      });

      // `request_id` differs per request, so the comparison is of the part
      // that carries meaning.
      expect(crossOwner.statusCode).toBe(unknown.statusCode);
      expect(crossOwner.json<{ error: unknown }>().error).toEqual(
        unknown.json<{ error: unknown }>().error,
      );
    });
  });
});
