/**
 * Entering a Problem, driven all the way down to PostgreSQL and to real files.
 *
 * The composition's own suite drives it against doubles, and doubles agree with
 * whatever they were written to agree with. What cannot be checked that way is
 * whether the client's idea of a transition matches the route's, whether a
 * version read from one call is the one the next call needs, and whether a
 * binding written under one Project is really invisible under another — three
 * things that are only true if two independently written halves happen to line
 * up.
 *
 * So: a real client over the real routes over a real database, and a real
 * binding store over a real temporary directory. Nothing is asked of anybody;
 * every decision a person would make is supplied as an argument.
 *
 * Skipped when `DATABASE_URL` is not set, like every other integration suite.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  createMemoryApiClient,
  type FetchLike,
  type MemoryApiClient,
} from '@ai-problem-solving-memory/api-client';

import {
  continueProblem,
  createProblemBindingStore,
  resolveProblemForSession,
  resumeProblem,
  startNewProblem,
  type ProblemBindingStore,
  type StartProblemInput,
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

const COMMIT = '0f1e2d3c4b5a69788796a5b4c3d2e1f009182736';

/** Deterministic conditions, so no test depends on this checkout. */
const GIT = (args: readonly string[]) =>
  Promise.resolve(
    args.join(' ') === 'branch --show-current'
      ? { ok: true, stdout: 'main' }
      : args.join(' ') === 'rev-parse HEAD'
        ? { ok: true, stdout: COMMIT }
        : { ok: false, stdout: '' },
  );

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

