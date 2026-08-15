/**
 * Closing a Problem, over a real database.
 *
 * Three things carry the weight here.
 *
 * That closing does not become a way around the rules: the same transition
 * matrix applies, and `VERIFIED` still needs a successful Verification of the
 * Problem's own. A high-level surface that quietly relaxed either would be
 * worse than not having one.
 *
 * That the whole conclusion is one act. Status and fix kind move together in
 * one version step, the review becomes Events, and a history entry records it
 * — all committed together, or none of it. A Problem marked verified with the
 * account of why it was verified missing is the worst available outcome.
 *
 * And that nothing is inferred. Concluding does not raise confidence, refresh
 * freshness, touch the memory controls, or invent the evidence it requires.
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
  createProblemCloseService,
  createExportService,
  createProblemDeleteService,
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

/** Distinctive enough that finding it in the history proves a copy. */
const FINAL_CAUSE = 'cause-Qv7X-the-registered-redirect-never-matched';
const EFFECTIVE_DIRECTION = 'direction-Lm2P-align-the-registered-redirect';
const DEAD_END = 'deadend-Tr8K-changing-the-app-route-alone-did-nothing';
const UNRESOLVED = 'open-Nw5J-why-preview-differs-from-production';

interface Actor {
  readonly app: FastifyInstance;
  readonly ownerId: OwnerId;
}

