/**
 * Entering a Problem — continuing, resuming, or starting a new one.
 *
 * Almost every assertion here is a negative one, because every way this can go
 * wrong is quiet. A binding written before the server agreed, a paused Problem
 * bound without being resumed, a local file failure reported as "no Problem",
 * a second Problem started for work already open — none of those throw, and all
 * of them are only visible later, in a Memory that describes an investigation
 * that never happened that way.
 *
 * The load-bearing one is the start-new recheck. Resolving *with* this
 * session's binding short-circuits on the Problem it is already on and never
 * enumerates the others — so a guard built on it would be blind to exactly the
 * Problem that should stop a new one being started. There is a test for that
 * specific arrangement below, and it is the reason the recheck passes no hint.
 */

import { describe, expect, it } from 'vitest';

import {
  MemoryApiError,
  MemoryApiProtocolError,
  MemoryApiUnreachableError,
  type ProblemResource,
  type ProblemStatus,
  type TransitionProblemStatusRequest,
} from '@ai-problem-solving-memory/api-client';

import {
  CLAUDE_CODE_SOURCE_AI,
  continueProblem,
  ProblemBindingArgumentError,
  ProblemLifecycleArgumentError,
  ProblemLifecycleInvariantError,
  RESUME_PROBLEM_TARGET_STATUSES,
  resolveProblemForSession,
  resumeProblem,
  startNewProblem,
  type GitRunner,
  type ProblemBindingRead,
  type ProblemBindingWrite,
  type ProblemBindingWriter,
  type ResumeProblemClient,
  type ResumeProblemTargetStatus,
  type StartNewProblemClient,
  type StartProblemInput,
} from '../src/index.js';

const SESSION_ID = 'session-0000-1111-2222';
const PROJECT_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_PROJECT_ID = '77777777-6666-4555-8444-333333333333';
const PROBLEM_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const OTHER_PROBLEM_ID = 'bbbbbbbb-1111-4222-8333-444444444444';
const ENVIRONMENT_ID = 'cccccccc-1111-4222-8333-444444444444';
const COMMIT = '0f1e2d3c4b5a69788796a5b4c3d2e1f009182736';

/** Synthetic. Stands in for anything that must not reach a result. */
const PLANTED = 'a-symptom-nobody-should-see-downstream';

const GIT: GitRunner = (args) =>
  Promise.resolve(
    args.join(' ') === 'branch --show-current'
      ? { ok: true, stdout: 'main' }
      : args.join(' ') === 'rev-parse HEAD'
        ? { ok: true, stdout: COMMIT }
        : { ok: false, stdout: '' },
  );

