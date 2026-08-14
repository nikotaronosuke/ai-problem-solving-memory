/**
 * Change logging over a real database.
 *
 * What matters here is that the history and the change are the same event.
 * A Problem edited with no record of it, or a record of an edit that did not
 * happen, are both worse than the write failing — so every refused mutation
 * must leave nothing behind, and a failure to record must take the change with
 * it.
 *
 * The redaction rule matters just as much. Free text is described rather than
 * copied, so that removing something from a Problem later is not quietly
 * undone by a copy of it in the history. Several tests write deliberately
 * distinctive strings and then assert they appear nowhere.
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
  createMemoryControlService,
  createProblemCloseService,
  createExportService,
  createProblemDeleteService,
  createEventService,
  createHealthService,
  createProblemService,
  createProblemStatusService,
  createProjectEnvironmentService,
  createRelationService,
  createUsageLogService,
  createVerificationService,
  type AuthenticatedRequestContext,
} from '../../src/app/index.js';
import { createFixedRequestContextService } from '../support/request-context.js';
import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { generateClientEventId } from '../../src/domain/client-event-id.js';
import { generateOwnerId, type OwnerId } from '../../src/domain/owner.js';
import { generateProblemId } from '../../src/domain/problem.js';
import { buildMemoryHttpApp } from '../../src/http/index.js';

const databaseUrl = readDatabaseUrl();

/** Text distinctive enough that finding it anywhere is proof of a copy. */
const SECRET_TITLE = 'token-Zx9Q-do-not-copy-this-anywhere';
const SECRET_SYMPTOMS = 'symptom-Kf2W-do-not-copy-this-anywhere';

interface Actor {
  readonly app: FastifyInstance;
  readonly ownerId: OwnerId;
}

