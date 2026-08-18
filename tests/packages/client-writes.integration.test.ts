/**
 * The two write methods, driven all the way down to PostgreSQL.
 *
 * The client's own suite drives it against fixtures and the routes' suites
 * drive the routes against fixtures. Both pass if both fixtures share the same
 * misunderstanding, which is the failure a mirrored contract is most prone to —
 * and for a write it is the expensive one, because what a read gets wrong can
 * be asked again while what a write gets wrong is stored.
 *
 * So there are no fixtures in the middle here. A real `MemoryApiClient` whose
 * `fetch` reaches a real `buildMemoryHttpApp`, the real routes and their real
 * schemas, the real services, the real repository, a real database. If the
 * client's idea of what an Environment or a Problem is has drifted from the
 * server's, it fails here rather than the first time somebody starts a Problem.
 *
 * Skipped when `DATABASE_URL` is not set, like every other integration suite.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  createMemoryApiClient,
  MemoryApiError,
  type FetchLike,
  type MemoryApiClient,
} from '@ai-problem-solving-memory/api-client';

import {
  registerProject,
  resolveProject,
  startProblem,
  type ProjectSignals,
} from '@ai-problem-solving-memory/claude-code-adapter';

import {
  createChangeLogService,
  createEventService,
  createExportService,
  createHealthService,
  createMemoryControlService,
  createProblemCloseService,
  createProblemDeleteService,
  createProblemService,
  createProblemStatusService,
  createProjectEnvironmentService,
  createRelationService,
  createUsageLogService,
  createVerificationService,
} from '../../src/app/index.js';
import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { generateOwnerId, type OwnerId } from '../../src/domain/owner.js';
import { buildMemoryHttpApp } from '../../src/http/index.js';
import { createFixedRequestContextService } from '../support/request-context.js';
import { createUnusedSearchResolver } from '../support/search-resolver.js';

const databaseUrl = readDatabaseUrl();

/** Synthetic. The fixed context service authenticates nothing. */
const CREDENTIAL = 'memory_test_0000000000000000000000000000';

/**
 * A `fetch` that delivers to a Fastify instance instead of a socket.
 *
 * The client builds the URL, the method, the headers and the body exactly as it
 * would for a real server; this only carries them. Anything the client got
 * wrong about the wire fails inside the route's own validation.
 */
function bridgeTo(app: FastifyInstance): FetchLike {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const injected = await app.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST',
      url: new URL(url).pathname,
      headers: init?.headers as Record<string, string>,
      ...(typeof init?.body === 'string' ? { payload: init.body } : {}),
    });

    return new Response(injected.body, {
      status: injected.statusCode,
      headers: { 'content-type': injected.headers['content-type'] as string },
    });
  };
}