describe.skipIf(databaseUrl === undefined)('Closing a problem', () => {
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
        title: 'Sign-in fails after deploying',
        symptoms: 'Works locally, fails on preview.',
      },
    });
    expect(problem.statusCode).toBe(201);
    return problem.json<{ problem_id: string }>().problem_id;
  }

  function close(actor: Actor, problemId: string, body: Record<string, unknown>) {
    return actor.app.inject({
      method: 'POST',
      url: `/v1/problems/${problemId}/close`,
      payload: { changed_by: 'claude-code', ...body },
    });
  }

  async function closeOk(actor: Actor, problemId: string, body: Record<string, unknown>) {
    const response = await close(actor, problemId, body);
    expect(response.statusCode).toBe(200);
    return response.json<Record<string, unknown>>();
  }

  function transition(actor: Actor, problemId: string, target: string, version: number) {
    return actor.app.inject({
      method: 'POST',
      url: `/v1/problems/${problemId}/status-transitions`,
      payload: { target_status: target, expected_version: version, changed_by: 'claude-code' },
    });
  }

  async function verify(actor: Actor, problemId: string, result: boolean) {
    const response = await actor.app.inject({
      method: 'POST',
      url: `/v1/problems/${problemId}/verifications`,
      payload: {
        verification_type: 'TEST',
        result,
        summary: result ? 'Suite green' : 'Still failing',
        client_event_id: generateClientEventId(),
      },
    });
    expect(response.statusCode).toBe(201);
  }

  async function readProblem(actor: Actor, problemId: string) {
    const response = await actor.app.inject({ method: 'GET', url: `/v1/problems/${problemId}` });
    expect(response.statusCode).toBe(200);
    return response.json<Record<string, unknown>>();
  }

  async function listEvents(actor: Actor, problemId: string) {
    const response = await actor.app.inject({
      method: 'GET',
      url: `/v1/problems/${problemId}/events`,
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ events: Record<string, unknown>[] }>().events;
  }

  async function listChangeLogs(actor: Actor, problemId: string) {
    const response = await actor.app.inject({
      method: 'GET',
      url: `/v1/problems/${problemId}/change-logs`,
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ change_logs: Record<string, unknown>[] }>().change_logs;
  }

  /** A problem at FIX_CANDIDATE with a successful check, ready to verify. */
  async function makeVerifiable(actor: Actor): Promise<string> {
    const problem = await makeProblem(actor);
    expect((await transition(actor, problem, 'FIX_CANDIDATE', 1)).statusCode).toBe(200);
    await verify(actor, problem, true);
    return problem;
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

  describe('concluding', () => {
    it.each(['PAUSED', 'CLOSED_UNRESOLVED'])(
      'takes an investigating problem to %s',
      async (target) => {
        const actor = await makeActor();
        const problem = await makeProblem(actor);

        const closed = await closeOk(actor, problem, {
          expected_version: 1,
          target_status: target,
        });

        expect(closed).toMatchObject({ status: target, version: 2 });
      },
    );

    it('verifies a candidate fix that has a successful check', async () => {
      const actor = await makeActor();
      const problem = await makeVerifiable(actor);

      const closed = await closeOk(actor, problem, {
        expected_version: 2,
        target_status: 'VERIFIED',
        fix_kind: 'ROOT_FIX',
        final_cause_summary: FINAL_CAUSE,
      });

      expect(closed).toMatchObject({ status: 'VERIFIED', fix_kind: 'ROOT_FIX', version: 3 });
    });

    it('moves the version once however much it records', async () => {
      const actor = await makeActor();
      const problem = await makeVerifiable(actor);

      const closed = await closeOk(actor, problem, {
        expected_version: 2,
        target_status: 'VERIFIED',
        fix_kind: 'WORKAROUND',
        final_cause_summary: FINAL_CAUSE,
        effective_direction: EFFECTIVE_DIRECTION,
        dead_end_summary: DEAD_END,
        unresolved_points: UNRESOLVED,
      });

      // Status, fix kind and four events: one act, one version step.
      expect(closed['version']).toBe(3);
      expect(await listChangeLogs(actor, problem)).toHaveLength(2);
    });

    it('closes with nothing to add', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      await closeOk(actor, problem, { expected_version: 1, target_status: 'CLOSED_UNRESOLVED' });

      // The event history may already say everything worth saying.
      expect(await listEvents(actor, problem)).toEqual([]);
    });
  });

  describe('the transition rules still hold', () => {
    it('refuses to verify without a successful check of the problem’s own', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      await transition(actor, problem, 'FIX_CANDIDATE', 1);
      const before = await readProblem(actor, problem);

      const refused = await close(actor, problem, {
        expected_version: 2,
        target_status: 'VERIFIED',
        final_cause_summary: FINAL_CAUSE,
        effective_direction: EFFECTIVE_DIRECTION,
      });

      // A well-argued review is not evidence. Closing records a conclusion;
      // it does not substitute for having earned one.
      expect(refused.statusCode).toBe(400);
      expect(await readProblem(actor, problem)).toEqual(before);
      expect(await listEvents(actor, problem)).toEqual([]);
    });

    it('refuses to verify when every check failed', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      await transition(actor, problem, 'FIX_CANDIDATE', 1);
      await verify(actor, problem, false);

      expect(
        (await close(actor, problem, { expected_version: 2, target_status: 'VERIFIED' }))
          .statusCode,
      ).toBe(400);
    });

    it('refuses to verify straight from investigating, however good the evidence', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      await verify(actor, problem, true);

      // The matrix says VERIFIED comes only from FIX_CANDIDATE, and closing
      // does not get its own matrix.
      expect(
        (await close(actor, problem, { expected_version: 1, target_status: 'VERIFIED' }))
          .statusCode,
      ).toBe(400);
    });

    it('refuses to verify straight from paused', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      await verify(actor, problem, true);
      await closeOk(actor, problem, { expected_version: 1, target_status: 'PAUSED' });

      expect(
        (await close(actor, problem, { expected_version: 2, target_status: 'VERIFIED' }))
          .statusCode,
      ).toBe(400);
    });

    it('refuses a move to the status the problem is already in', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      await closeOk(actor, problem, { expected_version: 1, target_status: 'PAUSED' });

      expect(
        (await close(actor, problem, { expected_version: 2, target_status: 'PAUSED' })).statusCode,
      ).toBe(400);
    });

    it.each(['PAUSED', 'CLOSED_UNRESOLVED'])(
      'refuses to re-close a verified problem as %s',
      async (target) => {
        const actor = await makeActor();
        const problem = await makeVerifiable(actor);
        await closeOk(actor, problem, {
          expected_version: 2,
          target_status: 'VERIFIED',
          fix_kind: 'ROOT_FIX',
        });
        const before = await readProblem(actor, problem);

        const refused = await close(actor, problem, { expected_version: 3, target_status: target });

        // Terminal is terminal. Closing must not become a back door for
        // rewriting a conclusion, fix kind included.
        expect(refused.statusCode).toBe(400);
        expect(await readProblem(actor, problem)).toEqual(before);
      },
    );

    it('refuses to re-close a problem closed as unresolved', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      await closeOk(actor, problem, {
        expected_version: 1,
        target_status: 'CLOSED_UNRESOLVED',
        fix_kind: 'WORKAROUND',
      });
      const before = await readProblem(actor, problem);

      const refused = await close(actor, problem, {
        expected_version: 2,
        target_status: 'PAUSED',
        fix_kind: 'ROOT_FIX',
      });

      expect(refused.statusCode).toBe(400);
      expect(await readProblem(actor, problem)).toEqual(before);
    });

    it('lets a paused problem be resumed through the transition route', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      await closeOk(actor, problem, { expected_version: 1, target_status: 'PAUSED' });

      const resumed = await transition(actor, problem, 'INVESTIGATING', 2);

      // Pausing is setting aside, not ending; the review stays as history.
      expect(resumed.statusCode).toBe(200);
      expect(resumed.json<{ status: string }>().status).toBe('INVESTIGATING');
    });

    it('lets a resumed problem be closed again later', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      await closeOk(actor, problem, {
        expected_version: 1,
        target_status: 'PAUSED',
        unresolved_points: UNRESOLVED,
      });
      await transition(actor, problem, 'INVESTIGATING', 2);

      const closedAgain = await closeOk(actor, problem, {
        expected_version: 3,
        target_status: 'CLOSED_UNRESOLVED',
      });

      expect(closedAgain['status']).toBe('CLOSED_UNRESOLVED');
      // Both reviews remain: the earlier one is not rewritten.
      expect(await listEvents(actor, problem)).toHaveLength(1);
    });
  });

  describe('fix kind', () => {
    it.each(['ROOT_FIX', 'WORKAROUND'])('records %s', async (fixKind) => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      const closed = await closeOk(actor, problem, {
        expected_version: 1,
        target_status: 'CLOSED_UNRESOLVED',
        fix_kind: fixKind,
      });

      expect(closed['fix_kind']).toBe(fixKind);
    });

    it('clears it when null is sent', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      await closeOk(actor, problem, {
        expected_version: 1,
        target_status: 'PAUSED',
        fix_kind: 'WORKAROUND',
      });
      await transition(actor, problem, 'INVESTIGATING', 2);

      const cleared = await closeOk(actor, problem, {
        expected_version: 3,
        target_status: 'CLOSED_UNRESOLVED',
        fix_kind: null,
      });

      expect(cleared['fix_kind']).toBeNull();
    });

    it('leaves it alone when it is not mentioned', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      await closeOk(actor, problem, {
        expected_version: 1,
        target_status: 'PAUSED',
        fix_kind: 'ROOT_FIX',
      });
      await transition(actor, problem, 'INVESTIGATING', 2);

      const closed = await closeOk(actor, problem, {
        expected_version: 3,
        target_status: 'CLOSED_UNRESOLVED',
      });

      // Absent means "leave it", which is not the same as clearing it.
      expect(closed['fix_kind']).toBe('ROOT_FIX');
    });

    it('is independent of the status', async () => {
      const actor = await makeActor();

      // Verified with nothing said about the fix kind.
      const verified = await makeVerifiable(actor);
      const verifiedClosed = await closeOk(actor, verified, {
        expected_version: 2,
        target_status: 'VERIFIED',
      });
      expect(verifiedClosed).toMatchObject({ status: 'VERIFIED', fix_kind: null });

      // A workaround recorded on a problem that was only set aside.
      const paused = await makeProblem(actor);
      const pausedClosed = await closeOk(actor, paused, {
        expected_version: 1,
        target_status: 'PAUSED',
        fix_kind: 'WORKAROUND',
      });
      expect(pausedClosed).toMatchObject({ status: 'PAUSED', fix_kind: 'WORKAROUND' });

      // And a root fix on one closed unresolved: the axes do not imply each
      // other in either direction.
      const unresolved = await makeProblem(actor);
      const unresolvedClosed = await closeOk(actor, unresolved, {
        expected_version: 1,
        target_status: 'CLOSED_UNRESOLVED',
        fix_kind: 'ROOT_FIX',
      });
      expect(unresolvedClosed).toMatchObject({
        status: 'CLOSED_UNRESOLVED',
        fix_kind: 'ROOT_FIX',
      });
    });
  });

  describe('the review becomes events', () => {
    it.each([
      ['final_cause_summary', 'DISCOVERY', FINAL_CAUSE],
      ['effective_direction', 'FIX', EFFECTIVE_DIRECTION],
      ['dead_end_summary', 'DEAD_END', DEAD_END],
      ['unresolved_points', 'HYPOTHESIS', UNRESOLVED],
    ])('records %s as a %s event', async (field, eventType, text) => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      await closeOk(actor, problem, {
        expected_version: 1,
        target_status: 'CLOSED_UNRESOLVED',
        changed_by: 'codex',
        [field]: text,
      });

      const events = await listEvents(actor, problem);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event_type: eventType,
        summary: text,
        // Whoever concluded the problem is who recorded these.
        source_ai: 'codex',
        result: null,
        reason: null,
        evidence_ref: null,
      });
    });

    it('records four summaries as four events sharing one moment', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      await closeOk(actor, problem, {
        expected_version: 1,
        target_status: 'CLOSED_UNRESOLVED',
        final_cause_summary: FINAL_CAUSE,
        effective_direction: EFFECTIVE_DIRECTION,
        dead_end_summary: DEAD_END,
        unresolved_points: UNRESOLVED,
      });

      const events = await listEvents(actor, problem);
      // Relative order among them is not asserted, and deliberately so. They
      // are written in one transaction, so `created_at` — the transaction's
      // time — is the same for all four, and the list's tiebreaker is the
      // identifier. Each carries its own type, so a reader never needs the
      // order to know which statement is which.
      const byType = new Map(events.map((e) => [String(e['event_type']), e['summary']]));
      expect(byType).toEqual(
        new Map([
          ['DISCOVERY', FINAL_CAUSE],
          ['FIX', EFFECTIVE_DIRECTION],
          ['DEAD_END', DEAD_END],
          ['HYPOTHESIS', UNRESOLVED],
        ]),
      );
      expect(new Set(events.map((e) => e['created_at'])).size).toBe(1);
    });

    it('adds them after whatever the investigation already recorded', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      await actor.app.inject({
        method: 'POST',
        url: `/v1/problems/${problem}/events`,
        payload: {
          event_type: 'ATTEMPT',
          summary: 'Tried something first',
          client_event_id: generateClientEventId(),
        },
      });

      await closeOk(actor, problem, {
        expected_version: 1,
        target_status: 'PAUSED',
        final_cause_summary: FINAL_CAUSE,
      });

      // Ordinary events in the ordinary list; nothing separates a review one.
      expect((await listEvents(actor, problem)).map((e) => e['event_type'])).toEqual([
        'ATTEMPT',
        'DISCOVERY',
      ]);
    });

    it('gives each review event its own identity', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      await closeOk(actor, problem, {
        expected_version: 1,
        target_status: 'PAUSED',
        final_cause_summary: FINAL_CAUSE,
        effective_direction: EFFECTIVE_DIRECTION,
      });

      const events = await listEvents(actor, problem);
      expect(new Set(events.map((e) => e['event_id'])).size).toBe(2);
      expect(new Set(events.map((e) => e['client_event_id'])).size).toBe(2);
    });
  });

  describe('history', () => {
    it('records one entry naming the status', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      await closeOk(actor, problem, {
        expected_version: 1,
        changed_by: 'manual',
        target_status: 'CLOSED_UNRESOLVED',
      });

      const entries = await listChangeLogs(actor, problem);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        changed_by: 'manual',
        from_version: 1,
        to_version: 2,
        changes: {
          status: { kind: 'exact', before: 'INVESTIGATING', after: 'CLOSED_UNRESOLVED' },
        },
      });
    });

    it('names the fix kind when the close said something about it', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      await closeOk(actor, problem, {
        expected_version: 1,
        target_status: 'PAUSED',
        fix_kind: 'ROOT_FIX',
      });

      expect((await listChangeLogs(actor, problem))[0]?.['changes']).toEqual({
        status: { kind: 'exact', before: 'INVESTIGATING', after: 'PAUSED' },
        fix_kind: { kind: 'exact', before: null, after: 'ROOT_FIX' },
      });
    });

    it('leaves the fix kind out when the close did not mention it', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      await closeOk(actor, problem, { expected_version: 1, target_status: 'PAUSED' });

      // An untouched field is not reported as a change.
      expect(Object.keys((await listChangeLogs(actor, problem))[0]?.['changes'] ?? {})).toEqual([
        'status',
      ]);
    });

    it('records a same-value fix kind honestly', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      await closeOk(actor, problem, {
        expected_version: 1,
        target_status: 'PAUSED',
        fix_kind: 'ROOT_FIX',
      });
      await transition(actor, problem, 'INVESTIGATING', 2);

      await closeOk(actor, problem, {
        expected_version: 3,
        target_status: 'CLOSED_UNRESOLVED',
        fix_kind: 'ROOT_FIX',
      });

      expect((await listChangeLogs(actor, problem))[2]?.['changes']).toMatchObject({
        fix_kind: { kind: 'exact', before: 'ROOT_FIX', after: 'ROOT_FIX' },
      });
    });

    it('keeps the review text out of the history', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      await closeOk(actor, problem, {
        expected_version: 1,
        target_status: 'CLOSED_UNRESOLVED',
        final_cause_summary: FINAL_CAUSE,
        effective_direction: EFFECTIVE_DIRECTION,
        dead_end_summary: DEAD_END,
        unresolved_points: UNRESOLVED,
      });

      // The Events are where that text lives. A copy in the history would
      // outlive any later removal, which is what the redaction rule prevents.
      const stored = await pool.query<{ changes: unknown }>(
        'select changes from public.change_logs where owner_id = $1',
        [actor.ownerId],
      );
      const raw = JSON.stringify(stored.rows);
      for (const text of [FINAL_CAUSE, EFFECTIVE_DIRECTION, DEAD_END, UNRESOLVED]) {
        expect(raw).not.toContain(text);
      }
    });
  });

  describe('nothing is inferred', () => {
    it('leaves confidence, freshness and the controls alone', async () => {
      const actor = await makeActor();
      const problem = await makeVerifiable(actor);
      const before = await readProblem(actor, problem);

      const closed = await closeOk(actor, problem, {
        expected_version: 2,
        target_status: 'VERIFIED',
        fix_kind: 'ROOT_FIX',
        final_cause_summary: FINAL_CAUSE,
      });

      // Verified says the fix holds. It does not say anyone is more confident
      // in the record, or that it should be surfaced differently.
      expect(closed).toMatchObject({
        confidence: before['confidence'],
        freshness: before['freshness'],
        importance: before['importance'],
        memory_read_enabled: before['memory_read_enabled'],
        memory_write_enabled: before['memory_write_enabled'],
        suppressed: before['suppressed'],
        title: before['title'],
        symptoms: before['symptoms'],
        created_at: before['created_at'],
      });
    });

    it('creates no verification of its own', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      await closeOk(actor, problem, {
        expected_version: 1,
        target_status: 'CLOSED_UNRESOLVED',
        final_cause_summary: FINAL_CAUSE,
        effective_direction: EFFECTIVE_DIRECTION,
      });

      // A convincing account is not a check that was carried out.
      const verifications = await actor.app.inject({
        method: 'GET',
        url: `/v1/problems/${problem}/verifications`,
      });
      expect(verifications.json<{ verifications: unknown[] }>().verifications).toEqual([]);
    });

    it('creates no relation or usage record', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      await closeOk(actor, problem, { expected_version: 1, target_status: 'PAUSED' });

      for (const [url, key] of [
        [`/v1/problems/${problem}/relations`, 'relations'],
        [`/v1/problems/${problem}/usage-logs`, 'usage_logs'],
      ] as const) {
        const response = await actor.app.inject({ method: 'GET', url });
        expect(response.json<Record<string, unknown[]>>()[key]).toEqual([]);
      }
    });
  });

  describe('a refused close leaves nothing behind', () => {
    it.each([
      ['a stale version', { expected_version: 99, target_status: 'PAUSED' }, 409],
      ['a working status', { expected_version: 1, target_status: 'FIX_CANDIDATE' }, 400],
      ['a blank signature', { expected_version: 1, target_status: 'PAUSED', changed_by: ' ' }, 400],
      [
        'a summary that says nothing',
        { expected_version: 1, target_status: 'PAUSED', final_cause_summary: '  ' },
        400,
      ],
    ])('writes nothing for %s', async (_label, body, expected) => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      const before = await readProblem(actor, problem);

      const response = await close(actor, problem, body);

      expect(response.statusCode).toBe(expected);
      expect(await readProblem(actor, problem)).toEqual(before);
      expect(await listEvents(actor, problem)).toEqual([]);
      expect(await listChangeLogs(actor, problem)).toEqual([]);
    });

    it('writes no events when the conclusion itself is refused', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      await transition(actor, problem, 'FIX_CANDIDATE', 1);

      const refused = await close(actor, problem, {
        expected_version: 2,
        target_status: 'VERIFIED',
        final_cause_summary: FINAL_CAUSE,
        effective_direction: EFFECTIVE_DIRECTION,
        dead_end_summary: DEAD_END,
        unresolved_points: UNRESOLVED,
      });

      // The evidence gate fires after the summaries are prepared, so this is
      // exactly where a half-written review would show up.
      expect(refused.statusCode).toBe(400);
      expect(await listEvents(actor, problem)).toEqual([]);
    });

    it('refuses a resend of a close that already succeeded', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      await closeOk(actor, problem, {
        expected_version: 1,
        target_status: 'PAUSED',
        final_cause_summary: FINAL_CAUSE,
      });

      const resent = await close(actor, problem, {
        expected_version: 1,
        target_status: 'PAUSED',
        final_cause_summary: FINAL_CAUSE,
      });

      // The version already moved, so the second attempt conflicts rather
      // than duplicating the review.
      expect(resent.statusCode).toBe(409);
      expect(await listEvents(actor, problem)).toHaveLength(1);
      expect(await listChangeLogs(actor, problem)).toHaveLength(1);
    });
  });

  describe('the whole close is one transaction', () => {
    function failingContext(
      authenticated: AuthenticatedRequestContext,
      failOn: 'appendEvent' | 'createChangeLog',
    ): AuthenticatedRequestContext {
      return {
        clientId: authenticated.clientId,
        retrievalArtifacts:
          undefined as unknown as AuthenticatedRequestContext['retrievalArtifacts'],
        repository: authenticated.repository,
        runInTransaction: (work) =>
          authenticated.runInTransaction((repository) =>
            work({
              ...repository,
              [failOn]: () => Promise.reject(new Error(`${failOn} unavailable`)),
            }),
          ),
      };
    }

    async function authenticate(actor: Actor): Promise<AuthenticatedRequestContext> {
      return createFixedRequestContextService(pool, actor.ownerId).authenticate(undefined);
    }

    it('rolls the conclusion back when a review event cannot be written', async () => {
      const actor = await makeActor();
      const problem = await makeVerifiable(actor);
      const before = await readProblem(actor, problem);

      await expect(
        createProblemCloseService().closeProblem(
          failingContext(await authenticate(actor), 'appendEvent'),
          problem,
          {
            expectedVersion: 2,
            changedBy: 'claude-code',
            targetStatus: 'VERIFIED',
            fixKind: 'ROOT_FIX',
            finalCauseSummary: FINAL_CAUSE,
          },
        ),
      ).rejects.toThrow('appendEvent unavailable');

      // A problem marked verified with the account of why missing is the
      // worst available outcome, so neither happens.
      expect(await readProblem(actor, problem)).toEqual(before);
      expect(await listEvents(actor, problem)).toEqual([]);
      expect(await listChangeLogs(actor, problem)).toHaveLength(1);
    });

    it('rolls the conclusion and the review back when the history cannot be written', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      const before = await readProblem(actor, problem);

      await expect(
        createProblemCloseService().closeProblem(
          failingContext(await authenticate(actor), 'createChangeLog'),
          problem,
          {
            expectedVersion: 1,
            changedBy: 'claude-code',
            targetStatus: 'CLOSED_UNRESOLVED',
            finalCauseSummary: FINAL_CAUSE,
            effectiveDirection: EFFECTIVE_DIRECTION,
          },
        ),
      ).rejects.toThrow('createChangeLog unavailable');

      expect(await readProblem(actor, problem)).toEqual(before);
      expect(await listEvents(actor, problem)).toEqual([]);
      expect(await listChangeLogs(actor, problem)).toEqual([]);
    });
  });

  describe('one lock across every write path', () => {
    async function warmPool(count = 6) {
      await Promise.all(Array.from({ length: count }, () => pool.query('select 1')));
    }

    it('lets one of two simultaneous closes through', async () => {
      const actor = await makeActor();
      const problem = await makeVerifiable(actor);
      await warmPool();

      // Both legal from FIX_CANDIDATE, and a successful check exists, so
      // nothing but the lock separates them.
      const [verified, paused] = await Promise.all([
        close(actor, problem, {
          expected_version: 2,
          target_status: 'VERIFIED',
          final_cause_summary: FINAL_CAUSE,
        }),
        close(actor, problem, {
          expected_version: 2,
          target_status: 'PAUSED',
          dead_end_summary: DEAD_END,
        }),
      ]);

      expect([verified.statusCode, paused.statusCode].sort()).toEqual([200, 409]);

      const final = await readProblem(actor, problem);
      expect(final['version']).toBe(3);
      // The loser's review is not left behind either.
      const events = await listEvents(actor, problem);
      expect(events).toHaveLength(1);
      expect(events[0]?.['summary']).toBe(verified.statusCode === 200 ? FINAL_CAUSE : DEAD_END);
      // One entry for the transition to FIX_CANDIDATE, one for the winner.
      expect(await listChangeLogs(actor, problem)).toHaveLength(2);
    });

    it('lets a close race the ordinary update', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      await warmPool();

      const [closed, patched] = await Promise.all([
        close(actor, problem, {
          expected_version: 1,
          target_status: 'PAUSED',
          final_cause_summary: FINAL_CAUSE,
        }),
        actor.app.inject({
          method: 'PATCH',
          url: `/v1/problems/${problem}`,
          payload: { expected_version: 1, changed_by: 'claude-code', confidence: 'HIGH' },
        }),
      ]);

      expect([closed.statusCode, patched.statusCode].sort()).toEqual([200, 409]);
      expect((await readProblem(actor, problem))['version']).toBe(2);
      expect(await listChangeLogs(actor, problem)).toHaveLength(1);
      expect(await listEvents(actor, problem)).toHaveLength(closed.statusCode === 200 ? 1 : 0);
    });

    it('lets a close race a status transition', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      await warmPool();

      const [closed, transitioned] = await Promise.all([
        close(actor, problem, { expected_version: 1, target_status: 'CLOSED_UNRESOLVED' }),
        transition(actor, problem, 'FIX_CANDIDATE', 1),
      ]);

      expect([closed.statusCode, transitioned.statusCode].sort()).toEqual([200, 409]);
      expect((await readProblem(actor, problem))['version']).toBe(2);
      expect(await listChangeLogs(actor, problem)).toHaveLength(1);
    });

    it('lets a close race a memory control change', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);
      await warmPool();

      const [closed, controlled] = await Promise.all([
        close(actor, problem, { expected_version: 1, target_status: 'PAUSED' }),
        actor.app.inject({
          method: 'PATCH',
          url: `/v1/problems/${problem}/memory-control`,
          payload: { expected_version: 1, changed_by: 'claude-code', suppressed: true },
        }),
      ]);

      expect([closed.statusCode, controlled.statusCode].sort()).toEqual([200, 409]);
      expect((await readProblem(actor, problem))['version']).toBe(2);
      expect(await listChangeLogs(actor, problem)).toHaveLength(1);
    });
  });

  describe('what one owner can reach of another', () => {
    it('refuses another owner’s problem whatever version is named', async () => {
      const mine = await makeActor();
      const theirs = await makeActor();
      const theirProblem = await makeProblem(theirs);
      const before = await readProblem(theirs, theirProblem);

      for (const expectedVersion of [1, 99]) {
        const response = await close(mine, theirProblem, {
          expected_version: expectedVersion,
          target_status: 'PAUSED',
          final_cause_summary: FINAL_CAUSE,
        });

        expect(response.statusCode).toBe(404);
      }
      // Nothing touched, and no review event attached to their problem.
      expect(await readProblem(theirs, theirProblem)).toEqual(before);
      expect(await listEvents(theirs, theirProblem)).toEqual([]);
    });

    it('answers the same for another owner’s problem as for one that does not exist', async () => {
      const mine = await makeActor();
      const theirs = await makeActor();
      const theirProblem = await makeProblem(theirs);

      const crossOwner = await close(mine, theirProblem, {
        expected_version: 1,
        target_status: 'PAUSED',
      });
      const unknown = await close(mine, generateProblemId(), {
        expected_version: 1,
        target_status: 'PAUSED',
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
        const response = await close(mine, theirProblem, {
          expected_version: 1,
          changed_by: changedBy,
          target_status: 'PAUSED',
        });

        expect(response.statusCode).toBe(404);
      }
    });
  });
});
