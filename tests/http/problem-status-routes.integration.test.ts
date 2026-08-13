/**
 * Status transitions over a real database.
 *
 * Two owners per run, driven entirely through HTTP. The rule itself is tested
 * as a function in `tests/domain/problem-status.test.ts`; what matters here is
 * everything the rule cannot see for itself — that the evidence it is told
 * about really is this Problem's own, that a refusal leaves the record exactly
 * as it was, and that a transition moves the status and nothing else.
 *
 * The evidence question is the one worth stating plainly. `VERIFIED` requires
 * a Verification on this Problem whose boolean result is true. Not a FIX
 * event, not a confident-sounding summary, and not another Problem's check —
 * including the case where a replayed `client_event_id` returned that other
 * Problem's Verification, which leaves no row here at all.
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
  createVerificationService,
} from '../../src/app/index.js';
import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
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

describe.skipIf(databaseUrl === undefined)('Problem status transitions', () => {
  let pool: DatabasePool;
  const ownersCreated: OwnerId[] = [];
  const appsCreated: FastifyInstance[] = [];

  async function makeActor(): Promise<Actor> {
    const ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);

    const app = buildMemoryHttpApp({
      healthService: createHealthService(pool),
      requestContextService: createRequestContextService(pool, { [MEMORY_OWNER_ID_VAR]: ownerId }),
      projectEnvironmentService: createProjectEnvironmentService(),
      problemService: createProblemService(),
      problemStatusService: createProblemStatusService(),
      eventService: createEventService(),
      verificationService: createVerificationService(),
      relationService: createRelationService(),
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

    return { actor, problemId: problem.json<{ problem_id: string }>().problem_id };
  }

  function transitionAt(fixture: Fixture, targetStatus: string, expectedVersion: number) {
    return fixture.actor.app.inject({
      method: 'POST',
      url: `/v1/problems/${fixture.problemId}/status-transitions`,
      payload: { target_status: targetStatus, expected_version: expectedVersion },
    });
  }

  /**
   * Transitions using whatever version the problem is at now.
   *
   * Most tests here are about the rule rather than about concurrency, so they
   * read the current version first. The locking tests name a version
   * deliberately, with `transitionAt`.
   */
  async function transition(fixture: Fixture, targetStatus: string) {
    const current = await readProblem(fixture);
    return transitionAt(fixture, targetStatus, current['version'] as number);
  }

  async function transitionOk(fixture: Fixture, targetStatus: string) {
    const response = await transition(fixture, targetStatus);
    expect(response.statusCode).toBe(200);
    return response.json<Record<string, unknown>>();
  }

  async function readProblem(fixture: Fixture) {
    const response = await fixture.actor.app.inject({
      method: 'GET',
      url: `/v1/problems/${fixture.problemId}`,
    });
    expect(response.statusCode).toBe(200);
    return response.json<Record<string, unknown>>();
  }

  /** Records a check against this problem, passing or failing. */
  async function verify(fixture: Fixture, result: boolean, clientEventId?: string) {
    const response = await fixture.actor.app.inject({
      method: 'POST',
      url: `/v1/problems/${fixture.problemId}/verifications`,
      payload: {
        verification_type: 'TEST',
        result,
        summary: result ? 'Suite green' : 'The suite still fails',
        client_event_id: clientEventId ?? generateClientEventId(),
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json<Record<string, unknown>>();
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

  describe('moving through the statuses', () => {
    it.each(['FIX_CANDIDATE', 'PAUSED', 'CLOSED_UNRESOLVED'])(
      'takes an investigating problem to %s',
      async (target) => {
        const fixture = await makeFixture();

        const moved = await transitionOk(fixture, target);

        expect(moved['status']).toBe(target);
        expect((await readProblem(fixture))['status']).toBe(target);
      },
    );

    it.each(['INVESTIGATING', 'PAUSED', 'CLOSED_UNRESOLVED'])(
      'takes a candidate fix to %s',
      async (target) => {
        const fixture = await makeFixture();
        await transitionOk(fixture, 'FIX_CANDIDATE');

        const moved = await transitionOk(fixture, target);

        expect(moved['status']).toBe(target);
      },
    );

    it.each(['INVESTIGATING', 'FIX_CANDIDATE', 'CLOSED_UNRESOLVED'])(
      'resumes a paused problem as %s',
      async (target) => {
        const fixture = await makeFixture();
        await transitionOk(fixture, 'PAUSED');

        const moved = await transitionOk(fixture, target);

        // Setting work aside and picking it up again is the ordinary case.
        expect(moved['status']).toBe(target);
      },
    );

    it('runs a whole investigation from start to verified', async () => {
      const fixture = await makeFixture();

      expect((await readProblem(fixture))['status']).toBe('INVESTIGATING');
      await transitionOk(fixture, 'PAUSED');
      await transitionOk(fixture, 'INVESTIGATING');
      await transitionOk(fixture, 'FIX_CANDIDATE');
      await verify(fixture, true);
      const verified = await transitionOk(fixture, 'VERIFIED');

      expect(verified['status']).toBe('VERIFIED');
    });
  });

  describe('verifying a problem', () => {
    it('refuses when nothing has been checked', async () => {
      const fixture = await makeFixture();
      await transitionOk(fixture, 'FIX_CANDIDATE');

      const response = await transition(fixture, 'VERIFIED');

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
      expect((await readProblem(fixture))['status']).toBe('FIX_CANDIDATE');
    });

    it('refuses when every check failed', async () => {
      const fixture = await makeFixture();
      await transitionOk(fixture, 'FIX_CANDIDATE');
      await verify(fixture, false);
      await verify(fixture, false);

      const response = await transition(fixture, 'VERIFIED');

      // A failed check is evidence, but not evidence of this.
      expect(response.statusCode).toBe(400);
      expect((await readProblem(fixture))['status']).toBe('FIX_CANDIDATE');
    });

    it('allows it once one check passed, even alongside failures', async () => {
      const fixture = await makeFixture();
      await transitionOk(fixture, 'FIX_CANDIDATE');
      await verify(fixture, false);
      await verify(fixture, true);
      await verify(fixture, false);

      const moved = await transitionOk(fixture, 'VERIFIED');

      expect(moved['status']).toBe('VERIFIED');
    });

    it('is not reachable straight from investigating, however good the evidence', async () => {
      const fixture = await makeFixture();
      await verify(fixture, true);

      const response = await transition(fixture, 'VERIFIED');

      // "We think this is the fix" and "we checked, and it holds" are two
      // steps. A problem nobody has proposed a fix for cannot be confirmed.
      expect(response.statusCode).toBe(400);
      expect((await readProblem(fixture))['status']).toBe('INVESTIGATING');
    });

    it('is not reachable straight from paused either', async () => {
      const fixture = await makeFixture();
      await verify(fixture, true);
      await transitionOk(fixture, 'PAUSED');

      const response = await transition(fixture, 'VERIFIED');

      expect(response.statusCode).toBe(400);
      expect((await readProblem(fixture))['status']).toBe('PAUSED');
    });

    it('does not accept a FIX event as evidence', async () => {
      const fixture = await makeFixture();
      await transitionOk(fixture, 'FIX_CANDIDATE');
      const event = await fixture.actor.app.inject({
        method: 'POST',
        url: `/v1/problems/${fixture.problemId}/events`,
        payload: {
          event_type: 'FIX',
          summary: 'Fixed it, definitely works now.',
          result: 'confirmed working',
          client_event_id: generateClientEventId(),
        },
      });
      expect(event.statusCode).toBe(201);

      const response = await transition(fixture, 'VERIFIED');

      // Describing a fix is not checking it. This is the entire reason
      // Verification is a separate entity with a boolean outcome.
      expect(response.statusCode).toBe(400);
      expect((await readProblem(fixture))['status']).toBe('FIX_CANDIDATE');
    });

    it('leaves everything except the status and updated_at alone', async () => {
      const fixture = await makeFixture();
      await transitionOk(fixture, 'FIX_CANDIDATE');
      await verify(fixture, true);
      const before = await readProblem(fixture);

      const after = await transitionOk(fixture, 'VERIFIED');

      expect(after).toMatchObject({
        status: 'VERIFIED',
        // Verified says the fix holds. It says nothing about whether the fix
        // addressed the cause, or how confident anyone is in the record.
        fix_kind: null,
        confidence: before['confidence'],
        freshness: before['freshness'],
        importance: before['importance'],
        memory_read_enabled: before['memory_read_enabled'],
        memory_write_enabled: before['memory_write_enabled'],
        suppressed: before['suppressed'],
        title: before['title'],
        symptoms: before['symptoms'],
        source_ai: before['source_ai'],
        environment_id: before['environment_id'],
        problem_id: before['problem_id'],
        project_id: before['project_id'],
        created_at: before['created_at'],
        // A successful write moves the version, so the next caller has to be
        // working from this one.
        version: (before['version'] as number) + 1,
      });
      expect(new Date(after['updated_at'] as string).getTime()).toBeGreaterThanOrEqual(
        new Date(before['updated_at'] as string).getTime(),
      );
    });
  });

  describe('one problem’s evidence is its own', () => {
    it('does not let another problem’s successful check verify this one', async () => {
      const actor = await makeActor();
      const checked = await makeFixture(actor);
      const unchecked = await makeFixture(actor);

      await verify(checked, true);
      await transitionOk(unchecked, 'FIX_CANDIDATE');

      const response = await transition(unchecked, 'VERIFIED');

      expect(response.statusCode).toBe(400);
      expect((await readProblem(unchecked))['status']).toBe('FIX_CANDIDATE');
    });

    it('does not count a replayed verification that left no row here', async () => {
      const actor = await makeActor();
      const checked = await makeFixture(actor);
      const unchecked = await makeFixture(actor);
      const clientEventId = generateClientEventId();

      const original = await verify(checked, true, clientEventId);

      // Sending the same key at the other problem replays the original —
      // response and all — without recording anything against this problem.
      const replayed = await unchecked.actor.app.inject({
        method: 'POST',
        url: `/v1/problems/${unchecked.problemId}/verifications`,
        payload: {
          verification_type: 'TEST',
          result: true,
          summary: 'Retried against the wrong problem',
          client_event_id: clientEventId,
        },
      });
      expect(replayed.statusCode).toBe(201);
      expect(replayed.json()).toEqual(original);

      const listed = await unchecked.actor.app.inject({
        method: 'GET',
        url: `/v1/problems/${unchecked.problemId}/verifications`,
      });
      expect(listed.json<{ verifications: unknown[] }>().verifications).toEqual([]);

      await transitionOk(unchecked, 'FIX_CANDIDATE');
      const response = await transition(unchecked, 'VERIFIED');

      // A 201 that replayed someone else's check is not evidence about this
      // problem, and the transition must not read it as one.
      expect(response.statusCode).toBe(400);
      expect((await readProblem(unchecked))['status']).toBe('FIX_CANDIDATE');
    });

    it('does not let another owner’s successful check verify this problem', async () => {
      const mine = await makeFixture();
      const theirs = await makeFixture();

      await verify(theirs, true);
      await transitionOk(mine, 'FIX_CANDIDATE');

      const response = await transition(mine, 'VERIFIED');

      expect(response.statusCode).toBe(400);
      expect((await readProblem(mine))['status']).toBe('FIX_CANDIDATE');
    });
  });

  describe('refused transitions', () => {
    it.each(['INVESTIGATING', 'FIX_CANDIDATE', 'PAUSED', 'CLOSED_UNRESOLVED'])(
      'refuses moving a problem to the status it is already in (%s)',
      async (status) => {
        const fixture = await makeFixture();
        if (status !== 'INVESTIGATING') {
          await transitionOk(fixture, status);
        }
        const before = await readProblem(fixture);

        const response = await transition(fixture, status);

        expect(response.statusCode).toBe(400);
        // Nothing happened, including `updated_at` — a refusal must not
        // record a change that never took place.
        expect(await readProblem(fixture)).toEqual(before);
      },
    );

    it.each(['INVESTIGATING', 'FIX_CANDIDATE', 'PAUSED'])(
      'refuses moving a verified problem to %s',
      async (target) => {
        const fixture = await makeFixture();
        await transitionOk(fixture, 'FIX_CANDIDATE');
        await verify(fixture, true);
        await transitionOk(fixture, 'VERIFIED');
        const before = await readProblem(fixture);

        const response = await transition(fixture, target);

        expect(response.statusCode).toBe(400);
        expect(await readProblem(fixture)).toEqual(before);
      },
    );

    it.each(['INVESTIGATING', 'FIX_CANDIDATE', 'PAUSED', 'VERIFIED'])(
      'refuses moving a closed problem to %s',
      async (target) => {
        const fixture = await makeFixture();
        await transitionOk(fixture, 'CLOSED_UNRESOLVED');
        const before = await readProblem(fixture);

        const response = await transition(fixture, target);

        expect(response.statusCode).toBe(400);
        expect(await readProblem(fixture)).toEqual(before);
      },
    );

    it('refuses moving a verified problem to closed', async () => {
      const fixture = await makeFixture();
      await transitionOk(fixture, 'FIX_CANDIDATE');
      await verify(fixture, true);
      await transitionOk(fixture, 'VERIFIED');

      const response = await transition(fixture, 'CLOSED_UNRESOLVED');

      // Both are terminal; a resolved problem is not later abandoned.
      expect(response.statusCode).toBe(400);
      expect((await readProblem(fixture))['status']).toBe('VERIFIED');
    });

    it('creates nothing when the problem is unknown', async () => {
      const fixture = await makeFixture();

      const response = await fixture.actor.app.inject({
        method: 'POST',
        url: `/v1/problems/${generateProblemId()}/status-transitions`,
        payload: { target_status: 'PAUSED', expected_version: 1 },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('nothing else moves the status', () => {
    it('leaves it where it is when an event is appended', async () => {
      const fixture = await makeFixture();
      await transitionOk(fixture, 'FIX_CANDIDATE');

      await fixture.actor.app.inject({
        method: 'POST',
        url: `/v1/problems/${fixture.problemId}/events`,
        payload: {
          event_type: 'FIX',
          summary: 'Set SameSite=Lax on the session cookie.',
          client_event_id: generateClientEventId(),
        },
      });

      expect((await readProblem(fixture))['status']).toBe('FIX_CANDIDATE');
    });

    it('leaves it where it is when a successful verification is recorded', async () => {
      const fixture = await makeFixture();
      await transitionOk(fixture, 'FIX_CANDIDATE');

      await verify(fixture, true);

      // Evidence arriving does not decide anything. Someone has to say so.
      expect((await readProblem(fixture))['status']).toBe('FIX_CANDIDATE');
    });

    it('refuses to set it through the ordinary problem update', async () => {
      const fixture = await makeFixture();

      const response = await fixture.actor.app.inject({
        method: 'PATCH',
        url: `/v1/problems/${fixture.problemId}`,
        payload: { status: 'VERIFIED' },
      });

      expect(response.statusCode).toBe(400);
      expect((await readProblem(fixture))['status']).toBe('INVESTIGATING');
    });

    it('still applies an ordinary patch without touching the status', async () => {
      const fixture = await makeFixture();
      const moved = await transitionOk(fixture, 'FIX_CANDIDATE');

      const patched = await fixture.actor.app.inject({
        method: 'PATCH',
        url: `/v1/problems/${fixture.problemId}`,
        // The transition moved the version, so the patch has to name the one
        // it produced — the two write paths share a lock rather than each
        // keeping their own.
        payload: { confidence: 'HIGH', importance: true, expected_version: moved['version'] },
      });

      expect(patched.statusCode).toBe(200);
      expect(patched.json()).toMatchObject({
        confidence: 'HIGH',
        importance: true,
        status: 'FIX_CANDIDATE',
        version: (moved['version'] as number) + 1,
      });
    });
  });

  describe('what one owner can reach of another', () => {
    it('cannot move the other’s problem', async () => {
      const mine = await makeFixture();
      const theirs = await makeFixture();
      const before = await readProblem(theirs);

      const response = await mine.actor.app.inject({
        method: 'POST',
        url: `/v1/problems/${theirs.problemId}/status-transitions`,
        payload: { target_status: 'CLOSED_UNRESOLVED', expected_version: 1 },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      expect(await readProblem(theirs)).toEqual(before);
    });

    it('answers the same for another owner’s problem as for one that does not exist', async () => {
      const mine = await makeFixture();
      const theirs = await makeFixture();

      const crossOwner = await mine.actor.app.inject({
        method: 'POST',
        url: `/v1/problems/${theirs.problemId}/status-transitions`,
        payload: { target_status: 'PAUSED', expected_version: 1 },
      });
      const unknown = await mine.actor.app.inject({
        method: 'POST',
        url: `/v1/problems/${generateProblemId()}/status-transitions`,
        payload: { target_status: 'PAUSED', expected_version: 1 },
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
