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
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  createMemoryApiClient,
  MemoryApiError,
  type FetchLike,
  type MemoryApiClient,
} from '@ai-problem-solving-memory/api-client';

import {
  addEventToCurrentProblem,
  addVerificationToCurrentProblem,
  closeCurrentProblem,
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

  it('records typed evidence and closes through the adapter, client, real HTTP and database', async () => {
    const repository = 'github.com/acme/current-problem-recording';
    const project = await memory.createProject({
      project_name: 'current-problem-recording',
      repo: repository,
    });
    const environment = await memory.createEnvironment(project.project_id, {
      snapshot: { branch: 'main', commit: COMMIT },
    });
    const created = await memory.createProblem(project.project_id, {
      environment_id: environment.environment_id,
      title: 'the regression survives the proposed fix',
      symptoms: 'the same failing case remains after the change',
    });
    const sessionId = session();
    await expect(
      bindings.writeBinding(sessionId, project.project_id, created.problem_id),
    ).resolves.toEqual({ kind: 'WRITTEN' });

    const detect = (args: readonly string[]) => {
      const answers: Record<string, string> = {
        'rev-parse --show-toplevel': directory,
        remote: 'origin',
        'remote get-url origin': repository,
      };
      const stdout = answers[args.join(' ')];
      return Promise.resolve(
        stdout === undefined ? { ok: false, stdout: '' } : { ok: true, stdout },
      );
    };
    const current = {
      client: memory,
      bindingStore: bindings,
      sessionId,
      projectDir: directory,
      runGit: detect,
    } as const;

    // A server-side redaction changes the returned summary. The client accepts
    // that resource without demanding an unsafe raw echo, and the adapter
    // returns identifiers only.
    const eventKey = randomUUID();
    const firstEvent = await addEventToCurrentProblem({
      ...current,
      eventType: 'DEAD_END',
      summary: 'the call sent API_KEY=fake-Qq1Vr7X-0123456789abcdef in staging and failed',
      clientEventId: eventKey,
      reason: 'the same failure reproduced after the attempt',
    });
    const retriedEvent = await addEventToCurrentProblem({
      ...current,
      eventType: 'DEAD_END',
      summary: 'a retry payload the first write must win over',
      clientEventId: eventKey,
    });
    expect(firstEvent).toMatchObject({
      kind: 'EVENT_RECORDED',
      problemId: created.problem_id,
      onCurrentProblem: true,
    });
    expect(retriedEvent).toEqual(firstEvent);

    const listedEvents = await app.inject({
      method: 'GET',
      url: `/v1/problems/${created.problem_id}/events`,
      headers: { authorization: `Bearer ${CREDENTIAL}` },
    });
    expect(listedEvents.statusCode).toBe(200);
    const matchingEvents = listedEvents
      .json<{ events: { client_event_id: string; summary: string; source_ai: string | null }[] }>()
      .events.filter((event) => event.client_event_id === eventKey);
    expect(matchingEvents).toHaveLength(1);
    expect(matchingEvents[0]).toMatchObject({
      client_event_id: eventKey,
      summary: 'the call sent API_KEY=[REDACTED] in staging and failed',
      source_ai: 'claude-code',
    });

    const failedVerification = await addVerificationToCurrentProblem({
      ...current,
      verificationType: 'TEST',
      result: false,
      summary: 'the regression still fails',
      clientEventId: randomUUID(),
    });
    expect(failedVerification).toMatchObject({
      kind: 'VERIFICATION_RECORDED',
      problemId: created.problem_id,
      onCurrentProblem: true,
    });

    const fixCandidate = await memory.transitionProblemStatus(created.problem_id, {
      target_status: 'FIX_CANDIDATE',
      expected_version: created.version,
      changed_by: 'integration-test',
    });
    await expect(
      closeCurrentProblem({ ...current, targetStatus: 'VERIFIED', fixKind: 'ROOT_FIX' }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(memory.getProblem(created.problem_id)).resolves.toMatchObject({
      status: 'FIX_CANDIDATE',
      version: fixCandidate.version,
    });

    await addVerificationToCurrentProblem({
      ...current,
      verificationType: 'TEST',
      result: true,
      summary: 'the regression suite now passes',
      clientEventId: randomUUID(),
      evidenceRef: 'test:regression-suite',
    });
    await expect(
      closeCurrentProblem({
        ...current,
        targetStatus: 'VERIFIED',
        fixKind: 'ROOT_FIX',
        effectiveDirection: 'corrected the invalidation boundary',
      }),
    ).resolves.toMatchObject({
      kind: 'PROBLEM_CLOSED',
      problemId: created.problem_id,
      status: 'VERIFIED',
      version: fixCandidate.version + 1,
    });

    // The binding is retained as a hint, but server revalidation makes the
    // terminal Problem non-current on the next call.
    await expect(
      addEventToCurrentProblem({
        ...current,
        eventType: 'DISCOVERY',
        summary: 'must not be appended to terminal current work',
        clientEventId: randomUUID(),
      }),
    ).resolves.toEqual({ kind: 'NO_CURRENT_PROBLEM' });

    // A second Problem pins the close route's compare-and-swap over the real
    // client: two callers reading one version cannot both conclude it.
    const racing = await memory.createProblem(project.project_id, {
      environment_id: environment.environment_id,
      title: 'two assistants conclude at once',
      symptoms: 'both decisions were made from the same version',
    });
    const racingCandidate = await memory.transitionProblemStatus(racing.problem_id, {
      target_status: 'FIX_CANDIDATE',
      expected_version: racing.version,
      changed_by: 'integration-test',
    });
    await memory.appendVerification(racing.problem_id, {
      verification_type: 'TEST',
      result: true,
      summary: 'the race fixture is verified',
      client_event_id: randomUUID(),
      verified_by: 'integration-test',
    });
    const closeRequest = {
      expected_version: racingCandidate.version,
      changed_by: 'integration-test',
      target_status: 'VERIFIED' as const,
      fix_kind: 'ROOT_FIX' as const,
    };
    const raced = await Promise.allSettled([
      memory.closeProblem(racing.problem_id, closeRequest),
      memory.closeProblem(racing.problem_id, closeRequest),
    ]);
    expect(raced.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const refusal = raced.find((result) => result.status === 'rejected');
    expect(refusal).toBeDefined();
    expect((refusal as PromiseRejectedResult).reason).toBeInstanceOf(MemoryApiError);
    expect(((refusal as PromiseRejectedResult).reason as MemoryApiError).code).toBe(
      'VERSION_CONFLICT',
    );

    // The endpoint owner boundary remains the last word even when the common
    // client knows a valid Problem id from somebody else.
    const otherOwner = generateOwnerId();
    await insertOwnerIfAbsent(pool, otherOwner);
    const otherApp = buildMemoryHttpApp({
      retrievalSearchResolver: createUnusedSearchResolver(),
      healthService: createHealthService(pool),
      requestContextService: createFixedRequestContextService(pool, otherOwner),
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
    await otherApp.ready();
    try {
      const otherMemory = createMemoryApiClient({
        credential: CREDENTIAL,
        fetch: bridgeTo(otherApp),
      });
      await expect(
        otherMemory.appendEvent(racing.problem_id, {
          event_type: 'ATTEMPT',
          summary: 'must not cross owners',
          client_event_id: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      await otherApp.close();
    }
  });
});
