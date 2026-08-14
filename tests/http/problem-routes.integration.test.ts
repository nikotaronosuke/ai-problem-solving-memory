/**
 * Problem endpoints over a real database.
 *
 * Two owners per run, driven entirely through HTTP. What matters here is the
 * relation check on creation — a Problem names a project and an environment,
 * and every way those can fail to line up must look the same from outside —
 * and that a patch changes exactly what it names and nothing else.
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
  createVerificationService,
} from '../../src/app/index.js';
import { createFixedRequestContextService } from '../support/request-context.js';
import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { CONFIDENCES, FRESHNESSES } from '../../src/domain/enums.js';
import { generateEnvironmentId } from '../../src/domain/environment.js';
import { generateOwnerId, type OwnerId } from '../../src/domain/owner.js';
import { generateProblemId } from '../../src/domain/problem.js';
import { generateProjectId } from '../../src/domain/project.js';
import { buildMemoryHttpApp } from '../../src/http/index.js';

const databaseUrl = readDatabaseUrl();

interface Actor {
  readonly app: FastifyInstance;
  readonly ownerId: OwnerId;
}

interface Fixture {
  readonly actor: Actor;
  readonly projectId: string;
  readonly environmentId: string;
}

describe.skipIf(databaseUrl === undefined)('Problem API', () => {
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
      logger: false,
    });
    appsCreated.push(app);

    return { app, ownerId };
  }

  async function makeProject(actor: Actor, name = 'fixture-project'): Promise<string> {
    const response = await actor.app.inject({
      method: 'POST',
      url: '/v1/projects',
      payload: { project_name: name },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ project_id: string }>().project_id;
  }

  async function makeEnvironment(actor: Actor, projectId: string): Promise<string> {
    const response = await actor.app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/environments`,
      payload: { snapshot: { runtime: 'node 22.12.0' } },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ environment_id: string }>().environment_id;
  }

  /** An owner with a project and an environment ready to file problems against. */
  async function makeFixture(existing?: Actor): Promise<Fixture> {
    const actor = existing ?? (await makeActor());
    const projectId = await makeProject(actor);
    const environmentId = await makeEnvironment(actor, projectId);
    return { actor, projectId, environmentId };
  }

  async function createProblem(fixture: Fixture, overrides: Record<string, unknown> = {}) {
    const response = await fixture.actor.app.inject({
      method: 'POST',
      url: `/v1/projects/${fixture.projectId}/problems`,
      payload: {
        environment_id: fixture.environmentId,
        title: 'Sign-in fails after deploying',
        symptoms: 'Works locally, fails on preview.',
        ...overrides,
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
      for (const table of ['change_logs', 'problems', 'environments', 'projects', 'owners']) {
        await pool.query(`delete from public.${table} where owner_id = any($1::uuid[])`, [
          ownersCreated,
        ]);
      }
    }
    await closePool(pool);
  });

  describe('creating', () => {
    it('starts a problem with the state the database decides', async () => {
      const fixture = await makeFixture();

      const problem = await createProblem(fixture);

      expect(problem).toMatchObject({
        owner_id: fixture.actor.ownerId,
        project_id: fixture.projectId,
        environment_id: fixture.environmentId,
        problem_domain: null,
        suspected_boundary: null,
        source_ai: null,
        status: 'INVESTIGATING',
        fix_kind: null,
        importance: false,
        confidence: 'LOW',
        freshness: 'CURRENT',
        memory_read_enabled: true,
        memory_write_enabled: true,
        suppressed: false,
        version: 1,
      });
    });

    it('stores optional text, trimming it', async () => {
      const fixture = await makeFixture();

      const problem = await createProblem(fixture, {
        problem_domain: '  auth  ',
        suspected_boundary: '  provider boundary  ',
        source_ai: '  claude-code  ',
      });

      expect(problem).toMatchObject({
        problem_domain: 'auth',
        suspected_boundary: 'provider boundary',
        source_ai: 'claude-code',
      });
    });

    it('treats blank optional text as absent', async () => {
      const fixture = await makeFixture();

      const problem = await createProblem(fixture, {
        problem_domain: '   ',
        suspected_boundary: '',
        source_ai: null,
      });

      expect(problem).toMatchObject({
        problem_domain: null,
        suspected_boundary: null,
        source_ai: null,
      });
    });

    it('refuses an unknown project', async () => {
      const fixture = await makeFixture();

      const response = await fixture.actor.app.inject({
        method: 'POST',
        url: `/v1/projects/${generateProjectId()}/problems`,
        payload: { environment_id: fixture.environmentId, title: 't', symptoms: 's' },
      });

      expect(response.statusCode).toBe(404);
    });

    it('refuses an unknown environment', async () => {
      const fixture = await makeFixture();

      const response = await fixture.actor.app.inject({
        method: 'POST',
        url: `/v1/projects/${fixture.projectId}/problems`,
        payload: { environment_id: generateEnvironmentId(), title: 't', symptoms: 's' },
      });

      expect(response.statusCode).toBe(404);
    });

    it('refuses an environment from another project of the same owner', async () => {
      const fixture = await makeFixture();
      const otherProject = await makeProject(fixture.actor, 'other');
      const otherEnvironment = await makeEnvironment(fixture.actor, otherProject);

      const response = await fixture.actor.app.inject({
        method: 'POST',
        url: `/v1/projects/${fixture.projectId}/problems`,
        payload: { environment_id: otherEnvironment, title: 't', symptoms: 's' },
      });

      // The environment is the owner's, but it is not this project's.
      expect(response.statusCode).toBe(404);
    });

    it('answers the same however the relation fails', async () => {
      const mine = await makeFixture();
      const theirs = await makeFixture();
      const otherProject = await makeProject(mine.actor, 'other');
      const otherEnvironment = await makeEnvironment(mine.actor, otherProject);

      const attempts = [
        // unknown project
        { url: `/v1/projects/${generateProjectId()}/problems`, env: mine.environmentId },
        // another owner's project
        { url: `/v1/projects/${theirs.projectId}/problems`, env: mine.environmentId },
        // unknown environment
        { url: `/v1/projects/${mine.projectId}/problems`, env: generateEnvironmentId() },
        // another owner's environment
        { url: `/v1/projects/${mine.projectId}/problems`, env: theirs.environmentId },
        // own environment, wrong project
        { url: `/v1/projects/${mine.projectId}/problems`, env: otherEnvironment },
      ];

      const bodies: string[] = [];
      for (const attempt of attempts) {
        const response = await mine.actor.app.inject({
          method: 'POST',
          url: attempt.url,
          payload: { environment_id: attempt.env, title: 't', symptoms: 's' },
        });
        expect(response.statusCode).toBe(404);
        bodies.push(JSON.stringify(response.json<{ error: unknown }>().error));
      }

      // Five different reasons, one answer — otherwise the endpoint tells a
      // caller which ids exist.
      expect(new Set(bodies).size).toBe(1);
    });
  });

  describe('reading and listing', () => {
    it('reads a problem back unchanged', async () => {
      const fixture = await makeFixture();
      const created = await createProblem(fixture);

      const response = await fixture.actor.app.inject({
        method: 'GET',
        url: `/v1/problems/${created['problem_id'] as string}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(created);
    });

    it('reports an unknown problem as not found', async () => {
      const fixture = await makeFixture();

      const response = await fixture.actor.app.inject({
        method: 'GET',
        url: `/v1/problems/${generateProblemId()}`,
      });

      expect(response.statusCode).toBe(404);
    });

    it('returns an empty list for a project with no problems', async () => {
      const fixture = await makeFixture();

      const response = await fixture.actor.app.inject({
        method: 'GET',
        url: `/v1/projects/${fixture.projectId}/problems`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ problems: [] });
    });

    it('lists a project’s problems oldest first', async () => {
      const fixture = await makeFixture();
      const first = await createProblem(fixture, { title: 'first' });
      const second = await createProblem(fixture, { title: 'second' });
      const third = await createProblem(fixture, { title: 'third' });

      const response = await fixture.actor.app.inject({
        method: 'GET',
        url: `/v1/projects/${fixture.projectId}/problems`,
      });

      expect(
        response.json<{ problems: { problem_id: string }[] }>().problems.map((p) => p.problem_id),
      ).toEqual([first['problem_id'], second['problem_id'], third['problem_id']]);
    });

    it('orders deterministically when problems share a timestamp', async () => {
      const fixture = await makeFixture();
      const shared = '2026-01-01T00:00:00Z';
      const ids = [generateProblemId(), generateProblemId(), generateProblemId()];

      for (const problemId of ids) {
        await pool.query(
          `insert into public.problems
                  (problem_id, owner_id, project_id, environment_id, title, symptoms,
                   created_at, updated_at)
                values ($1, $2, $3, $4, $5, 's', $6, $6)`,
          [
            problemId,
            fixture.actor.ownerId,
            fixture.projectId,
            fixture.environmentId,
            `tie-${problemId}`,
            shared,
          ],
        );
      }

      const first = await fixture.actor.app.inject({
        method: 'GET',
        url: `/v1/projects/${fixture.projectId}/problems`,
      });
      const second = await fixture.actor.app.inject({
        method: 'GET',
        url: `/v1/projects/${fixture.projectId}/problems`,
      });
      const idsOf = (r: typeof first) =>
        r.json<{ problems: { problem_id: string }[] }>().problems.map((p) => p.problem_id);

      expect(idsOf(first)).toEqual([...ids].sort());
      expect(idsOf(second)).toEqual(idsOf(first));
    });

    it('refuses to list problems of an unknown project', async () => {
      const fixture = await makeFixture();

      const response = await fixture.actor.app.inject({
        method: 'GET',
        url: `/v1/projects/${generateProjectId()}/problems`,
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('updating', () => {
    it('changes only what it names, keeping identity and creation time', async () => {
      const fixture = await makeFixture();
      const created = await createProblem(fixture, { problem_domain: 'auth' });

      const response = await fixture.actor.app.inject({
        method: 'PATCH',
        url: `/v1/problems/${created['problem_id'] as string}`,
        payload: { title: 'renamed', changed_by: 'claude-code', expected_version: 1 },
      });

      expect(response.statusCode).toBe(200);
      const patched = response.json<Record<string, unknown>>();

      expect(patched).toMatchObject({
        problem_id: created['problem_id'],
        owner_id: created['owner_id'],
        project_id: created['project_id'],
        environment_id: created['environment_id'],
        title: 'renamed',
        // Untouched.
        symptoms: created['symptoms'],
        problem_domain: 'auth',
        created_at: created['created_at'],
        // Not writable. Status and fix kind are unchanged by an ordinary
        // update; version moves because a successful write moves it.
        status: 'INVESTIGATING',
        fix_kind: null,
        version: 2,
      });
      expect(new Date(patched['updated_at'] as string).getTime()).toBeGreaterThanOrEqual(
        new Date(created['updated_at'] as string).getTime(),
      );
    });

    it.each([
      ['clearing the domain', { problem_domain: null }, { problem_domain: null }],
      ['a blank domain', { problem_domain: '   ' }, { problem_domain: null }],
      ['clearing the boundary', { suspected_boundary: null }, { suspected_boundary: null }],
      ['clearing the source', { source_ai: null }, { source_ai: null }],
    ])('handles %s', async (_label, patch, expected) => {
      const fixture = await makeFixture();
      const created = await createProblem(fixture, {
        problem_domain: 'auth',
        suspected_boundary: 'provider',
        source_ai: 'claude-code',
      });

      const response = await fixture.actor.app.inject({
        method: 'PATCH',
        url: `/v1/problems/${created['problem_id'] as string}`,
        payload: { ...patch, changed_by: 'claude-code', expected_version: 1 },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject(expected);
    });

    it.each(CONFIDENCES)('stores confidence %s', async (confidence) => {
      const fixture = await makeFixture();
      const created = await createProblem(fixture);

      const response = await fixture.actor.app.inject({
        method: 'PATCH',
        url: `/v1/problems/${created['problem_id'] as string}`,
        payload: { confidence, changed_by: 'claude-code', expected_version: 1 },
      });

      expect(response.json()).toMatchObject({ confidence });
    });

    it.each(FRESHNESSES)('stores freshness %s', async (freshness) => {
      const fixture = await makeFixture();
      const created = await createProblem(fixture);

      const response = await fixture.actor.app.inject({
        method: 'PATCH',
        url: `/v1/problems/${created['problem_id'] as string}`,
        payload: { freshness, changed_by: 'claude-code', expected_version: 1 },
      });

      expect(response.json()).toMatchObject({ freshness });
    });

    it('keeps the flags, importance, confidence and freshness independent', async () => {
      const fixture = await makeFixture();
      const created = await createProblem(fixture);
      const id = created['problem_id'] as string;

      // Each write moves the version, so the next one has to name the version
      // the last one produced — which is the contract working, not a detail of
      // the test.
      let version = created['version'] as number;
      const patch = async (payload: Record<string, unknown>) => {
        const response = await fixture.actor.app.inject({
          method: 'PATCH',
          url: `/v1/problems/${id}`,
          payload: { ...payload, changed_by: 'claude-code', expected_version: version },
        });
        expect(response.statusCode).toBe(200);
        const body = response.json<Record<string, unknown>>();
        version = body['version'] as number;
        return body;
      };

      // Suppressing must not disable reads: "surface this less" and "do not
      // read this" are different instructions.
      const suppressed = await patch({ suppressed: true });
      expect(suppressed).toMatchObject({
        suppressed: true,
        memory_read_enabled: true,
        memory_write_enabled: true,
        importance: false,
        confidence: 'LOW',
        freshness: 'CURRENT',
      });

      // Marking important must not raise confidence: important does not mean
      // correct.
      const important = await patch({ importance: true });
      expect(important).toMatchObject({
        importance: true,
        confidence: 'LOW',
        suppressed: true,
        memory_read_enabled: true,
      });

      // Going stale must not suppress or disable anything.
      const stale = await patch({ freshness: 'INVALID' });
      expect(stale).toMatchObject({
        freshness: 'INVALID',
        suppressed: true,
        importance: true,
        confidence: 'LOW',
        memory_read_enabled: true,
        memory_write_enabled: true,
      });

      // And an unusual combination stores exactly as asked.
      const mixed = await patch({ memory_read_enabled: false, memory_write_enabled: true });
      expect(mixed).toMatchObject({
        memory_read_enabled: false,
        memory_write_enabled: true,
        suppressed: true,
      });
    });

    it('never creates a problem as a side effect of patching an unknown one', async () => {
      const fixture = await makeFixture();

      const response = await fixture.actor.app.inject({
        method: 'PATCH',
        url: `/v1/problems/${generateProblemId()}`,
        payload: { title: 'ghost', changed_by: 'claude-code', expected_version: 1 },
      });

      expect(response.statusCode).toBe(404);
      const listed = await fixture.actor.app.inject({
        method: 'GET',
        url: `/v1/projects/${fixture.projectId}/problems`,
      });
      expect(listed.json<{ problems: unknown[] }>().problems).toEqual([]);
    });
  });

  describe('what one owner can reach of another', () => {
    it('cannot read, patch or list the other’s problems', async () => {
      const mine = await makeFixture();
      const theirs = await makeFixture();
      const theirProblem = await createProblem(theirs, { title: 'private' });
      const theirProblemId = theirProblem['problem_id'] as string;

      const attempts = [
        await mine.actor.app.inject({ method: 'GET', url: `/v1/problems/${theirProblemId}` }),
        await mine.actor.app.inject({
          method: 'PATCH',
          url: `/v1/problems/${theirProblemId}`,
          payload: { title: 'stolen', changed_by: 'claude-code', expected_version: 1 },
        }),
        await mine.actor.app.inject({
          method: 'GET',
          url: `/v1/projects/${theirs.projectId}/problems`,
        }),
      ];

      for (const attempt of attempts) {
        expect(attempt.statusCode).toBe(404);
        expect(attempt.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      }

      // The attempted rename did not land.
      const reread = await theirs.actor.app.inject({
        method: 'GET',
        url: `/v1/problems/${theirProblemId}`,
      });
      expect(reread.json()).toMatchObject({ title: 'private' });
    });

    it('answers the same for another owner’s problem as for one that does not exist', async () => {
      const mine = await makeFixture();
      const theirs = await makeFixture();
      const theirProblem = await createProblem(theirs);

      const crossOwner = await mine.actor.app.inject({
        method: 'GET',
        url: `/v1/problems/${theirProblem['problem_id'] as string}`,
      });
      const unknown = await mine.actor.app.inject({
        method: 'GET',
        url: `/v1/problems/${generateProblemId()}`,
      });

      expect(crossOwner.statusCode).toBe(unknown.statusCode);
      expect(crossOwner.json<{ error: unknown }>().error).toEqual(
        unknown.json<{ error: unknown }>().error,
      );
    });

    it('refuses a patch identically whether the problem is another owner’s or absent', async () => {
      const mine = await makeFixture();
      const theirs = await makeFixture();
      const theirProblem = await createProblem(theirs, { title: 'private' });
      const theirProblemId = theirProblem['problem_id'] as string;
      const absentProblemId = generateProblemId();

      const crossOwner = await mine.actor.app.inject({
        method: 'PATCH',
        url: `/v1/problems/${theirProblemId}`,
        payload: { title: 'stolen', changed_by: 'claude-code', expected_version: 1 },
      });
      const unknown = await mine.actor.app.inject({
        method: 'PATCH',
        url: `/v1/problems/${absentProblemId}`,
        payload: { title: 'stolen', changed_by: 'claude-code', expected_version: 1 },
      });

      expect(crossOwner.statusCode).toBe(404);
      expect(unknown.statusCode).toBe(404);

      // `request_id` differs per request by design, so the comparison is of the
      // part that carries meaning. Both must be the same code and the same
      // message: a patch that failed differently would answer "this id is
      // someone's" for anyone who tried one.
      const crossOwnerError = crossOwner.json<{ error: { code: string; message: string } }>().error;
      const unknownError = unknown.json<{ error: { code: string; message: string } }>().error;
      expect(crossOwnerError).toEqual(unknownError);
      expect(crossOwnerError).toEqual({ code: 'NOT_FOUND', message: 'Not found.' });

      // And neither attempt may have had an effect: no write to the other
      // owner's record, and no record conjured at the absent id.
      const reread = await theirs.actor.app.inject({
        method: 'GET',
        url: `/v1/problems/${theirProblemId}`,
      });
      expect(reread.statusCode).toBe(200);
      expect(reread.json()).toEqual(theirProblem);

      const conjured = await theirs.actor.app.inject({
        method: 'GET',
        url: `/v1/problems/${absentProblemId}`,
      });
      expect(conjured.statusCode).toBe(404);
    });

    it('does not show the other’s problems in its own project list', async () => {
      const mine = await makeFixture();
      const theirs = await makeFixture();
      await createProblem(theirs);
      const own = await createProblem(mine);

      const listed = await mine.actor.app.inject({
        method: 'GET',
        url: `/v1/projects/${mine.projectId}/problems`,
      });

      expect(
        listed.json<{ problems: { problem_id: string }[] }>().problems.map((p) => p.problem_id),
      ).toEqual([own['problem_id']]);
    });
  });
});
