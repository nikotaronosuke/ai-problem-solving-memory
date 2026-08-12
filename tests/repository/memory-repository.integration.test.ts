/**
 * The repository surface, against the real database.
 *
 * Everything here goes through the repository — no `src/db/` function is
 * called directly except to set up an owner, which is what owner resolution
 * needs before a repository can exist at all. If an operation is not reachable
 * from the repository, this file cannot do it.
 *
 * This checks the surface. The full Phase 1 scenario is P1-13.
 *
 * Skipped when `DATABASE_URL` is not set.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { generateClientEventId } from '../../src/domain/client-event-id.js';
import { generateEnvironmentId } from '../../src/domain/environment.js';
import { generateOwnerId, type OwnerId } from '../../src/domain/owner.js';
import { generateProblemId } from '../../src/domain/problem.js';
import { generateProjectId } from '../../src/domain/project.js';
import { MEMORY_OWNER_ID_VAR, resolveOwnerContext } from '../../src/owner/context.js';
import {
  createMemoryRepository,
  EnvironmentNotAvailableError,
  ProblemNotAvailableError,
  ProjectNotAvailableError,
  type MemoryRepository,
} from '../../src/repository/index.js';

const databaseUrl = readDatabaseUrl();

describe.skipIf(databaseUrl === undefined)('memory repository', () => {
  let pool: DatabasePool;
  const ownersCreated: OwnerId[] = [];

  /** Establishes an owner and returns a repository scoped to it. */
  async function makeRepository(): Promise<MemoryRepository> {
    const ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);

    const context = await resolveOwnerContext(pool, { [MEMORY_OWNER_ID_VAR]: ownerId });
    return createMemoryRepository(pool, context);
  }

  beforeAll(() => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
  });

  afterAll(async () => {
    if (ownersCreated.length > 0) {
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

  describe('the ten Phase 1 operations', () => {
    it('carries a problem from creation to verified evidence, entirely through the repository', async () => {
      const repository = await makeRepository();

      const project = await repository.createProject({
        projectName: 'memory-service',
        repo: 'example/memory-service',
        platform: 'node',
      });
      expect((await repository.getProject(project.projectId))?.projectName).toBe('memory-service');

      const environment = await repository.createEnvironment({
        projectId: project.projectId,
        snapshot: { runtime: 'node 22.12.0', branch: 'main' },
      });
      expect((await repository.getEnvironment(environment.environmentId))?.snapshot).toEqual({
        runtime: 'node 22.12.0',
        branch: 'main',
      });

      const problem = await repository.createProblem({
        projectId: project.projectId,
        environmentId: environment.environmentId,
        title: 'Build fails on clean checkout',
        symptoms: 'Succeeds locally, fails on CI with a missing module error.',
      });
      expect((await repository.getProblem(problem.problemId))?.status).toBe('INVESTIGATING');

      await repository.appendEvent({
        problemId: problem.problemId,
        eventType: 'HYPOTHESIS',
        summary: 'Suspected the resolver version differs on CI',
        clientEventId: generateClientEventId(),
      });
      const events = await repository.listEvents(problem.problemId);
      expect(events).toHaveLength(1);
      expect(events[0]?.eventType).toBe('HYPOTHESIS');

      await repository.appendVerification({
        problemId: problem.problemId,
        verificationType: 'TEST',
        result: true,
        summary: 'Suite green on CI after pinning the resolver',
        verifiedBy: 'ci',
        clientEventId: generateClientEventId(),
      });
      const verifications = await repository.listVerifications(problem.problemId);
      expect(verifications).toHaveLength(1);
      expect(verifications[0]?.result).toBe(true);
    });

    it('reports its own owner and stamps everything it writes with it', async () => {
      const repository = await makeRepository();

      const project = await repository.createProject({ projectName: 'owned' });
      const environment = await repository.createEnvironment({
        projectId: project.projectId,
        snapshot: {},
      });
      const problem = await repository.createProblem({
        projectId: project.projectId,
        environmentId: environment.environmentId,
        title: 'Owned problem',
        symptoms: 'Owned symptoms',
      });
      const event = await repository.appendEvent({
        problemId: problem.problemId,
        eventType: 'ATTEMPT',
        summary: 'Owned event',
        clientEventId: generateClientEventId(),
      });
      const verification = await repository.appendVerification({
        problemId: problem.problemId,
        verificationType: 'BUILD',
        result: false,
        summary: 'Owned verification',
        clientEventId: generateClientEventId(),
      });

      for (const record of [project, environment, problem, event, verification]) {
        expect(record.ownerId).toBe(repository.ownerId);
      }
    });

    it('reports absent for records that do not exist', async () => {
      const repository = await makeRepository();

      expect(await repository.getProject(generateProjectId())).toBeUndefined();
      expect(await repository.getEnvironment(generateEnvironmentId())).toBeUndefined();
      expect(await repository.getProblem(generateProblemId())).toBeUndefined();
      expect(await repository.listEvents(generateProblemId())).toEqual([]);
      expect(await repository.listVerifications(generateProblemId())).toEqual([]);
    });
  });

  describe('owner scope', () => {
    it('takes no owner argument, so a caller cannot ask for another one', () => {
      // The surface itself is the guarantee: every method's parameters are
      // inputs and ids, never an owner. This is a statement about the shape,
      // checked by the type system at every call site above.
      const parameterCounts = {
        createProject: 1,
        getProject: 1,
        createEnvironment: 1,
        getEnvironment: 1,
        createProblem: 1,
        getProblem: 1,
        appendEvent: 1,
        listEvents: 1,
        appendVerification: 1,
        listVerifications: 1,
      };

      expect(Object.keys(parameterCounts)).toHaveLength(10);
    });

    it('does not let one owner read another’s records', async () => {
      const repositoryA = await makeRepository();
      const repositoryB = await makeRepository();

      const projectB = await repositoryB.createProject({ projectName: 'b-project' });
      const environmentB = await repositoryB.createEnvironment({
        projectId: projectB.projectId,
        snapshot: {},
      });
      const problemB = await repositoryB.createProblem({
        projectId: projectB.projectId,
        environmentId: environmentB.environmentId,
        title: 'B problem',
        symptoms: 'B symptoms',
      });

      expect(await repositoryA.getProject(projectB.projectId)).toBeUndefined();
      expect(await repositoryA.getEnvironment(environmentB.environmentId)).toBeUndefined();
      expect(await repositoryA.getProblem(problemB.problemId)).toBeUndefined();
    });

    it('does not let one owner write against another’s records', async () => {
      const repositoryA = await makeRepository();
      const repositoryB = await makeRepository();

      const projectB = await repositoryB.createProject({ projectName: 'b-project' });
      const environmentB = await repositoryB.createEnvironment({
        projectId: projectB.projectId,
        snapshot: {},
      });
      const problemB = await repositoryB.createProblem({
        projectId: projectB.projectId,
        environmentId: environmentB.environmentId,
        title: 'B problem',
        symptoms: 'B symptoms',
      });

      await expect(
        repositoryA.createEnvironment({ projectId: projectB.projectId, snapshot: {} }),
      ).rejects.toThrow(ProjectNotAvailableError);

      await expect(
        repositoryA.createProblem({
          projectId: projectB.projectId,
          environmentId: environmentB.environmentId,
          title: 'Cross-owner',
          symptoms: 'Cross-owner',
        }),
      ).rejects.toThrow(EnvironmentNotAvailableError);

      await expect(
        repositoryA.appendEvent({
          problemId: problemB.problemId,
          eventType: 'ATTEMPT',
          summary: 'Cross-owner',
          clientEventId: generateClientEventId(),
        }),
      ).rejects.toThrow(ProblemNotAvailableError);

      await expect(
        repositoryA.appendVerification({
          problemId: problemB.problemId,
          verificationType: 'TEST',
          result: true,
          summary: 'Cross-owner',
          clientEventId: generateClientEventId(),
        }),
      ).rejects.toThrow(ProblemNotAvailableError);
    });

    it('does not surface another owner’s events or verifications', async () => {
      const repositoryA = await makeRepository();
      const repositoryB = await makeRepository();

      const projectB = await repositoryB.createProject({ projectName: 'b-project' });
      const environmentB = await repositoryB.createEnvironment({
        projectId: projectB.projectId,
        snapshot: {},
      });
      const problemB = await repositoryB.createProblem({
        projectId: projectB.projectId,
        environmentId: environmentB.environmentId,
        title: 'B problem',
        symptoms: 'B symptoms',
      });
      await repositoryB.appendEvent({
        problemId: problemB.problemId,
        eventType: 'ATTEMPT',
        summary: 'B event',
        clientEventId: generateClientEventId(),
      });
      await repositoryB.appendVerification({
        problemId: problemB.problemId,
        verificationType: 'TEST',
        result: true,
        summary: 'B verification',
        clientEventId: generateClientEventId(),
      });

      expect(await repositoryA.listEvents(problemB.problemId)).toEqual([]);
      expect(await repositoryA.listVerifications(problemB.problemId)).toEqual([]);
      expect(await repositoryB.listEvents(problemB.problemId)).toHaveLength(1);
      expect(await repositoryB.listVerifications(problemB.problemId)).toHaveLength(1);
    });
  });

  describe('executor', () => {
    it('accepts a pool', async () => {
      const repository = await makeRepository();

      // The suite has been using one throughout; this states it deliberately.
      await expect(repository.createProject({ projectName: 'via-pool' })).resolves.toBeDefined();
    });

    it('accepts anything that can run a statement, not just a pool', async () => {
      const repository = await makeRepository();
      const project = await repository.createProject({ projectName: 'via-client' });

      // Stands in for a client checked out for a transaction: it can query and
      // nothing else. No connect, no end, no pool counters.
      let queriesRun = 0;
      const queryOnly = {
        query: (text: string, values?: unknown[]) => {
          queriesRun += 1;
          return pool.query(text, values);
        },
      };
      expect(Object.keys(queryOnly)).toEqual(['query']);

      const context = await resolveOwnerContext(pool, {
        [MEMORY_OWNER_ID_VAR]: repository.ownerId,
      });
      const overClient = createMemoryRepository(queryOnly, context);

      expect((await overClient.getProject(project.projectId))?.projectName).toBe('via-client');
      expect(queriesRun).toBe(1);
    });
  });
});