describe.skipIf(databaseUrl === undefined)('entering a Problem, end to end', () => {
  let pool: DatabasePool;
  let app: FastifyInstance;
  let memory: MemoryApiClient;
  let bindings: ProblemBindingStore;
  let directory: string;
  let ownerId: OwnerId;
  let sessions = 0;

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
    directory = await mkdtemp(join(tmpdir(), 'lifecycle-'));
    bindings = createProblemBindingStore({ directory });
  });

  afterAll(async () => {
    await app?.close();
    await closePool(pool);
    await rm(directory, { recursive: true, force: true });
  });

  /** A distinct session per test, so none of them can lean on another's note. */
  function session(): string {
    sessions += 1;
    return `session-${String(sessions).padStart(4, '0')}`;
  }

  async function makeProject(name: string): Promise<string> {
    const project = await memory.createProject({ project_name: name });
    return project.project_id;
  }

  function startInput(projectId: string, title: string): StartProblemInput {
    return {
      projectId,
      projectDir: directory,
      title,
      symptoms: 'the second run serves an artifact the first run should have invalidated',
      runGit: GIT,
    };
  }

  /** Moves a Problem to PAUSED through the real status API. */
  async function pause(problemId: string, version: number): Promise<void> {
    const paused = await memory.transitionProblemStatus(problemId, {
      target_status: 'PAUSED',
      expected_version: version,
      changed_by: 'integration-test',
    });
    expect(paused.status).toBe('PAUSED');
  }

  it('starts the first Problem under a Project, and remembers it', async () => {
    const projectId = await makeProject('lifecycle-first');
    const sessionId = session();

    const started = await startNewProblem(
      memory,
      bindings,
      sessionId,
      startInput(projectId, 'the build fails only on the second run'),
    );

    expect(started).toMatchObject({ kind: 'STARTED', status: 'INVESTIGATING' });
    expect((started as { continuity: string }).continuity).toBe('PERSISTED');

    // The Environment was recorded too — the Problem could not exist without
    // one, and this is the only place both halves are checked against a real
    // schema.
    const problem = await memory.getProblem((started as { problemId: string }).problemId);
    expect(problem.environment_id).toEqual(expect.any(String));
    expect(problem.source_ai).toBe('claude-code');
  });

  it('finds the same Problem again from the note it wrote', async () => {
    const projectId = await makeProject('lifecycle-remembered');
    const sessionId = session();

    const started = await startNewProblem(
      memory,
      bindings,
      sessionId,
      startInput(projectId, 'the same Problem, a turn later'),
    );
    const problemId = (started as { problemId: string }).problemId;

    await expect(resolveProblemForSession(memory, bindings, sessionId, projectId)).resolves.toEqual(
      { kind: 'RESOLVED', problemId },
    );
  });

  it('records a working Problem the session chose to carry on with', async () => {
    const projectId = await makeProject('lifecycle-continued');
    const chooser = session();
    const started = await startNewProblem(
      memory,
      bindings,
      chooser,
      startInput(projectId, 'a Problem another session will pick up'),
    );
    const problemId = (started as { problemId: string }).problemId;

    // A different session, with no note of its own, choosing that Problem.
    const sessionId = session();
    await expect(
      continueProblem(memory, bindings, sessionId, projectId, problemId),
    ).resolves.toEqual({ kind: 'CONTINUED', problemId, continuity: 'PERSISTED' });

    await expect(resolveProblemForSession(memory, bindings, sessionId, projectId)).resolves.toEqual(
      { kind: 'RESOLVED', problemId },
    );
  });

  it('resumes a paused Problem into INVESTIGATING', async () => {
    const projectId = await makeProject('lifecycle-resume-investigating');
    const started = await startNewProblem(
      memory,
      bindings,
      session(),
      startInput(projectId, 'a Problem that gets paused'),
    );
    const problemId = (started as { problemId: string }).problemId;
    const problem = await memory.getProblem(problemId);
    await pause(problemId, problem.version);

    const sessionId = session();
    await expect(
      resumeProblem(memory, bindings, sessionId, projectId, problemId, 'INVESTIGATING'),
    ).resolves.toEqual({
      kind: 'RESUMED',
      problemId,
      status: 'INVESTIGATING',
      continuity: 'PERSISTED',
    });

    // The record moved, and the note now resolves — a paused Problem would not.
    await expect(memory.getProblem(problemId)).resolves.toMatchObject({
      status: 'INVESTIGATING',
    });
    await expect(resolveProblemForSession(memory, bindings, sessionId, projectId)).resolves.toEqual(
      { kind: 'RESOLVED', problemId },
    );
  });

  it('resumes a paused Problem into FIX_CANDIDATE', async () => {
    const projectId = await makeProject('lifecycle-resume-fix');
    const started = await startNewProblem(
      memory,
      bindings,
      session(),
      startInput(projectId, 'a Problem resumed as a fix candidate'),
    );
    const problemId = (started as { problemId: string }).problemId;
    const problem = await memory.getProblem(problemId);
    await pause(problemId, problem.version);

    await expect(
      resumeProblem(memory, bindings, session(), projectId, problemId, 'FIX_CANDIDATE'),
    ).resolves.toMatchObject({ kind: 'RESUMED', status: 'FIX_CANDIDATE' });
    await expect(memory.getProblem(problemId)).resolves.toMatchObject({
      status: 'FIX_CANDIDATE',
    });
  });

  it('sends a caller back when work is open, and starts once they have seen it', async () => {
    const projectId = await makeProject('lifecycle-reconsider');
    const first = await startNewProblem(
      memory,
      bindings,
      session(),
      startInput(projectId, 'the Problem already open'),
    );
    const openProblemId = (first as { problemId: string }).problemId;

    const sessionId = session();
    const declined = await startNewProblem(
      memory,
      bindings,
      sessionId,
      startInput(projectId, 'something the caller thinks is new'),
    );

    expect(declined).toMatchObject({ kind: 'RECONSIDER', reason: 'CANDIDATES_PRESENT' });
    expect((declined as { candidates: readonly { problemId: string }[] }).candidates).toEqual([
      expect.objectContaining({ problemId: openProblemId }),
    ]);

    // Having considered it, the same caller may start the second Problem.
    const started = await startNewProblem(
      memory,
      bindings,
      sessionId,
      startInput(projectId, 'something the caller decided really is new'),
      [openProblemId],
    );

    expect(started).toMatchObject({ kind: 'STARTED', continuity: 'PERSISTED' });
    expect((started as { problemId: string }).problemId).not.toBe(openProblemId);
  });

  it('keeps one session’s Problems apart across two Projects', async () => {
    // The isolation the binding key exists for. One session, two Projects, and
    // a return to the first — with real files, where a key that ignored the
    // Project would have overwritten the first note.
    const projectA = await makeProject('lifecycle-isolation-a');
    const projectB = await makeProject('lifecycle-isolation-b');
    const sessionId = session();

    const inA = await startNewProblem(
      memory,
      bindings,
      sessionId,
      startInput(projectA, 'a Problem in the first Project'),
    );
    const inB = await startNewProblem(
      memory,
      bindings,
      sessionId,
      startInput(projectB, 'a Problem in the second Project'),
    );

    const problemInA = (inA as { problemId: string }).problemId;
    const problemInB = (inB as { problemId: string }).problemId;
    expect(problemInA).not.toBe(problemInB);

    await expect(resolveProblemForSession(memory, bindings, sessionId, projectA)).resolves.toEqual({
      kind: 'RESOLVED',
      problemId: problemInA,
    });
    await expect(resolveProblemForSession(memory, bindings, sessionId, projectB)).resolves.toEqual({
      kind: 'RESOLVED',
      problemId: problemInB,
    });
  });
});
