/**
 * The Project and Environment request contract, driven through `inject()`.
 *
 * The application service is substituted, so what is under test is the
 * transport layer's own job: which requests it accepts, which it refuses
 * before anything downstream sees them, and the exact shape of what comes
 * back.
 *
 * The refusals matter most. A field the caller must not set, a patch that
 * changes nothing, a snapshot that is not an object — each should be a 400
 * from the schema rather than something the database has to notice later.
 */

import { describe, expect, it } from 'vitest';

import {
  createRelationService,
  createUsageLogService,
  createChangeLogService,
  createMemoryControlService,
  createProblemCloseService,
  createProblemDeleteService,
  createVerificationService,
  createEventService,
  createProblemService,
  createProblemStatusService,
  RequestContextUnavailableError,
  type AuthenticatedRequestContext,
  type CreateEnvironmentCommand,
  type CreateProjectCommand,
  type EnvironmentRecord,
  type HealthService,
  type ProjectEnvironmentService,
  type ProjectRecord,
  type RequestContextService,
  type UpdateProjectCommand,
} from '../../src/app/index.js';
import { buildMemoryHttpApp } from '../../src/http/index.js';
import type { EnvironmentId } from '../../src/domain/environment.js';
import type { OwnerId } from '../../src/domain/owner.js';
import type { ProjectId } from '../../src/domain/project.js';
import type { MemoryRepository } from '../../src/repository/index.js';

const OWNER_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const PROJECT_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const ENVIRONMENT_ID = '9b2f1c4e-6d3a-4b8e-9f10-2c5d7e8a1b34';
const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');
const UPDATED_AT = new Date('2026-01-02T00:00:00.000Z');

function projectRecord(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    projectId: PROJECT_ID as ProjectId,
    ownerId: OWNER_ID as OwnerId,
    projectName: 'checkout-web',
    repo: null,
    platform: null,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function environmentRecord(overrides: Partial<EnvironmentRecord> = {}): EnvironmentRecord {
  return {
    environmentId: ENVIRONMENT_ID as EnvironmentId,
    ownerId: OWNER_ID as OwnerId,
    projectId: PROJECT_ID as ProjectId,
    snapshot: { runtime: 'node 22.12.0' },
    createdAt: CREATED_AT,
    ...overrides,
  };
}

/** Records what the transport layer passed on, so the mapping can be checked. */
interface ServiceCalls {
  createProject?: CreateProjectCommand;
  updateProject?: { projectId: string; command: UpdateProjectCommand };
  createEnvironment?: { projectId: string; command: CreateEnvironmentCommand };
  getProject?: string;
  getEnvironment?: string;
  listEnvironments?: string;
}

function serviceRecording(calls: ServiceCalls): ProjectEnvironmentService {
  return {
    createProject: (_context, command) => {
      calls.createProject = command;
      return Promise.resolve(projectRecord());
    },
    getProject: (_context, projectId) => {
      calls.getProject = projectId;
      return Promise.resolve(projectRecord());
    },
    listProjects: () => Promise.resolve([projectRecord()]),
    updateProject: (_context, projectId, command) => {
      calls.updateProject = { projectId, command };
      return Promise.resolve(projectRecord());
    },
    createEnvironment: (_context, projectId, command) => {
      calls.createEnvironment = { projectId, command };
      return Promise.resolve(environmentRecord({ snapshot: command.snapshot as never }));
    },
    getEnvironment: (_context, environmentId) => {
      calls.getEnvironment = environmentId;
      return Promise.resolve(environmentRecord());
    },
    listEnvironments: (_context, projectId) => {
      calls.listEnvironments = projectId;
      return Promise.resolve([environmentRecord()]);
    },
  };
}

const healthService: HealthService = { check: () => Promise.resolve({ status: 'ok' }) };

function contextService(ownerId = OWNER_ID): RequestContextService {
  return {
    authenticate: () =>
      Promise.resolve({
        repository: { ownerId } as unknown as MemoryRepository,
      } as AuthenticatedRequestContext),
  };
}

function buildApp(service: ProjectEnvironmentService, authenticated = true) {
  return buildMemoryHttpApp({
    healthService,
    requestContextService: authenticated
      ? contextService()
      : { authenticate: () => Promise.reject(new RequestContextUnavailableError('unset')) },
    projectEnvironmentService: service,
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
}

describe('POST /v1/projects', () => {
  it('creates a project and returns it in snake_case with ISO timestamps', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      payload: { project_name: 'checkout-web' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      project_id: PROJECT_ID,
      owner_id: OWNER_ID,
      project_name: 'checkout-web',
      repo: null,
      platform: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    });

    await app.close();
  });

  it('passes repo and platform through only when they were sent', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    await app.inject({
      method: 'POST',
      url: '/v1/projects',
      payload: { project_name: 'p', repo: 'example/p', platform: null },
    });

    expect(calls.createProject).toEqual({
      projectName: 'p',
      repo: 'example/p',
      platform: null,
    });

    await app.close();
  });

  it.each([
    ['no body at all', undefined],
    ['a missing name', {}],
    ['an empty name', { project_name: '' }],
    ['a whitespace-only name', { project_name: '   ' }],
    ['a tab-only name', { project_name: '\t' }],
    ['a non-string name', { project_name: 42 }],
  ])('refuses %s', async (_label, payload) => {
    const app = buildApp(serviceRecording({}));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      payload: payload ?? '',
      headers: { 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });

    await app.close();
  });

  it.each(['owner_id', 'project_id', 'created_at', 'updated_at', 'surprise'])(
    'refuses a body containing %s',
    async (field) => {
      const calls: ServiceCalls = {};
      const app = buildApp(serviceRecording(calls));

      const response = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { project_name: 'p', [field]: 'anything' },
      });

      expect(response.statusCode).toBe(400);
      // Refused outright rather than dropped: a caller that believes it set
      // an owner should be told it cannot.
      expect(calls.createProject).toBeUndefined();

      await app.close();
    },
  );

  it('requires an owner context', async () => {
    const app = buildApp(serviceRecording({}), false);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      payload: { project_name: 'p' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });

    await app.close();
  });
});