function problem(overrides: Partial<ProblemResource> = {}): ProblemResource {
  return {
    problem_id: PROBLEM_ID,
    owner_id: '99999999-8888-4777-8666-555555555555',
    project_id: PROJECT_ID,
    environment_id: ENVIRONMENT_ID,
    title: 'the build fails only on the second run',
    symptoms: PLANTED,
    problem_domain: null,
    suspected_boundary: null,
    source_ai: CLAUDE_CODE_SOURCE_AI,
    status: 'INVESTIGATING',
    fix_kind: null,
    importance: false,
    confidence: 'LOW',
    freshness: 'CURRENT',
    memory_read_enabled: true,
    memory_write_enabled: true,
    suppressed: false,
    version: 4,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

const GONE = new MemoryApiError(404, 'NOT_FOUND', 'req-0');

interface StoreLog {
  readonly order: string[];
  readonly reads: { sessionId: string; projectId: string }[];
  readonly writes: { sessionId: string; projectId: string; problemId: string }[];
}

/**
 * A binding store with the two methods this composition may use.
 *
 * It cannot offer `removeBinding` at all — the type it satisfies does not have
 * one — so a composition that grew a removal would not compile here rather than
 * quietly deleting somebody's place in their work.
 */
function store(options: {
  read?: ProblemBindingRead | Error;
  write?: ProblemBindingWrite | Error;
}): { store: ProblemBindingWriter; log: StoreLog } {
  const log: StoreLog = { order: [], reads: [], writes: [] };

  return {
    log,
    store: {
      readBinding(sessionId, projectId) {
        log.order.push('readBinding');
        log.reads.push({ sessionId, projectId });
        const answer = options.read ?? { kind: 'MISSING' };
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
      writeBinding(sessionId, projectId, problemId) {
        log.order.push('writeBinding');
        log.writes.push({ sessionId, projectId, problemId });
        const answer = options.write ?? { kind: 'WRITTEN' };
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
    },
  };
}

interface ClientLog {
  readonly order: string[];
  readonly gets: string[];
  readonly lists: string[];
  readonly transitions: { problemId: string; request: TransitionProblemStatusRequest }[];
  creates: number;
}

/**
 * A Memory whose answers are fixed and whose calls are recorded.
 *
 * Failures arrive as rejected promises rather than synchronous throws, because
 * that is the shape a real `async` method fails in — a double that threw
 * synchronously would let a composition that swallowed failures look correct.
 */
function client(answers: {
  get?: ProblemResource | Error;
  list?: readonly ProblemResource[] | Error;
  transition?: ProblemResource | Error;
  environment?: Error;
  problem?: ProblemResource | Error;
}): { client: ResumeProblemClient & StartNewProblemClient; log: ClientLog } {
  const log: ClientLog = { order: [], gets: [], lists: [], transitions: [], creates: 0 };

  const answer = <T>(value: T | Error | undefined, absent: string): Promise<T> => {
    if (value === undefined) {
      return Promise.reject(new Error(absent));
    }
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  };

  return {
    log,
    client: {
      getProblem(problemId) {
        log.order.push('getProblem');
        log.gets.push(problemId);
        return answer(answers.get, 'the test did not expect a Problem to be read');
      },
      listProblems(projectId) {
        log.order.push('listProblems');
        log.lists.push(projectId);
        return answer(answers.list, 'the test did not expect the Problems to be listed');
      },
      transitionProblemStatus(problemId, request) {
        log.order.push('transitionProblemStatus');
        log.transitions.push({ problemId, request });
        return answer(answers.transition, 'the test did not expect a transition');
      },
      createEnvironment(projectId) {
        log.order.push('createEnvironment');
        log.creates += 1;
        if (answers.environment !== undefined) {
          return Promise.reject(answers.environment);
        }
        return Promise.resolve({
          environment_id: ENVIRONMENT_ID,
          owner_id: '99999999-8888-4777-8666-555555555555',
          project_id: projectId,
          snapshot: { branch: 'main', commit: COMMIT },
          created_at: '2026-01-01T00:00:00.000Z',
        });
      },
      createProblem(projectId) {
        log.order.push('createProblem');
        return answer(
          answers.problem ?? problem({ project_id: projectId }),
          'the test did not expect a Problem to be created',
        );
      },
    },
  };
}

const START: StartProblemInput = {
  projectId: PROJECT_ID,
  projectDir: '/tmp/some-checkout',
  title: 'the build fails only on the second run',
  symptoms: 'a cached artifact is reused after it should have been invalidated',
  runGit: GIT,
};

describe('which Problem the session is on', () => {
  it('uses a valid binding as a hint, and resolves through it', async () => {
    const memory = client({ get: problem() });
    const bindings = store({
      read: { kind: 'VALID', binding: { projectId: PROJECT_ID, problemId: PROBLEM_ID } },
    });

    await expect(
      resolveProblemForSession(memory.client, bindings.store, SESSION_ID, PROJECT_ID),
    ).resolves.toEqual({ kind: 'RESOLVED', problemId: PROBLEM_ID });
    // The hint saved the enumeration; that is what a hint is for.
    expect(memory.log.order).toEqual(['getProblem']);
  });

  it('falls back to the server when a valid binding no longer holds', async () => {
    const memory = client({
      get: problem({ status: 'PAUSED' }),
      list: [problem({ status: 'PAUSED' })],
    });
    const bindings = store({
      read: { kind: 'VALID', binding: { projectId: PROJECT_ID, problemId: PROBLEM_ID } },
    });

    await expect(
      resolveProblemForSession(memory.client, bindings.store, SESSION_ID, PROJECT_ID),
    ).resolves.toMatchObject({ kind: 'CANDIDATES' });
  });

  it.each([
    ['MISSING', { kind: 'MISSING' } as const],
    ['UNREADABLE', { kind: 'UNREADABLE' } as const],
    ['IO_FAILURE', { kind: 'IO_FAILURE' } as const],
  ])('asks the server with no hint when the note is %s', async (_name, read) => {
    const memory = client({ list: [problem()] });
    const bindings = store({ read });

    await expect(
      resolveProblemForSession(memory.client, bindings.store, SESSION_ID, PROJECT_ID),
    ).resolves.toMatchObject({ kind: 'CANDIDATES' });
    // Enumerated, and no Problem read: there was no hint to revalidate.
    expect(memory.log.order).toEqual(['listProblems']);
  });

  it.each([
    ['UNREADABLE', { kind: 'UNREADABLE' } as const],
    ['IO_FAILURE', { kind: 'IO_FAILURE' } as const],
  ])('never turns a %s note into "there is nothing to continue"', async (_name, read) => {
    // The quiet failure this whole function exists to avoid: a file that could
    // not be read reported as an absence of work, followed by a second Problem
    // for something already open.
    const memory = client({ list: [problem()] });
    const bindings = store({ read });

    const resolution = await resolveProblemForSession(
      memory.client,
      bindings.store,
      SESSION_ID,
      PROJECT_ID,
    );

    expect(resolution.kind).not.toBe('NONE');
  });

  it('answers NONE only when the server says there is nothing', async () => {
    const memory = client({ list: [] });
    const bindings = store({ read: { kind: 'MISSING' } });

    await expect(
      resolveProblemForSession(memory.client, bindings.store, SESSION_ID, PROJECT_ID),
    ).resolves.toEqual({ kind: 'NONE' });
  });

  it('propagates a Memory failure rather than answering from local state', async () => {
    const memory = client({ list: new MemoryApiUnreachableError('TRANSPORT') });
    const bindings = store({ read: { kind: 'MISSING' } });

    await expect(
      resolveProblemForSession(memory.client, bindings.store, SESSION_ID, PROJECT_ID),
    ).rejects.toBeInstanceOf(MemoryApiUnreachableError);
  });

  it('sends the session identity to the store and nowhere else', async () => {
    const memory = client({ list: [] });
    const bindings = store({ read: { kind: 'MISSING' } });

    await resolveProblemForSession(memory.client, bindings.store, SESSION_ID, PROJECT_ID);

    expect(bindings.log.reads).toEqual([{ sessionId: SESSION_ID, projectId: PROJECT_ID }]);
    expect(memory.log.lists).toEqual([PROJECT_ID]);
    expect(JSON.stringify(memory.log).includes(SESSION_ID)).toBe(false);
  });

  it('writes nothing while merely reading', async () => {
    const memory = client({ list: [problem()] });
    const bindings = store({ read: { kind: 'MISSING' } });

    await resolveProblemForSession(memory.client, bindings.store, SESSION_ID, PROJECT_ID);

    expect(bindings.log.writes).toEqual([]);
  });
});

describe('continuing a Problem somebody chose', () => {
  it('revalidates through the resolver, then records it', async () => {
    const memory = client({ get: problem() });
    const bindings = store({});

    await expect(
      continueProblem(memory.client, bindings.store, SESSION_ID, PROJECT_ID, PROBLEM_ID),
    ).resolves.toEqual({ kind: 'CONTINUED', problemId: PROBLEM_ID, continuity: 'PERSISTED' });
    expect(bindings.log.writes).toEqual([
      { sessionId: SESSION_ID, projectId: PROJECT_ID, problemId: PROBLEM_ID },
    ]);
  });

  it('reports a note that could not be written, without repeating anything', async () => {
    const memory = client({ get: problem() });
    const bindings = store({ write: { kind: 'IO_FAILURE' } });

    await expect(
      continueProblem(memory.client, bindings.store, SESSION_ID, PROJECT_ID, PROBLEM_ID),
    ).resolves.toEqual({ kind: 'CONTINUED', problemId: PROBLEM_ID, continuity: 'NOT_PERSISTED' });
    expect(bindings.log.writes).toHaveLength(1);
  });

  it.each([
    ['paused', 'PAUSED' as const],
    ['verified', 'VERIFIED' as const],
    ['closed', 'CLOSED_UNRESOLVED' as const],
  ])('refuses a %s Problem, and writes nothing', async (_name, status: ProblemStatus) => {
    const memory = client({ get: problem({ status }), list: [] });
    const bindings = store({});

    const result = await continueProblem(
      memory.client,
      bindings.store,
      SESSION_ID,
      PROJECT_ID,
      PROBLEM_ID,
    );

    expect(result.kind).toBe('SELECTION_STALE');
    expect(bindings.log.writes).toEqual([]);
  });

  it('refuses a Problem that belongs to another Project', async () => {
    const memory = client({ get: problem({ project_id: OTHER_PROJECT_ID }), list: [] });
    const bindings = store({});

    await expect(
      continueProblem(memory.client, bindings.store, SESSION_ID, PROJECT_ID, PROBLEM_ID),
    ).resolves.toEqual({ kind: 'SELECTION_STALE', resolution: { kind: 'NONE' } });
    expect(bindings.log.writes).toEqual([]);
  });

  it('refuses a Problem that no longer exists, and offers what does', async () => {
    const memory = client({ get: GONE, list: [problem({ problem_id: OTHER_PROBLEM_ID })] });
    const bindings = store({});

    const result = await continueProblem(
      memory.client,
      bindings.store,
      SESSION_ID,
      PROJECT_ID,
      PROBLEM_ID,
    );

    expect(result).toMatchObject({ kind: 'SELECTION_STALE', resolution: { kind: 'CANDIDATES' } });
    expect(bindings.log.writes).toEqual([]);
  });

  it('never selects the only candidate on the caller’s behalf', async () => {
    // The Problem asked for is gone and exactly one other could be continued.
    // Returning it as the answer would be the count deciding what somebody is
    // working on.
    const memory = client({ get: GONE, list: [problem({ problem_id: OTHER_PROBLEM_ID })] });
    const bindings = store({});

    const result = await continueProblem(
      memory.client,
      bindings.store,
      SESSION_ID,
      PROJECT_ID,
      PROBLEM_ID,
    );

    expect(result.kind).not.toBe('CONTINUED');
  });

  it('never writes before the server has agreed', async () => {
    const memory = client({ get: problem() });
    const bindings = store({});

    await continueProblem(memory.client, bindings.store, SESSION_ID, PROJECT_ID, PROBLEM_ID);

    // The read happens first, every time. A note written first is a note that
    // is wrong in between — which is exactly when the next turn reads it.
    expect(memory.log.order[0]).toBe('getProblem');
    expect(bindings.log.order).toEqual(['writeBinding']);
  });

  it('propagates a Memory failure rather than deciding without one', async () => {
    const memory = client({ get: new MemoryApiUnreachableError('TRANSPORT') });
    const bindings = store({});

    await expect(
      continueProblem(memory.client, bindings.store, SESSION_ID, PROJECT_ID, PROBLEM_ID),
    ).rejects.toBeInstanceOf(MemoryApiUnreachableError);
    expect(bindings.log.writes).toEqual([]);
  });

  it('answers with an identity and a continuity, and nothing else', async () => {
    const memory = client({ get: problem() });
    const bindings = store({});

    const result = await continueProblem(
      memory.client,
      bindings.store,
      SESSION_ID,
      PROJECT_ID,
      PROBLEM_ID,
    );

    expect(Object.keys(result).sort()).toEqual(['continuity', 'kind', 'problemId']);
    expect(JSON.stringify(result).includes(PLANTED)).toBe(false);
  });
});

describe('resuming a paused Problem', () => {
  const paused = () => problem({ status: 'PAUSED', version: 7 });

  it.each(RESUME_PROBLEM_TARGET_STATUSES)('moves it to %s', async (target) => {
    const memory = client({ get: paused(), transition: problem({ status: target, version: 8 }) });
    const bindings = store({});

    await expect(
      resumeProblem(memory.client, bindings.store, SESSION_ID, PROJECT_ID, PROBLEM_ID, target),
    ).resolves.toEqual({
      kind: 'RESUMED',
      problemId: PROBLEM_ID,
      status: target,
      continuity: 'PERSISTED',
    });
  });

  it('sends the version it just read, and its own provenance', async () => {
    const memory = client({
      get: paused(),
      transition: problem({ status: 'INVESTIGATING', version: 8 }),
    });
    const bindings = store({});

    await resumeProblem(
      memory.client,
      bindings.store,
      SESSION_ID,
      PROJECT_ID,
      PROBLEM_ID,
      'INVESTIGATING',
    );

    expect(memory.log.transitions).toEqual([
      {
        problemId: PROBLEM_ID,
        request: {
          target_status: 'INVESTIGATING',
          // 7, from the read above — not a number a caller was holding.
          expected_version: 7,
          changed_by: CLAUDE_CODE_SOURCE_AI,
        },
      },
    ]);
  });

  it('takes provenance from nowhere a caller can reach', async () => {
    // There is no parameter for it. The assertion is that the value sent is the
    // adapter's constant, and the type is what makes an override impossible.
    const memory = client({
      get: paused(),
      transition: problem({ status: 'INVESTIGATING', version: 8 }),
    });
    const bindings = store({});

    await resumeProblem(
      memory.client,
      bindings.store,
      SESSION_ID,
      PROJECT_ID,
      PROBLEM_ID,
      'INVESTIGATING',
    );

    expect(memory.log.transitions[0]?.request.changed_by).toBe(CLAUDE_CODE_SOURCE_AI);
  });

  it.each([
    ['already being worked in', 'INVESTIGATING' as const],
    ['a fix candidate', 'FIX_CANDIDATE' as const],
    ['verified', 'VERIFIED' as const],
    ['closed', 'CLOSED_UNRESOLVED' as const],
  ])('does not transition one that is %s', async (_name, status: ProblemStatus) => {
    const memory = client({ get: problem({ status }), list: [] });
    const bindings = store({});

    const result = await resumeProblem(
      memory.client,
      bindings.store,
      SESSION_ID,
      PROJECT_ID,
      PROBLEM_ID,
      'INVESTIGATING',
    );

    expect(result.kind).toBe('SELECTION_STALE');
    expect(memory.log.transitions).toEqual([]);
    expect(bindings.log.writes).toEqual([]);
  });

  it('does not transition one belonging to another Project', async () => {
    const memory = client({
      get: problem({ status: 'PAUSED', project_id: OTHER_PROJECT_ID }),
      list: [],
    });
    const bindings = store({});

    const result = await resumeProblem(
      memory.client,
      bindings.store,
      SESSION_ID,
      PROJECT_ID,
      PROBLEM_ID,
      'INVESTIGATING',
    );

    expect(result.kind).toBe('SELECTION_STALE');
    expect(memory.log.transitions).toEqual([]);
  });

  it('reports a Problem that is gone as a stale selection', async () => {
    const memory = client({ get: GONE, list: [problem({ problem_id: OTHER_PROBLEM_ID })] });
    const bindings = store({});

    await expect(
      resumeProblem(
        memory.client,
        bindings.store,
        SESSION_ID,
        PROJECT_ID,
        PROBLEM_ID,
        'INVESTIGATING',
      ),
    ).resolves.toMatchObject({ kind: 'SELECTION_STALE', resolution: { kind: 'CANDIDATES' } });
  });

  it.each([
    [
      'a refusal that is not about this Problem',
      new MemoryApiError(500, 'INTERNAL_ERROR', 'req-0'),
    ],
    // Both halves are required: a 404 that is not this contract's own refusal
    // is a proxy or a misconfigured base URL, not the Memory saying a Problem
    // is gone.
    ['a 404 that is not a missing Problem', new MemoryApiError(404, 'INTERNAL_ERROR', 'req-0')],
    ['an unanswerable read', new MemoryApiUnreachableError('TRANSPORT')],
    ['an answer it cannot read', new MemoryApiProtocolError('RESOURCE_MALFORMED', 200)],
  ])('propagates %s from the read', async (_name, failure: Error) => {
    const memory = client({ get: failure });
    const bindings = store({});

    await expect(
      resumeProblem(
        memory.client,
        bindings.store,
        SESSION_ID,
        PROJECT_ID,
        PROBLEM_ID,
        'INVESTIGATING',
      ),
    ).rejects.toBe(failure);
    expect(bindings.log.writes).toEqual([]);
  });

  it('propagates a version conflict without binding or trying again', async () => {
    // Somebody else wrote to the Problem between the read and the transition,
    // so the decision was made against a record that no longer exists. Deciding
    // again here would be this module deciding on their behalf.
    const conflict = new MemoryApiError(409, 'VERSION_CONFLICT', 'req-0');
    const memory = client({ get: paused(), transition: conflict });
    const bindings = store({});

    await expect(
      resumeProblem(
        memory.client,
        bindings.store,
        SESSION_ID,
        PROJECT_ID,
        PROBLEM_ID,
        'INVESTIGATING',
      ),
    ).rejects.toBe(conflict);
    expect(memory.log.transitions).toHaveLength(1);
    expect(bindings.log.writes).toEqual([]);
  });

  it('propagates an unanswered transition without binding or trying again', async () => {
    // Nobody knows whether it committed. Calling that a stale selection would
    // state that it did not.
    const unreachable = new MemoryApiUnreachableError('TRANSPORT');
    const memory = client({ get: paused(), transition: unreachable });
    const bindings = store({});

    await expect(
      resumeProblem(
        memory.client,
        bindings.store,
        SESSION_ID,
        PROJECT_ID,
        PROBLEM_ID,
        'INVESTIGATING',
      ),
    ).rejects.toBe(unreachable);
    expect(memory.log.transitions).toHaveLength(1);
    expect(bindings.log.writes).toEqual([]);
  });

  it('records the note only after the transition succeeded', async () => {
    const memory = client({
      get: paused(),
      transition: problem({ status: 'INVESTIGATING', version: 8 }),
    });
    const bindings = store({});

    await resumeProblem(
      memory.client,
      bindings.store,
      SESSION_ID,
      PROJECT_ID,
      PROBLEM_ID,
      'INVESTIGATING',
    );

    expect(memory.log.order).toEqual(['getProblem', 'transitionProblemStatus']);
    // One read up front for the key, then the write — and the write is last.
    expect(bindings.log.order).toEqual(['readBinding', 'writeBinding']);
  });

  it('is still a resume when the note could not be written', async () => {
    const memory = client({
      get: paused(),
      transition: problem({ status: 'INVESTIGATING', version: 8 }),
    });
    const bindings = store({ write: { kind: 'IO_FAILURE' } });

    await expect(
      resumeProblem(
        memory.client,
        bindings.store,
        SESSION_ID,
        PROJECT_ID,
        PROBLEM_ID,
        'INVESTIGATING',
      ),
    ).resolves.toEqual({
      kind: 'RESUMED',
      problemId: PROBLEM_ID,
      status: 'INVESTIGATING',
      continuity: 'NOT_PERSISTED',
    });
    // The Problem was moved. Moving it again would move it twice.
    expect(memory.log.transitions).toHaveLength(1);
  });

  it('refuses a transitioned Problem that came back under another Project', async () => {
    const memory = client({
      get: paused(),
      transition: problem({ status: 'INVESTIGATING', project_id: OTHER_PROJECT_ID }),
    });
    const bindings = store({});

    await expect(
      resumeProblem(
        memory.client,
        bindings.store,
        SESSION_ID,
        PROJECT_ID,
        PROBLEM_ID,
        'INVESTIGATING',
      ),
    ).rejects.toBeInstanceOf(ProblemLifecycleInvariantError);
    expect(bindings.log.writes).toEqual([]);
  });

  it.each([
    // The load-bearing one. `PAUSED → CLOSED_UNRESOLVED` is a *legal* move on
    // the server, and the client accepts any canonical status because
    // transition legality is not its business — so nothing downstream of here
    // would have refused it. It would have closed the Problem, bound the
    // session to it, and returned a result whose word for what happened is
    // "resumed".
    ['closing it', 'CLOSED_UNRESOLVED'],
    ['declaring it verified', 'VERIFIED'],
    ['pausing an already paused Problem', 'PAUSED'],
    // Not a special case against three names: a value from outside the status
    // vocabulary altogether is refused by the same subset check.
    ['a status nobody published', 'REOPENED'],
    ['nothing at all', ''],
  ])('refuses %s as a resume, before it does anything', async (_name, target) => {
    const memory = client({ get: paused(), transition: problem({ status: 'PAUSED' }) });
    const bindings = store({});

    await expect(
      resumeProblem(
        memory.client,
        bindings.store,
        SESSION_ID,
        PROJECT_ID,
        PROBLEM_ID,
        // Deliberately past the type, because the type is exactly what does not
        // survive to the boundary this guard exists for.
        target as ResumeProblemTargetStatus,
      ),
    ).rejects.toBeInstanceOf(ProblemLifecycleArgumentError);

    // Nothing read, nothing moved, nothing noted — not even the binding-key
    // preflight. A refused resume costs nothing and leaves nothing to explain.
    expect(memory.log.order).toEqual([]);
    expect(memory.log.transitions).toEqual([]);
    expect(bindings.log.reads).toEqual([]);
    expect(bindings.log.writes).toEqual([]);
  });

  it('names the argument it refused and never the value', async () => {
    const memory = client({ get: paused() });
    const bindings = store({});
    const raised = await resumeProblem(
      memory.client,
      bindings.store,
      SESSION_ID,
      PROJECT_ID,
      PROBLEM_ID,
      'CLOSED_UNRESOLVED' as ResumeProblemTargetStatus,
    ).catch((error: unknown) => error);

    expect(raised).toBeInstanceOf(ProblemLifecycleArgumentError);
    expect((raised as ProblemLifecycleArgumentError).argument).toBe('resume target status');
    expect(String((raised as Error).message).includes('CLOSED_UNRESOLVED')).toBe(false);
  });

  it('stops before the transition when the binding key is unusable', async () => {
    // The store owns what a usable identity is. Learning about it *after* a
    // Problem had been moved would leave the caller with neither a result nor a
    // way to find out what happened.
    const memory = client({ get: paused() });
    const bindings = store({ read: new ProblemBindingArgumentError('session id') });

    await expect(
      resumeProblem(memory.client, bindings.store, '', PROJECT_ID, PROBLEM_ID, 'INVESTIGATING'),
    ).rejects.toBeInstanceOf(ProblemBindingArgumentError);
    expect(memory.log.order).toEqual([]);
  });

  it.each([
    ['MISSING', { kind: 'MISSING' } as const],
    ['UNREADABLE', { kind: 'UNREADABLE' } as const],
    ['IO_FAILURE', { kind: 'IO_FAILURE' } as const],
    [
      'VALID',
      { kind: 'VALID', binding: { projectId: PROJECT_ID, problemId: PROBLEM_ID } } as const,
    ],
  ])('is not blocked by a preflight that read %s', async (_name, read) => {
    const memory = client({
      get: paused(),
      transition: problem({ status: 'INVESTIGATING', version: 8 }),
    });
    const bindings = store({ read });

    await expect(
      resumeProblem(
        memory.client,
        bindings.store,
        SESSION_ID,
        PROJECT_ID,
        PROBLEM_ID,
        'INVESTIGATING',
      ),
    ).resolves.toMatchObject({ kind: 'RESUMED' });
  });

  it('answers with an identity, a status and a continuity, and nothing else', async () => {
    const memory = client({
      get: paused(),
      transition: problem({ status: 'INVESTIGATING', version: 8 }),
    });
    const bindings = store({});

    const result = await resumeProblem(
      memory.client,
      bindings.store,
      SESSION_ID,
      PROJECT_ID,
      PROBLEM_ID,
      'INVESTIGATING',
    );

    expect(Object.keys(result).sort()).toEqual(['continuity', 'kind', 'problemId', 'status']);
    expect(JSON.stringify(result).includes(PLANTED)).toBe(false);
  });
});

describe('starting a new Problem', () => {
  it('starts when the Project has nothing to continue', async () => {
    const memory = client({ list: [] });
    const bindings = store({});

    await expect(
      startNewProblem(memory.client, bindings.store, SESSION_ID, START),
    ).resolves.toEqual({
      kind: 'STARTED',
      problemId: PROBLEM_ID,
      status: 'INVESTIGATING',
      continuity: 'PERSISTED',
    });
  });

  it('starts when nothing is continuable and the caller expected nothing', async () => {
    const memory = client({ list: [] });
    const bindings = store({});

    await expect(
      startNewProblem(memory.client, bindings.store, SESSION_ID, START, []),
    ).resolves.toMatchObject({ kind: 'STARTED' });
  });

  it('sends the caller back when continuable work exists and none was considered', async () => {
    const memory = client({ list: [problem()] });
    const bindings = store({});

    await expect(
      startNewProblem(memory.client, bindings.store, SESSION_ID, START),
    ).resolves.toMatchObject({ kind: 'RECONSIDER', reason: 'CANDIDATES_PRESENT' });
    expect(memory.log.creates).toBe(0);
  });

  it('sends the caller back even when there is only one', async () => {
    // One Problem is still a Problem somebody has to have looked at. A count
    // deciding otherwise is the same mistake as a resolver picking the only
    // candidate.
    const memory = client({ list: [problem()] });
    const bindings = store({});

    const result = await startNewProblem(memory.client, bindings.store, SESSION_ID, START);

    expect(result.kind).toBe('RECONSIDER');
    expect((result as { candidates: readonly unknown[] }).candidates).toHaveLength(1);
  });

  it('counts a paused Problem as work to consider', async () => {
    const memory = client({ list: [problem({ status: 'PAUSED' })] });
    const bindings = store({});

    await expect(
      startNewProblem(memory.client, bindings.store, SESSION_ID, START),
    ).resolves.toMatchObject({ kind: 'RECONSIDER', reason: 'CANDIDATES_PRESENT' });
  });

  it('starts when the caller considered exactly what is there', async () => {
    const memory = client({
      list: [problem(), problem({ problem_id: OTHER_PROBLEM_ID })],
    });
    const bindings = store({});

    await expect(
      startNewProblem(memory.client, bindings.store, SESSION_ID, START, [
        PROBLEM_ID,
        OTHER_PROBLEM_ID,
      ]),
    ).resolves.toMatchObject({ kind: 'STARTED' });
  });

  it('does not care what order the caller listed them in', async () => {
    const memory = client({
      list: [problem(), problem({ problem_id: OTHER_PROBLEM_ID })],
    });
    const bindings = store({});

    await expect(
      startNewProblem(memory.client, bindings.store, SESSION_ID, START, [
        OTHER_PROBLEM_ID,
        PROBLEM_ID,
      ]),
    ).resolves.toMatchObject({ kind: 'STARTED' });
  });

  it('sends the caller back when a Problem appeared since they decided', async () => {
    const memory = client({
      list: [problem(), problem({ problem_id: OTHER_PROBLEM_ID })],
    });
    const bindings = store({});

    await expect(
      startNewProblem(memory.client, bindings.store, SESSION_ID, START, [PROBLEM_ID]),
    ).resolves.toMatchObject({ kind: 'RECONSIDER', reason: 'CANDIDATES_CHANGED' });
    expect(memory.log.creates).toBe(0);
  });

  it('sends the caller back when one they considered has gone', async () => {
    const memory = client({ list: [problem()] });
    const bindings = store({});

    await expect(
      startNewProblem(memory.client, bindings.store, SESSION_ID, START, [
        PROBLEM_ID,
        OTHER_PROBLEM_ID,
      ]),
    ).resolves.toMatchObject({ kind: 'RECONSIDER', reason: 'CANDIDATES_CHANGED' });
  });

  it('sends the caller back when everything they considered has gone', async () => {
    const memory = client({ list: [] });
    const bindings = store({});

    await expect(
      startNewProblem(memory.client, bindings.store, SESSION_ID, START, [PROBLEM_ID]),
    ).resolves.toMatchObject({ kind: 'RECONSIDER', reason: 'CANDIDATES_CHANGED' });
    expect(memory.log.creates).toBe(0);
  });

  it('does not let a repeated identity stand in for one that is missing', async () => {
    // `['a', 'a']` is not a record of having considered two Problems. Counting
    // it as one would let a caller satisfy this guard while having seen less
    // than exists.
    const memory = client({
      list: [problem(), problem({ problem_id: OTHER_PROBLEM_ID })],
    });
    const bindings = store({});

    await expect(
      startNewProblem(memory.client, bindings.store, SESSION_ID, START, [PROBLEM_ID, PROBLEM_ID]),
    ).resolves.toMatchObject({ kind: 'RECONSIDER', reason: 'CANDIDATES_CHANGED' });
  });

  it('does not let a repeated identity match a single fresh one', async () => {
    const memory = client({ list: [problem()] });
    const bindings = store({});

    await expect(
      startNewProblem(memory.client, bindings.store, SESSION_ID, START, [PROBLEM_ID, PROBLEM_ID]),
    ).resolves.toMatchObject({ kind: 'RECONSIDER', reason: 'CANDIDATES_CHANGED' });
  });

  it('compares identities and not what the Problems say about themselves', async () => {
    // A Problem pausing, resuming or being retitled while somebody decided is
    // not a different Problem, and sending them back for it would be sending
    // them back for nothing.
    const memory = client({
      list: [problem({ status: 'PAUSED', title: 'renamed since they looked' })],
    });
    const bindings = store({});

    await expect(
      startNewProblem(memory.client, bindings.store, SESSION_ID, START, [PROBLEM_ID]),
    ).resolves.toMatchObject({ kind: 'STARTED' });
  });

  it('sees another continuable Problem even when this session is bound to one', async () => {
    // The load-bearing case. Resolving with this session's binding would answer
    // RESOLVED on the bound Problem and never enumerate the other one — so a
    // recheck built on the hint would start a second Problem beside work that
    // should have stopped it.
    const memory = client({
      get: problem(),
      list: [problem(), problem({ problem_id: OTHER_PROBLEM_ID })],
    });
    const bindings = store({
      read: { kind: 'VALID', binding: { projectId: PROJECT_ID, problemId: PROBLEM_ID } },
    });

    const result = await startNewProblem(memory.client, bindings.store, SESSION_ID, START);

    expect(result).toMatchObject({ kind: 'RECONSIDER', reason: 'CANDIDATES_PRESENT' });
    expect((result as { candidates: readonly unknown[] }).candidates).toHaveLength(2);
    // Enumerated rather than short-circuited: no Problem was read at all.
    expect(memory.log.order).toEqual(['listProblems']);
  });

  it('creates nothing at all while sending the caller back', async () => {
    const memory = client({ list: [problem()] });
    const bindings = store({});

    await startNewProblem(memory.client, bindings.store, SESSION_ID, START);

    expect(memory.log.order).toEqual(['listProblems']);
    expect(bindings.log.writes).toEqual([]);
  });

  it('checks the binding key before anything is created', async () => {
    const memory = client({ list: [] });
    const bindings = store({ read: new ProblemBindingArgumentError('session id') });

    await expect(startNewProblem(memory.client, bindings.store, '', START)).rejects.toBeInstanceOf(
      ProblemBindingArgumentError,
    );
    expect(memory.log.order).toEqual([]);
  });

  it('rechecks before it creates, and records after', async () => {
    const memory = client({ list: [] });
    const bindings = store({});

    await startNewProblem(memory.client, bindings.store, SESSION_ID, START);

    expect(memory.log.order).toEqual(['listProblems', 'createEnvironment', 'createProblem']);
    expect(bindings.log.order).toEqual(['readBinding', 'writeBinding']);
  });

  it('records the note against the Problem that was actually started', async () => {
    const memory = client({ list: [], problem: problem({ problem_id: OTHER_PROBLEM_ID }) });
    const bindings = store({});

    await startNewProblem(memory.client, bindings.store, SESSION_ID, START);

    expect(bindings.log.writes).toEqual([
      { sessionId: SESSION_ID, projectId: PROJECT_ID, problemId: OTHER_PROBLEM_ID },
    ]);
  });

  it('is still a start when the note could not be written', async () => {
    const memory = client({ list: [] });
    const bindings = store({ write: { kind: 'IO_FAILURE' } });

    await expect(
      startNewProblem(memory.client, bindings.store, SESSION_ID, START),
    ).resolves.toMatchObject({ kind: 'STARTED', continuity: 'NOT_PERSISTED' });
    // One Environment, one Problem. A note is not a reason to make another.
    expect(memory.log.order).toEqual(['listProblems', 'createEnvironment', 'createProblem']);
  });

  it('writes no note when starting failed', async () => {
    const memory = client({
      list: [],
      problem: new MemoryApiError(400, 'INVALID_REQUEST', 'req-0'),
    });
    const bindings = store({});

    await expect(
      startNewProblem(memory.client, bindings.store, SESSION_ID, START),
    ).rejects.toBeInstanceOf(MemoryApiError);
    expect(bindings.log.writes).toEqual([]);
  });

  it('propagates an unanswered create without trying again', async () => {
    // There is no fact that would prove which of the Problems now under this
    // Project was the one this call may have made — no title, no symptom, no
    // newest. So nothing is guessed and nothing is re-sent.
    const unreachable = new MemoryApiUnreachableError('TRANSPORT');
    const memory = client({ list: [], problem: unreachable });
    const bindings = store({});

    await expect(startNewProblem(memory.client, bindings.store, SESSION_ID, START)).rejects.toBe(
      unreachable,
    );
    expect(memory.log.order).toEqual(['listProblems', 'createEnvironment', 'createProblem']);
    expect(bindings.log.writes).toEqual([]);
  });

  it('propagates an unanswered Environment without creating a Problem', async () => {
    const unreachable = new MemoryApiUnreachableError('TRANSPORT');
    const memory = client({ list: [], environment: unreachable });
    const bindings = store({});

    await expect(startNewProblem(memory.client, bindings.store, SESSION_ID, START)).rejects.toBe(
      unreachable,
    );
    expect(memory.log.order).toEqual(['listProblems', 'createEnvironment']);
  });

  it('answers with an identity, a status and a continuity, and nothing else', async () => {
    const memory = client({ list: [] });
    const bindings = store({});

    const result = await startNewProblem(memory.client, bindings.store, SESSION_ID, START);

    expect(Object.keys(result).sort()).toEqual(['continuity', 'kind', 'problemId', 'status']);
    expect(JSON.stringify(result).includes(PLANTED)).toBe(false);
  });

  it('offers candidates as identities and nothing more', async () => {
    const memory = client({ list: [problem()] });
    const bindings = store({});

    const result = await startNewProblem(memory.client, bindings.store, SESSION_ID, START);

    expect(Object.keys(result).sort()).toEqual(['candidates', 'kind', 'reason']);
    expect(JSON.stringify(result).includes(PLANTED)).toBe(false);
  });
});
