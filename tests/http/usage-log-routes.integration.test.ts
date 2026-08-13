/**
 * UsageLog endpoints over a real database.
 *
 * Two owners per run, driven entirely through HTTP. Four things matter here.
 *
 * That memory may be used across projects — a problem solved in one project
 * informing an investigation in another is the reason any of this is kept.
 *
 * That it may not be used across owners, and that refusing it reveals nothing:
 * both the problem being worked on and the memory are checked, and another
 * owner's is indistinguishable from one that does not exist.
 *
 * That `source_ai` is a description and not a credential. Whatever a caller
 * writes there, it reaches exactly the same data.
 *
 * And that logging is something a caller does, not something a read does.
 * Fetching a Problem or listing its Events, Verifications or Relations writes
 * nothing here.
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
  createRequestContextService,
  createUsageLogService,
  createChangeLogService,
  createVerificationService,
} from '../../src/app/index.js';
import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { createTransactionRunner } from '../../src/db/transaction.js';
import { generateClientEventId } from '../../src/domain/client-event-id.js';
import { USAGE_ACTIONS } from '../../src/domain/enums.js';
import { generateOwnerId, type OwnerId } from '../../src/domain/owner.js';
import { generateProblemId } from '../../src/domain/problem.js';
import { buildMemoryHttpApp } from '../../src/http/index.js';
import { MEMORY_OWNER_ID_VAR } from '../../src/owner/context.js';

const databaseUrl = readDatabaseUrl();

interface Actor {
  readonly app: FastifyInstance;
  readonly ownerId: OwnerId;
}

describe.skipIf(databaseUrl === undefined)('UsageLog API', () => {
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
      logger: false,
    });
    appsCreated.push(app);

    return { app, ownerId };
  }

  /** A problem, in a project of the given name so cross-project cases are clear. */
  async function makeProblem(actor: Actor, projectName = 'fixture-project'): Promise<string> {
    const project = await actor.app.inject({
      method: 'POST',
      url: '/v1/projects',
      payload: { project_name: projectName },
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
        title: `Problem in ${projectName}`,
        symptoms: 'Fixture symptoms',
      },
    });
    expect(problem.statusCode).toBe(201);
    return problem.json<{ problem_id: string }>().problem_id;
  }

  function log(actor: Actor, problemId: string, body: Record<string, unknown>) {
    return actor.app.inject({
      method: 'POST',
      url: `/v1/problems/${problemId}/usage-logs`,
      payload: body,
    });
  }

  async function logOk(
    actor: Actor,
    problemId: string,
    memoryId: string,
    overrides: Record<string, unknown> = {},
  ) {
    const response = await log(actor, problemId, {
      source_ai: 'claude-code',
      action: 'REFERENCED',
      memory_id: memoryId,
      reason: 'Fixture reason',
      ...overrides,
    });
    expect(response.statusCode).toBe(201);
    return response.json<Record<string, unknown>>();
  }

  async function listUsageLogs(actor: Actor, problemId: string) {
    const response = await actor.app.inject({
      method: 'GET',
      url: `/v1/problems/${problemId}/usage-logs`,
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ usage_logs: Record<string, unknown>[] }>().usage_logs;
  }

  async function readProblem(actor: Actor, problemId: string) {
    const response = await actor.app.inject({ method: 'GET', url: `/v1/problems/${problemId}` });
    expect(response.statusCode).toBe(200);
    return response.json<Record<string, unknown>>();
  }

  async function countUsageLogs(ownerId: OwnerId): Promise<number> {
    const result = await pool.query<{ count: string }>(
      'select count(*)::text as count from public.usage_logs where owner_id = $1',
      [ownerId],
    );
    return Number(result.rows[0]?.count ?? '0');
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

  describe('recording that memory was used', () => {
    it('records the entry with the id and time the server decides', async () => {
      const actor = await makeActor();
      const current = await makeProblem(actor);
      const memory = await makeProblem(actor);

      const entry = await logOk(actor, current, memory);

      expect(entry).toMatchObject({
        owner_id: actor.ownerId,
        problem_id: current,
        memory_id: memory,
        source_ai: 'claude-code',
        action: 'REFERENCED',
        reason: 'Fixture reason',
        result: null,
      });
      expect(typeof entry['usage_log_id']).toBe('string');
      expect(entry).not.toHaveProperty('updated_at');
      expect(entry).not.toHaveProperty('version');
    });

    it('trims the text it stores', async () => {
      const actor = await makeActor();
      const current = await makeProblem(actor);
      const memory = await makeProblem(actor);

      const entry = await logOk(actor, current, memory, {
        source_ai: '  claude-code  ',
        reason: '  Same auth boundary.  ',
        result: '  It worked.  ',
        action: 'ADOPTED',
      });

      expect(entry).toMatchObject({
        source_ai: 'claude-code',
        reason: 'Same auth boundary.',
        result: 'It worked.',
      });
    });

    it.each(USAGE_ACTIONS)('records a %s entry without any prior step', async (action) => {
      const actor = await makeActor();
      const current = await makeProblem(actor);
      const memory = await makeProblem(actor);

      const entry = await logOk(actor, current, memory, { action });

      // Straight to any action, with nothing logged before it. An adapter
      // reports what it can tell.
      expect(entry).toMatchObject({ action, problem_id: current, memory_id: memory });
      expect(await listUsageLogs(actor, current)).toHaveLength(1);
    });

    it('records memory used from a different project', async () => {
      const actor = await makeActor();
      const current = await makeProblem(actor, 'admin-console');
      const memory = await makeProblem(actor, 'checkout-web');

      const entry = await logOk(actor, current, memory, {
        action: 'ADOPTED',
        reason: 'Same session handling, solved in the other project.',
        result: 'Fixed the same way.',
      });

      expect(entry).toMatchObject({ problem_id: current, memory_id: memory });
      expect(await listUsageLogs(actor, current)).toHaveLength(1);
    });

    it('lets a problem be recorded as its own memory', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      const entry = await logOk(actor, problem, problem, {
        source_ai: 'codex',
        reason: 'Picked this up from another assistant and read its history.',
      });

      // Continuing the same investigation under a different AI is real, so
      // there is no self-reference check.
      expect(entry).toMatchObject({ problem_id: problem, memory_id: problem });
    });
  });

  describe('reading a problem’s usage', () => {
    it('lists oldest first', async () => {
      const actor = await makeActor();
      const current = await makeProblem(actor);
      const memory = await makeProblem(actor);
      const reasons = ['found it', 'read it', 'took it'];

      for (const reason of reasons) {
        await logOk(actor, current, memory, { reason });
      }

      expect((await listUsageLogs(actor, current)).map((l) => l['reason'])).toEqual(reasons);
    });

    it('is scoped to the problem being worked on, not to the memory', async () => {
      const actor = await makeActor();
      const current = await makeProblem(actor);
      const memory = await makeProblem(actor);

      await logOk(actor, current, memory, { action: 'ADOPTED' });

      // "What did this investigation draw on?" is the question this answers.
      expect(await listUsageLogs(actor, current)).toHaveLength(1);
      expect(await listUsageLogs(actor, memory)).toEqual([]);
    });

    it('returns an empty list for a problem with no usage', async () => {
      const actor = await makeActor();

      expect(await listUsageLogs(actor, await makeProblem(actor))).toEqual([]);
    });

    it('refuses to list the usage of an unknown problem', async () => {
      const actor = await makeActor();

      const response = await actor.app.inject({
        method: 'GET',
        url: `/v1/problems/${generateProblemId()}/usage-logs`,
      });

      // Not an empty list: that would say "it exists and has none".
      expect(response.statusCode).toBe(404);
    });

    it('refuses to record against an unknown problem', async () => {
      const actor = await makeActor();
      const memory = await makeProblem(actor);

      const response = await log(actor, generateProblemId(), {
        source_ai: 'claude-code',
        action: 'SEARCHED',
        memory_id: memory,
        reason: 'Should not land',
      });

      expect(response.statusCode).toBe(404);
      expect(await countUsageLogs(actor.ownerId)).toBe(0);
    });

    it('refuses an unknown memory', async () => {
      const actor = await makeActor();
      const current = await makeProblem(actor);

      const response = await log(actor, current, {
        source_ai: 'claude-code',
        action: 'SEARCHED',
        memory_id: generateProblemId(),
        reason: 'Should not land',
      });

      expect(response.statusCode).toBe(404);
      expect(await countUsageLogs(actor.ownerId)).toBe(0);
    });
  });

  describe('what one owner can reach of another', () => {
    it('refuses another owner’s problem as the memory, revealing nothing about it', async () => {
      const mine = await makeActor();
      const theirs = await makeActor();
      const myProblem = await makeProblem(mine);
      const theirProblem = await makeProblem(theirs, 'their-secret-project');

      const response = await log(mine, myProblem, {
        source_ai: 'claude-code',
        action: 'ADOPTED',
        memory_id: theirProblem,
        reason: 'Should not land',
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      expect(response.body).not.toContain('their-secret-project');
      expect(response.body).not.toContain('Problem in');
      expect(await countUsageLogs(mine.ownerId)).toBe(0);
      expect(await countUsageLogs(theirs.ownerId)).toBe(0);
    });

    it('refuses another owner’s problem as the one being worked on', async () => {
      const mine = await makeActor();
      const theirs = await makeActor();
      const myProblem = await makeProblem(mine);
      const theirProblem = await makeProblem(theirs);

      const response = await log(mine, theirProblem, {
        source_ai: 'claude-code',
        action: 'REFERENCED',
        memory_id: myProblem,
        reason: 'Should not land',
      });

      expect(response.statusCode).toBe(404);
      expect(await countUsageLogs(mine.ownerId)).toBe(0);
    });

    it('answers the same for another owner’s memory as for one that does not exist', async () => {
      const mine = await makeActor();
      const theirs = await makeActor();
      const myProblem = await makeProblem(mine);
      const theirProblem = await makeProblem(theirs);

      const crossOwner = await log(mine, myProblem, {
        source_ai: 'claude-code',
        action: 'SEARCHED',
        memory_id: theirProblem,
        reason: 'r',
      });
      const unknown = await log(mine, myProblem, {
        source_ai: 'claude-code',
        action: 'SEARCHED',
        memory_id: generateProblemId(),
        reason: 'r',
      });

      // `request_id` differs per request, so the comparison is of the part
      // that carries meaning.
      expect(crossOwner.statusCode).toBe(unknown.statusCode);
      expect(crossOwner.json<{ error: unknown }>().error).toEqual(
        unknown.json<{ error: unknown }>().error,
      );
    });

    it('cannot read another owner’s usage', async () => {
      const mine = await makeActor();
      const theirs = await makeActor();
      const theirCurrent = await makeProblem(theirs);
      await logOk(theirs, theirCurrent, await makeProblem(theirs));

      const response = await mine.app.inject({
        method: 'GET',
        url: `/v1/problems/${theirCurrent}/usage-logs`,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    });

    it('does not let source_ai change which data a caller reaches', async () => {
      const mine = await makeActor();
      const theirs = await makeActor();
      const myProblem = await makeProblem(mine);
      const theirProblem = await makeProblem(theirs);

      // Naming another assistant, a person, or something that looks like an
      // owner id. `source_ai` is descriptive; the owner comes from the
      // established context and from nowhere else.
      for (const sourceAi of ['codex', 'manual', theirs.ownerId, 'root']) {
        const response = await log(mine, myProblem, {
          source_ai: sourceAi,
          action: 'REFERENCED',
          memory_id: theirProblem,
          reason: 'Should not land',
        });

        expect(response.statusCode).toBe(404);
      }
      expect(await countUsageLogs(mine.ownerId)).toBe(0);
    });
  });

  describe('logging is something a caller does, not something a read does', () => {
    it('writes nothing when memory is merely read', async () => {
      const actor = await makeActor();
      const current = await makeProblem(actor);
      const memory = await makeProblem(actor);
      await actor.app.inject({
        method: 'POST',
        url: `/v1/problems/${memory}/events`,
        payload: {
          event_type: 'FIX',
          summary: 'Set SameSite=Lax on the session cookie.',
          client_event_id: generateClientEventId(),
        },
      });

      // Everything a caller might do while consulting a memory.
      await readProblem(actor, memory);
      await actor.app.inject({ method: 'GET', url: `/v1/problems/${memory}/events` });
      await actor.app.inject({ method: 'GET', url: `/v1/problems/${memory}/verifications` });
      await actor.app.inject({ method: 'GET', url: `/v1/problems/${memory}/relations` });
      await listUsageLogs(actor, current);

      // A read that quietly writes can fail for reasons the caller did not
      // ask about — and it would claim the memory was *used* when all that
      // happened was a look.
      expect(await countUsageLogs(actor.ownerId)).toBe(0);
    });

    it('records only what the caller said it did', async () => {
      const actor = await makeActor();
      const current = await makeProblem(actor);
      const memory = await makeProblem(actor);

      await readProblem(actor, memory);
      await logOk(actor, current, memory, { action: 'EXCLUDED', reason: 'Different platform.' });

      const entries = await listUsageLogs(actor, current);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ action: 'EXCLUDED' });
    });
  });

  describe('using memory changes nothing about it', () => {
    it('leaves both problems exactly as they were', async () => {
      const actor = await makeActor();
      const current = await makeProblem(actor);
      const memory = await makeProblem(actor);
      const currentBefore = await readProblem(actor, current);
      const memoryBefore = await readProblem(actor, memory);

      await logOk(actor, current, memory, { action: 'ADOPTED', result: 'It worked.' });

      // No version moved, no status changed, no `updated_at` advanced.
      expect(await readProblem(actor, current)).toEqual(currentBefore);
      expect(await readProblem(actor, memory)).toEqual(memoryBefore);
    });

    it('does not let adopting a verified memory verify the current problem', async () => {
      const actor = await makeActor();
      const current = await makeProblem(actor);
      const memory = await makeProblem(actor);

      // Verify the memory, properly.
      expect(
        (
          await actor.app.inject({
            method: 'POST',
            url: `/v1/problems/${memory}/status-transitions`,
            payload: {
              target_status: 'FIX_CANDIDATE',
              expected_version: 1,
              changed_by: 'claude-code',
            },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await actor.app.inject({
            method: 'POST',
            url: `/v1/problems/${memory}/verifications`,
            payload: {
              verification_type: 'TEST',
              result: true,
              summary: 'Suite green',
              client_event_id: generateClientEventId(),
            },
          })
        ).statusCode,
      ).toBe(201);
      expect(
        (
          await actor.app.inject({
            method: 'POST',
            url: `/v1/problems/${memory}/status-transitions`,
            payload: { target_status: 'VERIFIED', expected_version: 2, changed_by: 'claude-code' },
          })
        ).statusCode,
      ).toBe(200);

      await logOk(actor, current, memory, {
        action: 'ADOPTED',
        reason: 'Took the same fix.',
        result: 'Applied it.',
      });

      expect(
        (
          await actor.app.inject({
            method: 'POST',
            url: `/v1/problems/${current}/status-transitions`,
            payload: {
              target_status: 'FIX_CANDIDATE',
              expected_version: 1,
              changed_by: 'claude-code',
            },
          })
        ).statusCode,
      ).toBe(200);
      const attempt = await actor.app.inject({
        method: 'POST',
        url: `/v1/problems/${current}/status-transitions`,
        payload: { target_status: 'VERIFIED', expected_version: 2, changed_by: 'claude-code' },
      });

      // Memory is a candidate, not an answer. Having adopted something that
      // was checked is not the same as having checked this.
      expect(attempt.statusCode).toBe(400);
      expect((await readProblem(actor, current))['status']).toBe('FIX_CANDIDATE');
    });

    it('creates no relation, event or verification of its own', async () => {
      const actor = await makeActor();
      const current = await makeProblem(actor);
      const memory = await makeProblem(actor);

      await logOk(actor, current, memory, { action: 'ADOPTED' });

      const relations = await actor.app.inject({
        method: 'GET',
        url: `/v1/problems/${current}/relations`,
      });
      const events = await actor.app.inject({
        method: 'GET',
        url: `/v1/problems/${current}/events`,
      });
      const verifications = await actor.app.inject({
        method: 'GET',
        url: `/v1/problems/${current}/verifications`,
      });

      // Using a memory and stating that two problems are related are
      // different claims, and only the caller can make the second.
      expect(relations.json<{ relations: unknown[] }>().relations).toEqual([]);
      expect(events.json<{ events: unknown[] }>().events).toEqual([]);
      expect(verifications.json<{ verifications: unknown[] }>().verifications).toEqual([]);
    });

    it('does not copy confidence or freshness from the memory', async () => {
      const actor = await makeActor();
      const current = await makeProblem(actor);
      const memory = await makeProblem(actor);
      expect(
        (
          await actor.app.inject({
            method: 'PATCH',
            url: `/v1/problems/${memory}`,
            payload: {
              changed_by: 'claude-code',
              expected_version: 1,
              confidence: 'HIGH',
              freshness: 'SUPERSEDED',
            },
          })
        ).statusCode,
      ).toBe(200);

      await logOk(actor, current, memory, { action: 'ADOPTED' });

      expect(await readProblem(actor, current)).toMatchObject({
        confidence: 'LOW',
        freshness: 'CURRENT',
      });
    });
  });
});