describe('GET /v1/projects', () => {
  it('returns the owner’s projects under a projects key', async () => {
    const app = buildApp(serviceRecording({}));

    const response = await app.inject({ method: 'GET', url: '/v1/projects' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      projects: [
        {
          project_id: PROJECT_ID,
          owner_id: OWNER_ID,
          project_name: 'checkout-web',
          repo: null,
          platform: null,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-02T00:00:00.000Z',
        },
      ],
    });

    await app.close();
  });

  it('returns an empty list rather than an error when there are none', async () => {
    const app = buildApp({ ...serviceRecording({}), listProjects: () => Promise.resolve([]) });

    const response = await app.inject({ method: 'GET', url: '/v1/projects' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ projects: [] });

    await app.close();
  });
});

describe('GET /v1/projects/:project_id', () => {
  it('returns the project', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({ method: 'GET', url: `/v1/projects/${PROJECT_ID}` });

    expect(response.statusCode).toBe(200);
    expect(calls.getProject).toBe(PROJECT_ID);

    await app.close();
  });

  it.each(['not-a-uuid', '123', '7c9e6679-7425-40de-944b'])(
    'refuses a malformed id (%s) before reaching the service',
    async (badId) => {
      const calls: ServiceCalls = {};
      const app = buildApp(serviceRecording(calls));

      const response = await app.inject({ method: 'GET', url: `/v1/projects/${badId}` });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
      expect(calls.getProject).toBeUndefined();

      await app.close();
    },
  );
});