describe.skipIf(databaseUrl === undefined)('the client writing through the real routes', () => {
  let pool: DatabasePool;
  let app: FastifyInstance;
  let memory: MemoryApiClient;
  let ownerId: OwnerId;

  beforeAll(async () => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
    ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);

    app = buildMemoryHttpApp({
      retrievalSearchResolver: createUnusedSearchResolver(),
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
    await app.ready();

    memory = createMemoryApiClient({ credential: CREDENTIAL, fetch: bridgeTo(app) });
  });

  afterAll(async () => {
    await app?.close();
    await closePool(pool);
  });

  /**
   * A Project to write under.
   *
   * Created through the route rather than through the client, deliberately:
   * these tests are about what the client sends, and building the Project with
   * the same client would let one shared misunderstanding satisfy both halves.
   */
  async function makeProject(name: string): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { authorization: `Bearer ${CREDENTIAL}` },
      payload: { project_name: name },
    });
    expect(created.statusCode).toBe(201);
    return (JSON.parse(created.body) as { project_id: string }).project_id;
  }

  /** Signals for a session in a repository nothing has recorded yet. */
  function signalsFor(remote: string, subpath: string | null): ProjectSignals {
    return {
      projectNameHint: remote.split('/').pop() ?? 'project',
      insideGit: true,
      primaryRemote: remote,
      secondaryRemotes: [],
      monorepoSubpath: subpath,
    };
  }

  describe('creating a Project across the real wire', () => {
    it('creates one covering a whole repository', async () => {
      const created = await memory.createProject({
        project_name: 'write-path-root',
        repo: 'github.com/acme/write-path-root',
      });

      expect(created.owner_id).toBe(ownerId);
      expect(created.repo).toBe('github.com/acme/write-path-root');
      expect(created.repo_subpath).toBeNull();
    });

    it('creates one covering a part of a repository', async () => {
      const created = await memory.createProject({
        project_name: 'write-path-part',
        repo: 'github.com/acme/write-path-part',
        repo_subpath: 'apps/web',
      });

      expect(created.repo_subpath).toBe('apps/web');
    });

    it('accepts the fields the server normalises on the way in', async () => {
      // The server trims a name and empties blank text to null. The client
      // deliberately does not demand raw equality for those, and this is where
      // that would show up as a false protocol failure if it did.
      const created = await memory.createProject({
        project_name: '  write-path-normalised  ',
        repo: '   ',
        platform: '',
      });

      expect(created.project_name).toBe('write-path-normalised');
      expect(created.repo).toBeNull();
      expect(created.platform).toBeNull();
    });

    it('reports a boundary the server refuses as a refusal, not a client argument error', async () => {
      // The rule lives on the server; the client sends what is structurally
      // valid and lets the server answer for its own rule.
      const raised = await memory
        .createProject({ project_name: 'write-path-bad', repo_subpath: '../escape' })
        .catch((error: unknown) => error);

      expect(raised).toBeInstanceOf(MemoryApiError);
      expect((raised as MemoryApiError).code).toBe('INVALID_REQUEST');
    });
  });

  describe('registering a Project through the adapter', () => {
    it('creates one for an unrecorded repository, and the resolver then finds it', async () => {
      const remote = 'github.com/acme/register-root';
      const signals = signalsFor(remote, null);

      const result = await registerProject(memory, signals);

      expect(result).toMatchObject({ kind: 'CREATED' });
      // The proof that matters: the same signals now resolve to it, through the
      // real list and the real resolver.
      await expect(resolveProject(memory, signals)).resolves.toEqual({
        kind: 'RESOLVED',
        projectId: (result as { projectId: string }).projectId,
      });
    });

    it('does not create a second one when the repository already resolves', async () => {
      const remote = 'github.com/acme/register-twice';
      const signals = signalsFor(remote, null);

      const first = await registerProject(memory, signals);
      const second = await registerProject(memory, signals);

      expect(first).toMatchObject({ kind: 'CREATED' });
      expect(second).toEqual({
        kind: 'RESOLVED',
        projectId: (first as { projectId: string }).projectId,
      });
    });

    it('persists a chosen boundary that the resolver then uses to tell parts apart', async () => {
      // The whole point of the boundary, end to end: two Projects on one
      // repository, both registered through the adapter, and a session in each
      // resolving to its own — against real routes and a real database.
      const remote = 'github.com/acme/register-monorepo';

      const web = await registerProject(memory, signalsFor(remote, 'apps/web'), {
        kind: 'REPOSITORY_BOUNDARY',
        repoSubpath: 'apps/web',
      });
      // The second part is the one that had no path before. The repository is
      // recorded by then and no stored boundary covers this session, so the
      // resolver asks — and this is the owner answering.
      const api = await registerProject(memory, signalsFor(remote, 'apps/api'), {
        kind: 'REPOSITORY_BOUNDARY',
        repoSubpath: 'apps/api',
      });

      expect(web).toMatchObject({ kind: 'CREATED' });
      expect(api).toMatchObject({ kind: 'CREATED' });

      await expect(resolveProject(memory, signalsFor(remote, 'apps/web/client'))).resolves.toEqual({
        kind: 'RESOLVED',
        projectId: (web as { projectId: string }).projectId,
      });
      await expect(resolveProject(memory, signalsFor(remote, 'apps/api/client'))).resolves.toEqual({
        kind: 'RESOLVED',
        projectId: (api as { projectId: string }).projectId,
      });
    });

    it('still asks before registering a second part nobody has decided on', async () => {
      // The default has not moved. Without an explicit answer the question is
      // still the answer, and no Project is created out of a directory layout.
      const remote = 'github.com/acme/register-sibling-unanswered';

      await registerProject(memory, signalsFor(remote, 'apps/web'), {
        kind: 'REPOSITORY_BOUNDARY',
        repoSubpath: 'apps/web',
      });

      const before = await memory.listProjects();
      const second = await registerProject(memory, signalsFor(remote, 'apps/api'));
      const after = await memory.listProjects();

      expect(second).toMatchObject({
        kind: 'AMBIGUOUS',
        reason: 'NO_MATCHING_REPO_BOUNDARY',
      });
      expect(after.length).toBe(before.length);
    });

    it('registers the whole repository without flattening a part somebody split', async () => {
      // A root Project alongside a deeper one is not a contradiction: the
      // most specific covering boundary still wins, so `apps/web` keeps its
      // sessions and the root takes everything else.
      const remote = 'github.com/acme/register-root-beside-part';

      const web = await registerProject(memory, signalsFor(remote, 'apps/web'), {
        kind: 'REPOSITORY_BOUNDARY',
        repoSubpath: 'apps/web',
      });
      const root = await registerProject(memory, signalsFor(remote, null), {
        kind: 'REPOSITORY_ROOT',
      });

      expect(root).toMatchObject({ kind: 'CREATED' });

      await expect(resolveProject(memory, signalsFor(remote, null))).resolves.toEqual({
        kind: 'RESOLVED',
        projectId: (root as { projectId: string }).projectId,
      });
      await expect(resolveProject(memory, signalsFor(remote, 'apps/web'))).resolves.toEqual({
        kind: 'RESOLVED',
        projectId: (web as { projectId: string }).projectId,
      });
    });

    it('registers an ancestor of where the session is, when that is the answer', async () => {
      const remote = 'github.com/acme/register-ancestor';

      await registerProject(memory, signalsFor(remote, 'apps/web'), {
        kind: 'REPOSITORY_BOUNDARY',
        repoSubpath: 'apps/web',
      });
      const services = await registerProject(memory, signalsFor(remote, 'services/api/client'), {
        kind: 'REPOSITORY_BOUNDARY',
        repoSubpath: 'services',
      });

      expect(services).toMatchObject({ kind: 'CREATED' });
      // Explicitly chosen, not inferred from the directory the session is in.
      await expect(
        resolveProject(memory, signalsFor(remote, 'services/api/client')),
      ).resolves.toEqual({
        kind: 'RESOLVED',
        projectId: (services as { projectId: string }).projectId,
      });
    });

    it('asks rather than guessing when the session is inside a subdirectory', async () => {
      const result = await registerProject(
        memory,
        signalsFor('github.com/acme/register-asks', 'apps/web'),
      );

      expect(result).toMatchObject({ kind: 'BOUNDARY_REQUIRED' });
    });
  });

  it('records an Environment the server stores and returns whole', async () => {
    const projectId = await makeProject('write-path-environment');
    const snapshot = {
      branch: 'feature/cache',
      commit: '0f1e2d3c4b5a69788796a5b4c3d2e1f009182736',
      attempts: 3,
      dirty: false,
      nested: { versions: ['1', '2'], absent: null },
    };

    const environment = await memory.createEnvironment(projectId, { snapshot });

    expect(environment.project_id).toBe(projectId);
    expect(environment.owner_id).toBe(ownerId);
    // The whole snapshot, through JSON, through the route's schema, through
    // the column, and back — unchanged.
    expect(environment.snapshot).toEqual(snapshot);
    expect(typeof environment.created_at).toBe('string');
  });

  it('starts a Problem attached to that Environment, with the fields it was given', async () => {
    const projectId = await makeProject('write-path-problem');
    const environment = await memory.createEnvironment(projectId, { snapshot: { branch: 'main' } });

    const problem = await memory.createProblem(projectId, {
      environment_id: environment.environment_id,
      title: 'the build fails only on the second run',
      symptoms: 'a cached artifact is reused after it should have been invalidated',
      problem_domain: 'build',
      suspected_boundary: 'cache',
      source_ai: 'some-assistant',
    });

    expect(problem.project_id).toBe(projectId);
    expect(problem.environment_id).toBe(environment.environment_id);
    expect(problem.title).toBe('the build fails only on the second run');
    expect(problem.symptoms).toBe(
      'a cached artifact is reused after it should have been invalidated',
    );
    expect(problem.problem_domain).toBe('build');
    expect(problem.suspected_boundary).toBe('cache');
    expect(problem.source_ai).toBe('some-assistant');
    // The server owns these, and a caller cannot declare them.
    expect(problem.status).toBe('INVESTIGATING');
    expect(problem.version).toBe(1);
    expect(problem.fix_kind).toBeNull();
  });

  it('leaves an optional field null when it was never sent', async () => {
    const projectId = await makeProject('write-path-minimal');
    const environment = await memory.createEnvironment(projectId, { snapshot: {} });

    const problem = await memory.createProblem(projectId, {
      environment_id: environment.environment_id,
      title: 'a minimal problem',
      symptoms: 'something happened',
    });

    expect(problem.problem_domain).toBeNull();
    expect(problem.suspected_boundary).toBeNull();
    expect(problem.source_ai).toBeNull();
  });

  it('refuses a Problem against an Environment from a different Project', async () => {
    const [here, elsewhere] = await Promise.all([
      makeProject('write-path-here'),
      makeProject('write-path-elsewhere'),
    ]);
    const foreign = await memory.createEnvironment(elsewhere, { snapshot: {} });

    // The server enforces this, and the point of exercising it across the real
    // wire is that the client reports the refusal as one rather than as a
    // protocol failure of its own.
    await expect(
      memory.createProblem(here, {
        environment_id: foreign.environment_id,
        title: 'a problem in the wrong place',
        symptoms: 'the environment belongs to another project',
      }),
    ).rejects.toBeInstanceOf(MemoryApiError);
  });

  it('refuses a Project that is not this owner’s as NOT_FOUND', async () => {
    const raised = await memory
      .createEnvironment('7c9e6679-7425-40de-944b-e07fc1f90ae7', { snapshot: {} })
      .catch((error: unknown) => error);

    expect(raised).toBeInstanceOf(MemoryApiError);
    expect((raised as MemoryApiError).code).toBe('NOT_FOUND');
  });

  it('starts a Problem end to end through the adapter, stamped as this assistant', async () => {
    // The whole c1 path: capture, record the conditions, start the Problem —
    // against the real routes. `source_ai` is the one field the adapter owns,
    // and this is where "the adapter sets it" stops being a unit-test claim.
    const projectId = await makeProject('write-path-adapter');

    const started = await startProblem(memory, {
      projectId,
      projectDir: process.cwd(),
      title: 'a problem started through the adapter',
      symptoms: 'the adapter captured the conditions and recorded them first',
    });

    expect(Object.keys(started).sort()).toEqual(['problemId', 'status']);
    expect(started.status).toBe('INVESTIGATING');

    const stored = await memory.getProblem(started.problemId);
    expect(stored.project_id).toBe(projectId);
    expect(stored.source_ai).toBe('claude-code');
    // The conditions were recorded before the Problem and it points at them.
    expect(stored.environment_id).not.toBe('');
  });
});
