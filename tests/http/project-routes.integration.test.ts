/**
 * Project and Environment endpoints over a real database.
 *
 * Two owners are created per run and driven entirely through HTTP. The point
 * is what one owner can reach of the other's data: nothing, and without being
 * able to tell "not yours" from "does not exist".
 *
 * Every fixture is made here and removed here. Nothing depends on the
 * developer's owner or on what a previous run left behind.
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
  createProblemDeleteService,
  createVerificationService,
} from '../../src/app/index.js';
import { createFixedRequestContextService } from '../support/request-context.js';
import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { generateEnvironmentId } from '../../src/domain/environment.js';
import { generateOwnerId, type OwnerId } from '../../src/domain/owner.js';
import { generateProjectId } from '../../src/domain/project.js';
import { buildMemoryHttpApp } from '../../src/http/index.js';

const databaseUrl = readDatabaseUrl();

interface Actor {
  readonly app: FastifyInstance;
  readonly ownerId: OwnerId;
}

describe.skipIf(databaseUrl === undefined)('Project and Environment API', () => {
  let pool: DatabasePool;
  const ownersCreated: OwnerId[] = [];
  const appsCreated: FastifyInstance[] = [];

  /** An owner with its own app, acting only as itself. */
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
      logger: false,
    });
    appsCreated.push(app);

    return { app, ownerId };
  }

  async function createProject(actor: Actor, body: Record<string, unknown>) {
    const response = await actor.app.inject({
      method: 'POST',
      url: '/v1/projects',
      payload: body,
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ project_id: string; owner_id: string }>();
  }

  async function createEnvironment(actor: Actor, projectId: string, snapshot: unknown) {
    const response = await actor.app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/environments`,
      payload: { snapshot },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ environment_id: string; snapshot: unknown }>();
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
      for (const table of ['environments', 'projects', 'owners']) {
        await pool.query(`delete from public.${table} where owner_id = any($1::uuid[])`, [
          ownersCreated,
        ]);
      }
    }
    await closePool(pool);
  });

  describe('a project through its lifecycle', () => {
    it('is created, read back, listed and updated', async () => {
      const actor = await makeActor();

      const created = await createProject(actor, {
        project_name: 'checkout-web',
        repo: 'example/checkout-web',
        platform: 'web',
      });
      expect(created.owner_id).toBe(actor.ownerId);

      const fetched = await actor.app.inject({
        method: 'GET',
        url: `/v1/projects/${created.project_id}`,
      });
      expect(fetched.statusCode).toBe(200);
      expect(fetched.json()).toEqual(created);

      const listed = await actor.app.inject({ method: 'GET', url: '/v1/projects' });
      expect(listed.json<{ projects: { project_id: string }[] }>().projects).toEqual([created]);

      const patched = await actor.app.inject({
        method: 'PATCH',
        url: `/v1/projects/${created.project_id}`,
        payload: { project_name: 'checkout-web-v2' },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json()).toMatchObject({
        project_id: created.project_id,
        owner_id: actor.ownerId,
        project_name: 'checkout-web-v2',
        // Untouched fields keep their values.
        repo: 'example/checkout-web',
        platform: 'web',
      });
    });

    it('keeps identity and creation time while moving updated_at', async () => {
      const actor = await makeActor();
      const created = await createProject(actor, { project_name: 'timing' });
      const before = (
        await actor.app.inject({ method: 'GET', url: `/v1/projects/${created.project_id}` })
      ).json<{ created_at: string; updated_at: string }>();

      const patched = (
        await actor.app.inject({
          method: 'PATCH',
          url: `/v1/projects/${created.project_id}`,
          payload: { platform: 'ios' },
        })
      ).json<{
        project_id: string;
        owner_id: string;
        created_at: string;
        updated_at: string;
      }>();

      expect(patched.project_id).toBe(created.project_id);
      expect(patched.owner_id).toBe(actor.ownerId);
      expect(patched.created_at).toBe(before.created_at);
      expect(new Date(patched.updated_at).getTime()).toBeGreaterThanOrEqual(
        new Date(before.updated_at).getTime(),
      );
    });

    it.each([
      ['clearing the repo', { repo: null }, { repo: null, platform: 'web' }],
      ['clearing the platform', { platform: null }, { repo: 'example/x', platform: null }],
      ['a blank repo, which means absent', { repo: '   ' }, { repo: null, platform: 'web' }],
      [
        'a blank platform, which means absent',
        { platform: '' },
        { repo: 'example/x', platform: null },
      ],
    ])('handles %s', async (_label, patch, expected) => {
      const actor = await makeActor();
      const created = await createProject(actor, {
        project_name: 'clearing',
        repo: 'example/x',
        platform: 'web',
      });

      const response = await actor.app.inject({
        method: 'PATCH',
        url: `/v1/projects/${created.project_id}`,
        payload: patch,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject(expected);
    });

    it('never creates a project as a side effect of updating an unknown one', async () => {
      const actor = await makeActor();
      const absent = generateProjectId();

      const response = await actor.app.inject({
        method: 'PATCH',
        url: `/v1/projects/${absent}`,
        payload: { project_name: 'ghost' },
      });

      expect(response.statusCode).toBe(404);
      // An upsert here would invent a record the caller never created.
      const listed = await actor.app.inject({ method: 'GET', url: '/v1/projects' });
      expect(listed.json<{ projects: unknown[] }>().projects).toEqual([]);
    });
  });

  describe('listing', () => {
    it('returns an empty list for an owner with no projects', async () => {
      const actor = await makeActor();

      const response = await actor.app.inject({ method: 'GET', url: '/v1/projects' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ projects: [] });
    });

    it('orders projects oldest first and shows only this owner’s', async () => {
      const mine = await makeActor();
      const other = await makeActor();

      const first = await createProject(mine, { project_name: 'first' });
      const second = await createProject(mine, { project_name: 'second' });
      const third = await createProject(mine, { project_name: 'third' });
      await createProject(other, { project_name: 'not-mine' });

      const listed = await mine.app.inject({ method: 'GET', url: '/v1/projects' });
      const ids = listed
        .json<{ projects: { project_id: string }[] }>()
        .projects.map((project) => project.project_id);

      expect(ids).toEqual([first.project_id, second.project_id, third.project_id]);
    });

    it('orders deterministically when projects share a timestamp', async () => {
      const actor = await makeActor();
      const shared = '2026-01-01T00:00:00Z';
      const ids = [generateProjectId(), generateProjectId(), generateProjectId()];

      // Inserted directly so every row carries the identical created_at.
      for (const projectId of ids) {
        await pool.query(
          `insert into public.projects (project_id, owner_id, project_name, created_at, updated_at)
                values ($1, $2, $3, $4, $4)`,
          [projectId, actor.ownerId, `tie-${projectId}`, shared],
        );
      }

      const first = await actor.app.inject({ method: 'GET', url: '/v1/projects' });
      const second = await actor.app.inject({ method: 'GET', url: '/v1/projects' });
      const idsOf = (response: typeof first) =>
        response.json<{ projects: { project_id: string }[] }>().projects.map((p) => p.project_id);

      expect(idsOf(first)).toEqual([...ids].sort());
      expect(idsOf(second)).toEqual(idsOf(first));
    });

    it('orders environments oldest first, with a stable tie-break', async () => {
      const actor = await makeActor();
      const project = await createProject(actor, { project_name: 'environments' });
      const shared = '2026-01-01T00:00:00Z';
      const ids = [generateEnvironmentId(), generateEnvironmentId(), generateEnvironmentId()];

      for (const environmentId of ids) {
        await pool.query(
          `insert into public.environments (environment_id, owner_id, project_id, snapshot, created_at)
                values ($1, $2, $3, '{}'::jsonb, $4)`,
          [environmentId, actor.ownerId, project.project_id, shared],
        );
      }

      const response = await actor.app.inject({
        method: 'GET',
        url: `/v1/projects/${project.project_id}/environments`,
      });

      expect(
        response
          .json<{ environments: { environment_id: string }[] }>()
          .environments.map((environment) => environment.environment_id),
      ).toEqual([...ids].sort());
    });
  });

  describe('environments', () => {
    it('round-trips a snapshot unchanged', async () => {
      const actor = await makeActor();
      const project = await createProject(actor, { project_name: 'snapshots' });
      const snapshot = {
        os: 'iOS 18.2',
        versions: { node: '22.12.0', xcode: '16.2' },
        tags: ['release', 'device'],
        commit: null,
        verified: true,
        attempts: 3,
      };

      const created = await createEnvironment(actor, project.project_id, snapshot);
      const fetched = await actor.app.inject({
        method: 'GET',
        url: `/v1/environments/${created.environment_id}`,
      });

      expect(created.snapshot).toEqual(snapshot);
      expect(fetched.json<{ snapshot: unknown }>().snapshot).toEqual(snapshot);
    });

    it('accepts an empty snapshot, meaning conditions are not captured yet', async () => {
      const actor = await makeActor();
      const project = await createProject(actor, { project_name: 'empty-snapshot' });

      const created = await createEnvironment(actor, project.project_id, {});

      expect(created.snapshot).toEqual({});
    });

    it('lists nothing for a project that has no environments', async () => {
      const actor = await makeActor();
      const project = await createProject(actor, { project_name: 'no-environments' });

      const response = await actor.app.inject({
        method: 'GET',
        url: `/v1/projects/${project.project_id}/environments`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ environments: [] });
    });
  });

  describe('what one owner can reach of another', () => {
    it('cannot read, update or extend the other’s project', async () => {
      const mine = await makeActor();
      const theirs = await makeActor();
      const theirProject = await createProject(theirs, { project_name: 'private' });

      const attempts = [
        await mine.app.inject({ method: 'GET', url: `/v1/projects/${theirProject.project_id}` }),
        await mine.app.inject({
          method: 'PATCH',
          url: `/v1/projects/${theirProject.project_id}`,
          payload: { project_name: 'stolen' },
        }),
        await mine.app.inject({
          method: 'POST',
          url: `/v1/projects/${theirProject.project_id}/environments`,
          payload: { snapshot: {} },
        }),
        await mine.app.inject({
          method: 'GET',
          url: `/v1/projects/${theirProject.project_id}/environments`,
        }),
      ];

      for (const attempt of attempts) {
        expect(attempt.statusCode).toBe(404);
        expect(attempt.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      }

      // And the attempted rename did not land.
      const theirs2 = await theirs.app.inject({
        method: 'GET',
        url: `/v1/projects/${theirProject.project_id}`,
      });
      expect(theirs2.json()).toMatchObject({ project_name: 'private' });
    });

    it('cannot read the other’s environment', async () => {
      const mine = await makeActor();
      const theirs = await makeActor();
      const theirProject = await createProject(theirs, { project_name: 'private' });
      const theirEnvironment = await createEnvironment(theirs, theirProject.project_id, {
        secret: 'value',
      });

      const response = await mine.app.inject({
        method: 'GET',
        url: `/v1/environments/${theirEnvironment.environment_id}`,
      });

      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain('secret');
    });

    it('does not see the other’s projects in its own list', async () => {
      const mine = await makeActor();
      const theirs = await makeActor();
      await createProject(theirs, { project_name: 'theirs' });
      const own = await createProject(mine, { project_name: 'mine' });

      const listed = await mine.app.inject({ method: 'GET', url: '/v1/projects' });
      const projects = listed.json<{ projects: { project_id: string }[] }>().projects;

      expect(projects.map((project) => project.project_id)).toEqual([own.project_id]);
    });

    it.each([
      ['a project', (id: string) => `/v1/projects/${id}`],
      ['a project’s environments', (id: string) => `/v1/projects/${id}/environments`],
    ])(
      'answers the same for another owner’s %s as for one that does not exist',
      async (_label, urlFor) => {
        const mine = await makeActor();
        const theirs = await makeActor();
        const theirProject = await createProject(theirs, { project_name: 'private' });

        const crossOwner = await mine.app.inject({
          method: 'GET',
          url: urlFor(theirProject.project_id),
        });
        const unknown = await mine.app.inject({ method: 'GET', url: urlFor(generateProjectId()) });

        expect(crossOwner.statusCode).toBe(unknown.statusCode);
        // request_id differs per request; the meaningful part must match.
        expect(crossOwner.json<{ error: unknown }>().error).toEqual(
          unknown.json<{ error: unknown }>().error,
        );
      },
    );

    it('answers the same for another owner’s environment as for one that does not exist', async () => {
      const mine = await makeActor();
      const theirs = await makeActor();
      const theirProject = await createProject(theirs, { project_name: 'private' });
      const theirEnvironment = await createEnvironment(theirs, theirProject.project_id, {});

      const crossOwner = await mine.app.inject({
        method: 'GET',
        url: `/v1/environments/${theirEnvironment.environment_id}`,
      });
      const unknown = await mine.app.inject({
        method: 'GET',
        url: `/v1/environments/${generateEnvironmentId()}`,
      });

      expect(crossOwner.statusCode).toBe(unknown.statusCode);
      expect(crossOwner.json<{ error: unknown }>().error).toEqual(
        unknown.json<{ error: unknown }>().error,
      );
    });
  });

  describe('unknown resources', () => {
    it.each([
      ['a project', (id: string) => `/v1/projects/${id}`],
      ['a project’s environments', (id: string) => `/v1/projects/${id}/environments`],
    ])('reports %s that does not exist as not found', async (_label, urlFor) => {
      const actor = await makeActor();

      const response = await actor.app.inject({ method: 'GET', url: urlFor(generateProjectId()) });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    });

    it('refuses to create an environment under a project that does not exist', async () => {
      const actor = await makeActor();

      const response = await actor.app.inject({
        method: 'POST',
        url: `/v1/projects/${generateProjectId()}/environments`,
        payload: { snapshot: {} },
      });

      expect(response.statusCode).toBe(404);
    });
  });
});