describe('PATCH /v1/projects/:project_id', () => {
  it.each([
    ['just the name', { project_name: 'renamed' }, { projectName: 'renamed' }],
    ['just the repo', { repo: 'example/x' }, { repo: 'example/x' }],
    ['just the platform', { platform: 'ios' }, { platform: 'ios' }],
    [
      'several fields',
      { project_name: 'n', repo: 'r', platform: 'p' },
      { projectName: 'n', repo: 'r', platform: 'p' },
    ],
    ['a repo cleared to null', { repo: null }, { repo: null }],
    ['a platform cleared to null', { platform: null }, { platform: null }],
    ['a blank repo', { repo: '   ' }, { repo: '   ' }],
  ])('forwards %s and nothing else', async (_label, payload, expected) => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${PROJECT_ID}`,
      payload,
    });

    expect(response.statusCode).toBe(200);
    // Omitted fields are absent, not undefined: the service must be able to
    // tell "leave alone" from "clear".
    expect(calls.updateProject?.command).toEqual(expected);
    expect(calls.updateProject?.projectId).toBe(PROJECT_ID);

    await app.close();
  });

  it('refuses a patch that changes nothing', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${PROJECT_ID}`,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    // An empty patch would still move updated_at, recording a change that
    // never happened.
    expect(calls.updateProject).toBeUndefined();

    await app.close();
  });

  it.each([
    ['a whitespace-only name', { project_name: '   ' }],
    ['an empty name', { project_name: '' }],
    ['an owner_id', { owner_id: OWNER_ID }],
    ['a project_id', { project_id: PROJECT_ID }],
    ['a created_at', { created_at: '2020-01-01T00:00:00.000Z' }],
    ['an updated_at', { updated_at: '2020-01-01T00:00:00.000Z' }],
    ['an unknown field', { surprise: true }],
  ])('refuses %s', async (_label, payload) => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${PROJECT_ID}`,
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(calls.updateProject).toBeUndefined();

    await app.close();
  });

  it('refuses a malformed project id', async () => {
    const app = buildApp(serviceRecording({}));

    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/projects/not-a-uuid',
      payload: { project_name: 'x' },
    });

    expect(response.statusCode).toBe(400);

    await app.close();
  });
});

describe('POST /v1/projects/:project_id/environments', () => {
  it('creates an environment under the project in the path', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'POST',
      url: `/v1/projects/${PROJECT_ID}/environments`,
      payload: { snapshot: { runtime: 'node 22.12.0' } },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      environment_id: ENVIRONMENT_ID,
      owner_id: OWNER_ID,
      project_id: PROJECT_ID,
      snapshot: { runtime: 'node 22.12.0' },
      created_at: '2026-01-01T00:00:00.000Z',
    });
    expect(calls.createEnvironment?.projectId).toBe(PROJECT_ID);

    await app.close();
  });

  it.each([
    ['an empty object', {}],
    ['nested objects', { versions: { node: '22.12.0', pnpm: '9' } }],
    ['nested arrays', { tags: ['ios', 'release'] }],
    ['null values inside', { commit: null, branch: 'main' }],
    ['mixed types inside', { count: 3, enabled: true, name: 'x', extra: null }],
  ])('accepts a snapshot with %s', async (_label, snapshot) => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'POST',
      url: `/v1/projects/${PROJECT_ID}/environments`,
      payload: { snapshot },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json<{ snapshot: unknown }>().snapshot).toEqual(snapshot);

    await app.close();
  });

  it.each([
    ['an array', []],
    ['a populated array', [{ os: 'linux' }]],
    ['a string', 'macOS'],
    ['a number', 1],
    ['a boolean', true],
    ['null', null],
  ])('refuses a top-level snapshot that is %s', async (_label, snapshot) => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'POST',
      url: `/v1/projects/${PROJECT_ID}/environments`,
      payload: { snapshot },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    // Stopped at the HTTP boundary, so the domain converter never sees it.
    expect(calls.createEnvironment).toBeUndefined();

    await app.close();
  });

  it.each([
    ['a missing snapshot', {}],
    ['a project_id in the body', { snapshot: {}, project_id: PROJECT_ID }],
    ['an owner_id in the body', { snapshot: {}, owner_id: OWNER_ID }],
    ['an environment_id in the body', { snapshot: {}, environment_id: ENVIRONMENT_ID }],
    ['an unknown field', { snapshot: {}, surprise: 1 }],
  ])('refuses %s', async (_label, payload) => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'POST',
      url: `/v1/projects/${PROJECT_ID}/environments`,
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(calls.createEnvironment).toBeUndefined();

    await app.close();
  });
});

describe('GET /v1/projects/:project_id/environments', () => {
  it('lists the project’s environments', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'GET',
      url: `/v1/projects/${PROJECT_ID}/environments`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ environments: unknown[] }>().environments).toHaveLength(1);
    expect(calls.listEnvironments).toBe(PROJECT_ID);

    await app.close();
  });

  it('returns an empty list for a project with none', async () => {
    const app = buildApp({ ...serviceRecording({}), listEnvironments: () => Promise.resolve([]) });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/projects/${PROJECT_ID}/environments`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ environments: [] });

    await app.close();
  });
});

describe('GET /v1/environments/:environment_id', () => {
  it('returns the environment', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'GET',
      url: `/v1/environments/${ENVIRONMENT_ID}`,
    });

    expect(response.statusCode).toBe(200);
    expect(calls.getEnvironment).toBe(ENVIRONMENT_ID);

    await app.close();
  });

  it('refuses a malformed id', async () => {
    const app = buildApp(serviceRecording({}));

    const response = await app.inject({ method: 'GET', url: '/v1/environments/not-a-uuid' });

    expect(response.statusCode).toBe(400);

    await app.close();
  });
});

describe('routes that do not exist', () => {
  it.each([
    ['DELETE', `/v1/projects/${PROJECT_ID}`],
    ['DELETE', `/v1/environments/${ENVIRONMENT_ID}`],
    ['PATCH', `/v1/environments/${ENVIRONMENT_ID}`],
    ['PUT', `/v1/environments/${ENVIRONMENT_ID}`],
  ])('%s %s is not served', async (method, url) => {
    const app = buildApp(serviceRecording({}));

    const response = await app.inject({
      method: method as 'DELETE' | 'PATCH' | 'PUT',
      url,
      payload: {},
    });

    // Environments are a point in time and nothing is deleted in this phase.
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    await app.close();
  });

  it.each([
    '/projects',
    '/v2/projects',
    // Problems live under a project; there is no unscoped collection.
    '/v1/problems',
    `/v1/environments/${ENVIRONMENT_ID}/events`,
  ])('%s is not served', async (url) => {
    const app = buildApp(serviceRecording({}));

    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(404);

    await app.close();
  });
});
