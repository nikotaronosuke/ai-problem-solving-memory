/**
 * Memory controls over a real database.
 *
 * The independence of the axes is what matters most here. "Do not read this
 * automatically", "surface this less" and "this turned out to be wrong" are
 * three different statements, and a retrieval layer will want to act on them
 * differently. Every test that sets one control asserts the other two, and
 * `freshness`, did not move — because the failure mode is not an error, it is
 * a plausible-looking coupling nobody notices until memories start
 * disappearing for the wrong reason.
 *
 * The rest is the shape a Problem write already has: one version, one
 * compare-and-swap, one history entry, refusals that leave nothing behind.
 * These go through the same helper as the ordinary update, and the tests here
 * are what would catch that changing.
 *
 * Fixtures are made and removed here. Nothing depends on the developer's owner
 * or on what a previous run left.
 *
 * Skipped when `DATABASE_URL` is not set.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  createChangeLogService,
  createEventService,
  createHealthService,
  createMemoryControlService,
  createProblemService,
  createProblemStatusService,
  createProjectEnvironmentService,
  createRelationService,
  createRequestContextService,
  createUsageLogService,
  createVerificationService,
  type AuthenticatedRequestContext,
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

describe.skipIf(databaseUrl === undefined)('Memory controls', () => {
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
      logger: false,
    });
    appsCreated.push(app);

    return { app, ownerId };
  }

  async function makeProblem(actor: Actor): Promise<string> {
    const project = await actor.app.inject({
      method: 'POST',
      url: '/v1/projects',
      payload: { project_name: 'fixture-project' },
    });
    const projectId = project.json<{ project_id: string }>().project_id;

    const environment = await actor.app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/environments`,
      payload: { snapshot: { runtime: 'node 22.12.0' } },
    });

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
    return problem.json<{ problem_id: string }>().problem_id;
  }

  function control(actor: Actor, problemId: string, body: Record<string, unknown>) {
    return actor.app.inject({
      method: 'PATCH',
      url: `/v1/problems/${problemId}/memory-control`,
      payload: { changed_by: 'claude-code', ...body },
    });
  }

  async function controlOk(actor: Actor, problemId: string, body: Record<string, unknown>) {
    const response = await control(actor, problemId, body);
    expect(response.statusCode).toBe(200);
    return response.json<Record<string, unknown>>();
  }

  function patch(actor: Actor, problemId: string, body: Record<string, unknown>) {
    return actor.app.inject({
      method: 'PATCH',
      url: `/v1/problems/${problemId}`,
      payload: { changed_by: 'claude-code', ...body },
    });
  }

  async function readProblem(actor: Actor, problemId: string) {
    const response = await actor.app.inject({ method: 'GET', url: `/v1/problems/${problemId}` });
    expect(response.statusCode).toBe(200);
    return response.json<Record<string, unknown>>();
  }

  async function listChangeLogs(actor: Actor, problemId: string) {
    const response = await actor.app.inject({
      method: 'GET',
      url: `/v1/problems/${problemId}/change-logs`,
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ change_logs: Record<string, unknown>[] }>().change_logs;
  }

  /** The four things this surface can touch, for asserting what did not move. */
  function controlState(problem: Record<string, unknown>) {
    return {
      memory_read_enabled: problem['memory_read_enabled'],
      memory_write_enabled: problem['memory_write_enabled'],
      suppressed: problem['suppressed'],
      freshness: problem['freshness'],
    };
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

  describe('each control on its own', () => {
    it('disables and re-enables reading, touching nothing else', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      const disabled = await controlOk(actor, problem, {
        expected_version: 1,
        memory_read_enabled: false,
      });
      expect(controlState(disabled)).toEqual({
        memory_read_enabled: false,
        memory_write_enabled: true,
        suppressed: false,
        freshness: 'CURRENT',
      });

      const enabled = await controlOk(actor, problem, {
        expected_version: 2,
        memory_read_enabled: true,
      });
      expect(controlState(enabled)).toEqual({
        memory_read_enabled: true,
        memory_write_enabled: true,
        suppressed: false,
        freshness: 'CURRENT',
      });
    });

    it('disables and re-enables writing, touching nothing else', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      const disabled = await controlOk(actor, problem, {
        expected_version: 1,
        memory_write_enabled: false,
      });
      expect(controlState(disabled)).toEqual({
        memory_read_enabled: true,
        memory_write_enabled: false,
        suppressed: false,
        freshness: 'CURRENT',
      });

      const enabled = await controlOk(actor, problem, {
        expected_version: 2,
        memory_write_enabled: true,
      });
      expect(controlState(enabled).memory_write_enabled).toBe(true);
    });

    it('suppresses and unsuppresses, touching nothing else', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      const suppressed = await controlOk(actor, problem, {
        expected_version: 1,
        suppressed: true,
      });
      expect(controlState(suppressed)).toEqual({
        memory_read_enabled: true,
        memory_write_enabled: true,
        suppressed: true,
        // Surfacing something less often says nothing about whether it holds.
        freshness: 'CURRENT',
      });

      const unsuppressed = await controlOk(actor, problem, {
        expected_version: 2,
        suppressed: false,
      });
      expect(controlState(unsuppressed).suppressed).toBe(false);
    });

    it('invalidates by setting freshness, and only that', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      const invalidated = await controlOk(actor, problem, {
        expected_version: 1,
        invalidate: true,
      });

      expect(controlState(invalidated)).toEqual({
        // A memory that no longer holds is still readable and still not
        // suppressed: a retrieval layer may want to surface it as a warning
        // rather than hide it.
        memory_read_enabled: true,
        memory_write_enabled: true,
        suppressed: false,
        freshness: 'INVALID',
      });
    });

    it('leaves the rest of the problem alone', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      const before = await readProblem(actor, problem);

      const after = await controlOk(actor, problem, {
        expected_version: 1,
        suppressed: true,
        invalidate: true,
      });

      // Controls are not lifecycle and not judgement.
      expect(after).toMatchObject({
        status: before['status'],
        fix_kind: before['fix_kind'],
        confidence: before['confidence'],
        importance: before['importance'],
        title: before['title'],
        symptoms: before['symptoms'],
        created_at: before['created_at'],
      });
    });
  });

  describe('the axes stay independent', () => {
    it('does not suppress when reading is disabled', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      const after = await controlOk(actor, problem, {
        expected_version: 1,
        memory_read_enabled: false,
      });

      expect(after['suppressed']).toBe(false);
      expect(after['freshness']).toBe('CURRENT');
    });

    it('does not disable reading when suppressed', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      const after = await controlOk(actor, problem, { expected_version: 1, suppressed: true });

      expect(after['memory_read_enabled']).toBe(true);
      expect(after['memory_write_enabled']).toBe(true);
    });

    it('does not suppress or disable when invalidated', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      const after = await controlOk(actor, problem, { expected_version: 1, invalidate: true });

      expect(after['suppressed']).toBe(false);
      expect(after['memory_read_enabled']).toBe(true);
      expect(after['memory_write_enabled']).toBe(true);
    });

    it('does not invalidate when suppressed', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      const after = await controlOk(actor, problem, { expected_version: 1, suppressed: true });

      // Suppression and invalidation are the pair most easily confused, and
      // the specification names keeping them apart as a completion condition.
      expect(after['freshness']).toBe('CURRENT');
    });

    it('does not disable reading when writing is disabled', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      const after = await controlOk(actor, problem, {
        expected_version: 1,
        memory_write_enabled: false,
      });

      expect(after['memory_read_enabled']).toBe(true);
    });

    it.each([
      [
        'readable but not writable, surfaced, still holding',
        { memory_read_enabled: true, memory_write_enabled: false },
        {
          memory_read_enabled: true,
          memory_write_enabled: false,
          suppressed: false,
          freshness: 'CURRENT',
        },
      ],
      [
        'not readable, writable, surfaced, still holding',
        { memory_read_enabled: false, memory_write_enabled: true },
        {
          memory_read_enabled: false,
          memory_write_enabled: true,
          suppressed: false,
          freshness: 'CURRENT',
        },
      ],
      [
        'readable, writable, suppressed, no longer holding',
        { suppressed: true, invalidate: true },
        {
          memory_read_enabled: true,
          memory_write_enabled: true,
          suppressed: true,
          freshness: 'INVALID',
        },
      ],
      [
        'nothing readable or writable, suppressed and invalid',
        {
          memory_read_enabled: false,
          memory_write_enabled: false,
          suppressed: true,
          invalidate: true,
        },
        {
          memory_read_enabled: false,
          memory_write_enabled: false,
          suppressed: true,
          freshness: 'INVALID',
        },
      ],
    ])('can express %s', async (_label, body, expected) => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      const after = await controlOk(actor, problem, { expected_version: 1, ...body });

      expect(controlState(after)).toEqual(expected);
    });

    it('reaches every combination by setting each axis in turn', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      let version = 1;

      // Eight combinations of the three booleans, each set explicitly, with
      // freshness left alone throughout.
      for (const read of [true, false]) {
        for (const write of [true, false]) {
          for (const suppressed of [true, false]) {
            const after = await controlOk(actor, problem, {
              expected_version: version,
              memory_read_enabled: read,
              memory_write_enabled: write,
              suppressed,
            });
            expect(controlState(after)).toEqual({
              memory_read_enabled: read,
              memory_write_enabled: write,
              suppressed,
              freshness: 'CURRENT',
            });
            version = after['version'] as number;
          }
        }
      }
    });
  });

  describe('controls are not authorisation', () => {
    it('leaves every read working when reading is disabled', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      await actor.app.inject({
        method: 'POST',
        url: `/v1/problems/${problem}/events`,
        payload: {
          event_type: 'ATTEMPT',
          summary: 'Tried something',
          client_event_id: generateClientEventId(),
        },
      });

      await controlOk(actor, problem, {
        expected_version: 1,
        memory_read_enabled: false,
        memory_write_enabled: false,
        suppressed: true,
        invalidate: true,
      });

      // Everything the owner can ask about their own Problem still answers.
      // These controls govern automatic use, not access.
      for (const url of [
        `/v1/problems/${problem}`,
        `/v1/problems/${problem}/events`,
        `/v1/problems/${problem}/verifications`,
        `/v1/problems/${problem}/relations`,
        `/v1/problems/${problem}/usage-logs`,
        `/v1/problems/${problem}/change-logs`,
      ]) {
        expect((await actor.app.inject({ method: 'GET', url })).statusCode).toBe(200);
      }
    });

    it('can still be changed back once everything is turned off', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      const off = await controlOk(actor, problem, {
        expected_version: 1,
        memory_read_enabled: false,
        memory_write_enabled: false,
        suppressed: true,
      });

      // A Problem must not be lockable away with no way back.
      const on = await controlOk(actor, problem, {
        expected_version: off['version'],
        memory_read_enabled: true,
        memory_write_enabled: true,
        suppressed: false,
      });
      expect(controlState(on)).toMatchObject({
        memory_read_enabled: true,
        memory_write_enabled: true,
        suppressed: false,
      });
    });

    it('still accepts events and verifications when writing is disabled', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      await controlOk(actor, problem, { expected_version: 1, memory_write_enabled: false });

      // The flag records intent for a layer that can tell an assistant's
      // write from its owner's. Nothing can tell them apart yet, so no
      // endpoint starts refusing on the strength of it.
      const event = await actor.app.inject({
        method: 'POST',
        url: `/v1/problems/${problem}/events`,
        payload: {
          event_type: 'ATTEMPT',
          summary: 'Still recordable',
          client_event_id: generateClientEventId(),
        },
      });
      expect(event.statusCode).toBe(201);
    });
  });

  describe('history', () => {
    it('records one entry naming the fields that moved', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      await controlOk(actor, problem, {
        expected_version: 1,
        changed_by: 'manual',
        memory_read_enabled: false,
        suppressed: true,
      });

      const entries = await listChangeLogs(actor, problem);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        changed_by: 'manual',
        from_version: 1,
        to_version: 2,
        changes: {
          memory_read_enabled: { kind: 'exact', before: true, after: false },
          suppressed: { kind: 'exact', before: false, after: true },
        },
      });
    });

    it('records invalidation as a freshness change, not as a verb', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      await controlOk(actor, problem, { expected_version: 1, invalidate: true });

      const [entry] = await listChangeLogs(actor, problem);
      // `invalidate` is what a caller asked for; `freshness` is what changed,
      // and a reader following the record needs the latter.
      expect(entry?.['changes']).toEqual({
        freshness: { kind: 'exact', before: 'CURRENT', after: 'INVALID' },
      });
      expect(JSON.stringify(entry?.['changes'])).not.toContain('invalidate');
    });

    it('records one entry for several controls at once', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      const after = await controlOk(actor, problem, {
        expected_version: 1,
        memory_read_enabled: false,
        memory_write_enabled: false,
        suppressed: true,
        invalidate: true,
      });

      const entries = await listChangeLogs(actor, problem);
      // One request, one mutation, one entry — and one version step.
      expect(entries).toHaveLength(1);
      expect(after['version']).toBe(2);
      expect(Object.keys(entries[0]?.['changes'] as object).sort()).toEqual([
        'freshness',
        'memory_read_enabled',
        'memory_write_enabled',
        'suppressed',
      ]);
    });

    it('records a same-value control honestly', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      await controlOk(actor, problem, { expected_version: 1, memory_read_enabled: false });

      const again = await controlOk(actor, problem, {
        expected_version: 2,
        memory_read_enabled: false,
      });

      // The version moves, so an entry is owed, and it says the value did not
      // move rather than pretending nothing was asked.
      expect(again['version']).toBe(3);
      const entries = await listChangeLogs(actor, problem);
      expect(entries).toHaveLength(2);
      expect(entries[1]?.['changes']).toEqual({
        memory_read_enabled: { kind: 'exact', before: false, after: false },
      });
    });

    it('records invalidating something already invalid', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      await controlOk(actor, problem, { expected_version: 1, invalidate: true });

      await controlOk(actor, problem, { expected_version: 2, invalidate: true });

      expect((await listChangeLogs(actor, problem))[1]?.['changes']).toEqual({
        freshness: { kind: 'exact', before: 'INVALID', after: 'INVALID' },
      });
    });

    it('interleaves with the ordinary update and the transition in one history', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      await patch(actor, problem, { expected_version: 1, confidence: 'HIGH' });
      await controlOk(actor, problem, { expected_version: 2, suppressed: true });
      await actor.app.inject({
        method: 'POST',
        url: `/v1/problems/${problem}/status-transitions`,
        payload: {
          target_status: 'FIX_CANDIDATE',
          expected_version: 3,
          changed_by: 'claude-code',
        },
      });

      const entries = await listChangeLogs(actor, problem);
      expect(entries.map((e) => Object.keys(e['changes'] as object)[0])).toEqual([
        'confidence',
        'suppressed',
        'status',
      ]);
      expect(entries.map((e) => e['to_version'])).toEqual([2, 3, 4]);
    });

    it('creates no event, verification, relation or usage of its own', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      await controlOk(actor, problem, { expected_version: 1, suppressed: true, invalidate: true });

      for (const [url, key] of [
        [`/v1/problems/${problem}/events`, 'events'],
        [`/v1/problems/${problem}/verifications`, 'verifications'],
        [`/v1/problems/${problem}/relations`, 'relations'],
        [`/v1/problems/${problem}/usage-logs`, 'usage_logs'],
      ] as const) {
        const response = await actor.app.inject({ method: 'GET', url });
        expect(response.json<Record<string, unknown[]>>()[key]).toEqual([]);
      }
    });
  });

  describe('a refused control changes nothing', () => {
    it.each([
      ['a stale version', { expected_version: 99, suppressed: true }, 409],
      ['no controls at all', { expected_version: 1 }, 400],
      ['invalidate: false', { expected_version: 1, invalidate: false }, 400],
      ['freshness directly', { expected_version: 1, freshness: 'CURRENT' }, 400],
      ['a non-boolean control', { expected_version: 1, suppressed: 'yes' }, 400],
      ['a lifecycle field', { expected_version: 1, status: 'PAUSED' }, 400],
    ])('records nothing for %s', async (_label, body, expected) => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      const before = await readProblem(actor, problem);

      const response = await control(actor, problem, body);

      expect(response.statusCode).toBe(expected);
      expect(await readProblem(actor, problem)).toEqual(before);
      expect(await listChangeLogs(actor, problem)).toEqual([]);
    });

    it('records nothing when changed_by is missing', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      const before = await readProblem(actor, problem);

      const response = await actor.app.inject({
        method: 'PATCH',
        url: `/v1/problems/${problem}/memory-control`,
        payload: { expected_version: 1, suppressed: true },
      });

      expect(response.statusCode).toBe(400);
      expect(await readProblem(actor, problem)).toEqual(before);
      expect(await listChangeLogs(actor, problem)).toEqual([]);
    });

    it('lets the caller recover from a conflict by re-reading', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      await controlOk(actor, problem, { expected_version: 1, suppressed: true });

      expect(
        (await control(actor, problem, { expected_version: 1, suppressed: false })).statusCode,
      ).toBe(409);

      const latest = await readProblem(actor, problem);
      const retried = await controlOk(actor, problem, {
        expected_version: latest['version'],
        suppressed: false,
      });
      expect(retried['suppressed']).toBe(false);
    });
  });

  describe('one lock across every write path', () => {
    async function warmPool(count = 6) {
      await Promise.all(Array.from({ length: count }, () => pool.query('select 1')));
    }

    it('lets one of two simultaneous control changes through', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      await warmPool();

      const [first, second] = await Promise.all([
        control(actor, problem, { expected_version: 1, memory_read_enabled: false }),
        control(actor, problem, { expected_version: 1, suppressed: true }),
      ]);

      expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);

      const final = await readProblem(actor, problem);
      expect(final['version']).toBe(2);
      expect(await listChangeLogs(actor, problem)).toHaveLength(1);
      if (first.statusCode === 200) {
        expect(controlState(final)).toMatchObject({
          memory_read_enabled: false,
          suppressed: false,
        });
      } else {
        expect(controlState(final)).toMatchObject({ memory_read_enabled: true, suppressed: true });
      }
    });

    it('lets a control change race the ordinary update', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      await warmPool();

      const [controlled, patched] = await Promise.all([
        control(actor, problem, { expected_version: 1, memory_read_enabled: false }),
        patch(actor, problem, { expected_version: 1, confidence: 'HIGH' }),
      ]);

      expect([controlled.statusCode, patched.statusCode].sort()).toEqual([200, 409]);

      const final = await readProblem(actor, problem);
      // One version column across every write path, so these conflict rather
      // than passing each other unnoticed.
      expect(final['version']).toBe(2);
      expect(await listChangeLogs(actor, problem)).toHaveLength(1);
    });

    it('lets a control change race a status transition', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      await warmPool();

      const [controlled, transitioned] = await Promise.all([
        control(actor, problem, { expected_version: 1, suppressed: true }),
        actor.app.inject({
          method: 'POST',
          url: `/v1/problems/${problem}/status-transitions`,
          payload: {
            target_status: 'FIX_CANDIDATE',
            expected_version: 1,
            changed_by: 'claude-code',
          },
        }),
      ]);

      expect([controlled.statusCode, transitioned.statusCode].sort()).toEqual([200, 409]);
      expect((await readProblem(actor, problem))['version']).toBe(2);
      expect(await listChangeLogs(actor, problem)).toHaveLength(1);
    });
  });

  describe('the change and its record are one transaction', () => {
    it('rolls the control change back when the record cannot be written', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      const before = await readProblem(actor, problem);

      const authenticated = await createRequestContextService(pool, createTransactionRunner(pool), {
        [MEMORY_OWNER_ID_VAR]: actor.ownerId,
      }).authenticate();

      const failing: AuthenticatedRequestContext = {
        repository: authenticated.repository,
        runInTransaction: (work) =>
          authenticated.runInTransaction((repository) =>
            work({
              ...repository,
              createChangeLog: () => Promise.reject(new Error('history unavailable')),
            }),
          ),
      };

      await expect(
        createMemoryControlService().updateControls(failing, problem, {
          expectedVersion: 1,
          changedBy: 'claude-code',
          suppressed: true,
        }),
      ).rejects.toThrow('history unavailable');

      expect(await readProblem(actor, problem)).toEqual(before);
      expect(await listChangeLogs(actor, problem)).toEqual([]);
    });
  });

  describe('what one owner can reach of another', () => {
    it('refuses another owner’s problem whatever version is named', async () => {
      const mine = await makeActor();
      const theirs = await makeActor();
      const theirProblem = await makeProblem(theirs);
      const before = await readProblem(theirs, theirProblem);

      for (const expectedVersion of [1, 99]) {
        const response = await control(mine, theirProblem, {
          expected_version: expectedVersion,
          suppressed: true,
        });

        // 404 either way: a 409 would confirm the problem exists and let
        // someone search for its version.
        expect(response.statusCode).toBe(404);
        expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      }
      expect(await readProblem(theirs, theirProblem)).toEqual(before);
    });

    it('answers the same for another owner’s problem as for one that does not exist', async () => {
      const mine = await makeActor();
      const theirs = await makeActor();
      const theirProblem = await makeProblem(theirs);

      const crossOwner = await control(mine, theirProblem, {
        expected_version: 1,
        suppressed: true,
      });
      const unknown = await control(mine, generateProblemId(), {
        expected_version: 1,
        suppressed: true,
      });

      expect(crossOwner.statusCode).toBe(unknown.statusCode);
      expect(crossOwner.json<{ error: unknown }>().error).toEqual(
        unknown.json<{ error: unknown }>().error,
      );
    });

    it('does not let changed_by change which data a caller reaches', async () => {
      const mine = await makeActor();
      const theirs = await makeActor();
      const theirProblem = await makeProblem(theirs);

      for (const changedBy of ['root', 'admin', theirs.ownerId, 'codex']) {
        const response = await control(mine, theirProblem, {
          expected_version: 1,
          changed_by: changedBy,
          suppressed: true,
        });

        expect(response.statusCode).toBe(404);
      }
    });

    it('cannot read another owner’s controls', async () => {
      const mine = await makeActor();
      const theirs = await makeActor();
      const theirProblem = await makeProblem(theirs);
      await controlOk(theirs, theirProblem, { expected_version: 1, suppressed: true });

      const response = await mine.app.inject({
        method: 'GET',
        url: `/v1/problems/${theirProblem}`,
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('the ordinary update still handles these fields', () => {
    it('sets the controls and freshness as it did before', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      const patched = await patch(actor, problem, {
        expected_version: 1,
        memory_read_enabled: false,
        memory_write_enabled: false,
        suppressed: true,
        freshness: 'STALE_UNKNOWN',
      });

      // Nothing was taken away from the generic patch to make room for the
      // control surface: clients written against it keep working.
      expect(patched.statusCode).toBe(200);
      expect(controlState(patched.json<Record<string, unknown>>())).toEqual({
        memory_read_enabled: false,
        memory_write_enabled: false,
        suppressed: true,
        freshness: 'STALE_UNKNOWN',
      });
    });

    it('is how a memory is said to hold again', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      await controlOk(actor, problem, { expected_version: 1, invalidate: true });

      // The control surface cannot un-invalidate, because it could not know
      // which freshness to restore. Saying it holds again means saying which.
      const revalidated = await patch(actor, problem, {
        expected_version: 2,
        freshness: 'CURRENT',
      });

      expect(revalidated.statusCode).toBe(200);
      expect(revalidated.json<{ freshness: string }>().freshness).toBe('CURRENT');
    });
  });
});