describe.skipIf(databaseUrl === undefined)('Problem change logging', () => {
  let pool: DatabasePool;
  const ownersCreated: OwnerId[] = [];
  const appsCreated: FastifyInstance[] = [];

  async function makeActor(): Promise<Actor> {
    const ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);

    const app = buildMemoryHttpApp({
      healthService: createHealthService(pool),
      requestContextService: createFixedRequestContextService(pool, ownerId),
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
      problemDeleteService: createProblemDeleteService(),
      exportService: createExportService(),
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
        title: SECRET_TITLE,
        symptoms: SECRET_SYMPTOMS,
      },
    });
    expect(problem.statusCode).toBe(201);
    return problem.json<{ problem_id: string }>().problem_id;
  }

  function patch(actor: Actor, problemId: string, body: Record<string, unknown>) {
    return actor.app.inject({
      method: 'PATCH',
      url: `/v1/problems/${problemId}`,
      payload: { changed_by: 'claude-code', ...body },
    });
  }

  function transition(
    actor: Actor,
    problemId: string,
    targetStatus: string,
    expectedVersion: number,
    changedBy = 'claude-code',
  ) {
    return actor.app.inject({
      method: 'POST',
      url: `/v1/problems/${problemId}/status-transitions`,
      payload: {
        target_status: targetStatus,
        expected_version: expectedVersion,
        changed_by: changedBy,
      },
    });
  }

  async function listChangeLogs(actor: Actor, problemId: string) {
    const response = await actor.app.inject({
      method: 'GET',
      url: `/v1/problems/${problemId}/change-logs`,
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ change_logs: Record<string, unknown>[] }>().change_logs;
  }

  async function readProblem(actor: Actor, problemId: string) {
    const response = await actor.app.inject({ method: 'GET', url: `/v1/problems/${problemId}` });
    expect(response.statusCode).toBe(200);
    return response.json<Record<string, unknown>>();
  }

  async function countChangeLogs(ownerId: OwnerId): Promise<number> {
    const result = await pool.query<{ count: string }>(
      'select count(*)::text as count from public.change_logs where owner_id = $1',
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

  describe('an ordinary update', () => {
    it('records one entry, bracketing the versions', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      const response = await patch(actor, problem, {
        expected_version: 1,
        confidence: 'HIGH',
      });
      expect(response.statusCode).toBe(200);

      const [entry] = await listChangeLogs(actor, problem);
      expect(entry).toMatchObject({
        owner_id: actor.ownerId,
        problem_id: problem,
        changed_by: 'claude-code',
        from_version: 1,
        to_version: 2,
        changes: { confidence: { kind: 'exact', before: 'LOW', after: 'HIGH' } },
      });
      expect(entry).not.toHaveProperty('updated_at');
      expect(entry).not.toHaveProperty('version');
    });

    it('records one entry however many fields moved', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      await patch(actor, problem, {
        expected_version: 1,
        confidence: 'HIGH',
        freshness: 'SUPERSEDED',
        importance: true,
        suppressed: true,
        memory_read_enabled: false,
      });

      const entries = await listChangeLogs(actor, problem);
      // Five fields, one thing that happened. Splitting it would lose that.
      expect(entries).toHaveLength(1);
      expect(entries[0]?.['changes']).toEqual({
        confidence: { kind: 'exact', before: 'LOW', after: 'HIGH' },
        freshness: { kind: 'exact', before: 'CURRENT', after: 'SUPERSEDED' },
        importance: { kind: 'exact', before: false, after: true },
        suppressed: { kind: 'exact', before: false, after: true },
        memory_read_enabled: { kind: 'exact', before: true, after: false },
      });
    });

    it('names only the fields the patch touched', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      await patch(actor, problem, { expected_version: 1, importance: true });

      // Recording every field on every change would bury the one that moved.
      expect(Object.keys((await listChangeLogs(actor, problem))[0]?.['changes'] ?? {})).toEqual([
        'importance',
      ]);
    });

    it('chains across several changes', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      await patch(actor, problem, { expected_version: 1, importance: true });
      await patch(actor, problem, { expected_version: 2, confidence: 'MEDIUM' });

      const entries = await listChangeLogs(actor, problem);
      expect(entries.map((e) => [e['from_version'], e['to_version']])).toEqual([
        [1, 2],
        [2, 3],
      ]);
    });

    it('says who made each change', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      await patch(actor, problem, { expected_version: 1, importance: true });
      await patch(actor, problem, {
        expected_version: 2,
        changed_by: 'codex',
        confidence: 'MEDIUM',
      });

      expect((await listChangeLogs(actor, problem)).map((e) => e['changed_by'])).toEqual([
        'claude-code',
        'codex',
      ]);
    });

    it('records a same-value write honestly', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      // Writing LOW over LOW is a real thing that happens; the version moves,
      // so an entry is owed, and it should say the value did not.
      const response = await patch(actor, problem, { expected_version: 1, confidence: 'LOW' });
      expect(response.statusCode).toBe(200);

      expect((await listChangeLogs(actor, problem))[0]?.['changes']).toEqual({
        confidence: { kind: 'exact', before: 'LOW', after: 'LOW' },
      });
    });
  });

  describe('a status transition', () => {
    it('records one entry naming the status', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      expect((await transition(actor, problem, 'FIX_CANDIDATE', 1)).statusCode).toBe(200);

      const entries = await listChangeLogs(actor, problem);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        from_version: 1,
        to_version: 2,
        changes: {
          status: { kind: 'exact', before: 'INVESTIGATING', after: 'FIX_CANDIDATE' },
        },
      });
    });

    it('interleaves with ordinary updates in one history', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      await patch(actor, problem, { expected_version: 1, importance: true });
      await transition(actor, problem, 'FIX_CANDIDATE', 2, 'codex');
      await patch(actor, problem, { expected_version: 3, confidence: 'HIGH' });

      const entries = await listChangeLogs(actor, problem);
      expect(entries.map((e) => [e['to_version'], Object.keys(e['changes'] as object)[0]])).toEqual(
        [
          [2, 'importance'],
          [3, 'status'],
          [4, 'confidence'],
        ],
      );
      expect(entries[1]?.['changed_by']).toBe('codex');
    });
  });

  describe('free text is described, never copied', () => {
    it('records that a title changed without recording the title', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      await patch(actor, problem, {
        expected_version: 1,
        title: 'replacement-Yh4M-also-do-not-copy',
      });

      const entries = await listChangeLogs(actor, problem);
      expect(entries[0]?.['changes']).toEqual({
        title: {
          kind: 'text_redacted',
          before_present: true,
          after_present: true,
          changed: true,
        },
      });

      // Neither the old value nor the new one, anywhere in the history —
      // including straight out of the table, past the API.
      const stored = await pool.query<{ changes: unknown }>(
        'select changes from public.change_logs where owner_id = $1',
        [actor.ownerId],
      );
      const raw = JSON.stringify(stored.rows);
      expect(raw).not.toContain(SECRET_TITLE);
      expect(raw).not.toContain('replacement-Yh4M-also-do-not-copy');
    });

    it.each([
      ['problem_domain', 'domain-Pq7T-secret'],
      ['suspected_boundary', 'boundary-Rn3V-secret'],
      ['source_ai', 'source-Wj8L-secret'],
      ['symptoms', 'symptoms-Bd5X-secret'],
    ])('does not copy %s either', async (field, value) => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      await patch(actor, problem, { expected_version: 1, [field]: value });

      const stored = await pool.query<{ changes: unknown }>(
        'select changes from public.change_logs where owner_id = $1',
        [actor.ownerId],
      );
      expect(JSON.stringify(stored.rows)).not.toContain(value);
      expect((await listChangeLogs(actor, problem))[0]?.['changes']).toMatchObject({
        [field]: { kind: 'text_redacted' },
      });
    });

    it('distinguishes clearing a field from replacing it', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      await patch(actor, problem, { expected_version: 1, problem_domain: 'auth' });
      await patch(actor, problem, { expected_version: 2, problem_domain: null });

      const entries = await listChangeLogs(actor, problem);
      expect(entries[0]?.['changes']).toMatchObject({
        problem_domain: { before_present: false, after_present: true, changed: true },
      });
      expect(entries[1]?.['changes']).toMatchObject({
        problem_domain: { before_present: true, after_present: false, changed: true },
      });
    });

    it('says when free text was written over with the same value', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      await patch(actor, problem, { expected_version: 1, title: SECRET_TITLE });

      expect((await listChangeLogs(actor, problem))[0]?.['changes']).toMatchObject({
        title: { changed: false, before_present: true, after_present: true },
      });
    });
  });

  describe('a refused change records nothing', () => {
    it.each([
      ['a stale version', { expected_version: 99, confidence: 'HIGH' }, 409],
      ['a patch with nothing to change', { expected_version: 1 }, 400],
      ['a patch setting status', { expected_version: 1, status: 'VERIFIED' }, 400],
      ['a patch with no changed_by', { expected_version: 1, confidence: 'HIGH' }, 400],
      ['an invalid confidence', { expected_version: 1, confidence: 'CERTAIN' }, 400],
    ])('records nothing for %s', async (_label, body, expected) => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      const before = await readProblem(actor, problem);

      const payload = 'changed_by' in body ? body : { changed_by: 'claude-code', ...body };
      const response = await actor.app.inject({
        method: 'PATCH',
        url: `/v1/problems/${problem}`,
        payload: _label === 'a patch with no changed_by' ? body : payload,
      });

      expect(response.statusCode).toBe(expected);
      expect(await readProblem(actor, problem)).toEqual(before);
      expect(await countChangeLogs(actor.ownerId)).toBe(0);
    });

    it.each([
      ['a stale version', 'PAUSED', 99, 409],
      ['a move to the same status', 'INVESTIGATING', 1, 400],
      ['a disallowed move', 'VERIFIED', 1, 400],
    ])('records nothing for %s', async (_label, target, version, expected) => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      const before = await readProblem(actor, problem);

      expect((await transition(actor, problem, target, version)).statusCode).toBe(expected);

      expect(await readProblem(actor, problem)).toEqual(before);
      expect(await countChangeLogs(actor.ownerId)).toBe(0);
    });

    it('records nothing when VERIFIED is refused for want of evidence', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      await transition(actor, problem, 'FIX_CANDIDATE', 1);
      const afterCandidate = await readProblem(actor, problem);

      const refused = await transition(actor, problem, 'VERIFIED', 2);

      expect(refused.statusCode).toBe(400);
      expect(await readProblem(actor, problem)).toEqual(afterCandidate);
      // The one entry is the successful move to FIX_CANDIDATE, not the
      // refused one.
      const entries = await listChangeLogs(actor, problem);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.['to_version']).toBe(2);
    });

    it('records nothing for a problem that is not the caller’s', async () => {
      const mine = await makeActor();
      const theirs = await makeActor();
      const theirProblem = await makeProblem(theirs);

      const response = await patch(mine, theirProblem, { expected_version: 1, importance: true });

      expect(response.statusCode).toBe(404);
      expect(await countChangeLogs(mine.ownerId)).toBe(0);
      expect(await countChangeLogs(theirs.ownerId)).toBe(0);
    });
  });

  describe('the change and its record are one transaction', () => {
    it('rolls the change back when the record cannot be written', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      const before = await readProblem(actor, problem);

      // A context whose transaction hands the service a repository that
      // refuses to write history. Production code is untouched: the failure
      // is injected at the seam the service already uses.
      const authenticated = await createFixedRequestContextService(
        pool,
        actor.ownerId,
      ).authenticate(undefined);

      const failing: AuthenticatedRequestContext = {
        clientId: authenticated.clientId,
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
        createProblemService().updateProblem(failing, problem, {
          expectedVersion: 1,
          changedBy: 'claude-code',
          confidence: 'HIGH',
        }),
      ).rejects.toThrow('history unavailable');

      // The update itself is gone: version, confidence and updated_at all as
      // they were. A Problem edited with no record of it is exactly what the
      // transaction exists to prevent.
      expect(await readProblem(actor, problem)).toEqual(before);
      expect(await countChangeLogs(actor.ownerId)).toBe(0);
    });

    it('rolls a status transition back the same way', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      const before = await readProblem(actor, problem);

      const authenticated = await createFixedRequestContextService(
        pool,
        actor.ownerId,
      ).authenticate(undefined);

      const failing: AuthenticatedRequestContext = {
        clientId: authenticated.clientId,
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
        createProblemStatusService().transition(failing, problem, {
          targetStatus: 'FIX_CANDIDATE',
          expectedVersion: 1,
          changedBy: 'claude-code',
        }),
      ).rejects.toThrow('history unavailable');

      expect(await readProblem(actor, problem)).toEqual(before);
      expect(await countChangeLogs(actor.ownerId)).toBe(0);
    });
  });

  describe('concurrency', () => {
    async function warmPool(count = 6) {
      await Promise.all(Array.from({ length: count }, () => pool.query('select 1')));
    }

    it('records one entry when two patches race', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      await warmPool();

      const [first, second] = await Promise.all([
        patch(actor, problem, { expected_version: 1, importance: true }),
        patch(actor, problem, { expected_version: 1, confidence: 'HIGH' }),
      ]);

      expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);

      const entries = await listChangeLogs(actor, problem);
      const winner = first.statusCode === 200 ? 'importance' : 'confidence';
      // One winner, one entry, and it describes the winner's change.
      expect(entries).toHaveLength(1);
      expect(Object.keys(entries[0]?.['changes'] as object)).toEqual([winner]);
      expect((await readProblem(actor, problem))['version']).toBe(2);
    });

    it('records one entry when two transitions race', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      await warmPool();

      const [first, second] = await Promise.all([
        transition(actor, problem, 'FIX_CANDIDATE', 1),
        transition(actor, problem, 'PAUSED', 1),
      ]);

      expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);

      const entries = await listChangeLogs(actor, problem);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.['changes']).toMatchObject({
        status: { after: (await readProblem(actor, problem))['status'] },
      });
    });

    it('records one entry when a patch races a transition', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      await warmPool();

      const [patched, transitioned] = await Promise.all([
        patch(actor, problem, { expected_version: 1, importance: true }),
        transition(actor, problem, 'FIX_CANDIDATE', 1),
      ]);

      expect([patched.statusCode, transitioned.statusCode].sort()).toEqual([200, 409]);

      const entries = await listChangeLogs(actor, problem);
      expect(entries).toHaveLength(1);
      expect(Object.keys(entries[0]?.['changes'] as object)).toEqual([
        patched.statusCode === 200 ? 'importance' : 'status',
      ]);
      expect((await readProblem(actor, problem))['version']).toBe(2);
    });
  });

  describe('nothing else is logged', () => {
    it('records nothing for reads, creation, appends or links', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      const other = await makeProblem(actor);

      await readProblem(actor, problem);
      await actor.app.inject({
        method: 'POST',
        url: `/v1/problems/${problem}/events`,
        payload: {
          event_type: 'ATTEMPT',
          summary: 'Tried something',
          client_event_id: generateClientEventId(),
        },
      });
      await actor.app.inject({
        method: 'POST',
        url: `/v1/problems/${problem}/verifications`,
        payload: {
          verification_type: 'TEST',
          result: true,
          summary: 'Suite green',
          client_event_id: generateClientEventId(),
        },
      });
      await actor.app.inject({
        method: 'POST',
        url: `/v1/problems/${problem}/relations`,
        payload: { to_id: other, relation_type: 'SIMILAR_TO', reason: 'Alike' },
      });
      await actor.app.inject({
        method: 'POST',
        url: `/v1/problems/${problem}/usage-logs`,
        payload: {
          source_ai: 'claude-code',
          action: 'REFERENCED',
          memory_id: other,
          reason: 'Read it',
        },
      });

      // Creating the two problems is not logged either: P2-10 tracks the two
      // mutable Problem paths and nothing else.
      expect(await countChangeLogs(actor.ownerId)).toBe(0);
    });

    it('changes nothing about the problem beyond the mutation itself', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      await patch(actor, problem, { expected_version: 1, importance: true });

      const after = await readProblem(actor, problem);
      // Logging is a record, not an actor: it moves no other field, and
      // creates no event, verification or relation of its own.
      expect(after).toMatchObject({
        importance: true,
        status: 'INVESTIGATING',
        confidence: 'LOW',
        freshness: 'CURRENT',
        version: 2,
      });
      const events = await actor.app.inject({
        method: 'GET',
        url: `/v1/problems/${problem}/events`,
      });
      expect(events.json<{ events: unknown[] }>().events).toEqual([]);
    });
  });

  describe('reading a problem’s history', () => {
    it('returns an empty list for a problem that has not changed', async () => {
      const actor = await makeActor();

      expect(await listChangeLogs(actor, await makeProblem(actor))).toEqual([]);
    });

    it('refuses to list the history of an unknown problem', async () => {
      const actor = await makeActor();

      const response = await actor.app.inject({
        method: 'GET',
        url: `/v1/problems/${generateProblemId()}/change-logs`,
      });

      // Not an empty list: that would say "it exists and has never changed".
      expect(response.statusCode).toBe(404);
    });

    it('cannot read another owner’s history', async () => {
      const mine = await makeActor();
      const theirs = await makeActor();
      const theirProblem = await makeProblem(theirs);
      await patch(theirs, theirProblem, { expected_version: 1, importance: true });

      const crossOwner = await mine.app.inject({
        method: 'GET',
        url: `/v1/problems/${theirProblem}/change-logs`,
      });
      const unknown = await mine.app.inject({
        method: 'GET',
        url: `/v1/problems/${generateProblemId()}/change-logs`,
      });

      expect(crossOwner.statusCode).toBe(404);
      expect(crossOwner.json<{ error: unknown }>().error).toEqual(
        unknown.json<{ error: unknown }>().error,
      );
    });

    it('does not let changed_by change which data a caller reaches', async () => {
      const mine = await makeActor();
      const theirs = await makeActor();
      const theirProblem = await makeProblem(theirs);

      // Naming another assistant, or something that looks like an owner id.
      for (const changedBy of ['codex', 'manual', theirs.ownerId, 'root']) {
        const response = await mine.app.inject({
          method: 'PATCH',
          url: `/v1/problems/${theirProblem}`,
          payload: { expected_version: 1, changed_by: changedBy, importance: true },
        });

        expect(response.statusCode).toBe(404);
      }
      expect(await countChangeLogs(mine.ownerId)).toBe(0);
    });
  });
});
