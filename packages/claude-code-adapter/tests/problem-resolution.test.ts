/**
 * Which Problem a session is on, and when the honest answer is "here are the
 * ones it could be".
 *
 * As with Project resolution, the assertions that matter are the negative ones.
 * A resolver that always produces a Problem is easy to write and is wrong in
 * the ordinary case: it attaches the next hour of work to whichever record was
 * lying around, and nothing about the result looks broken afterwards.
 *
 * The three that would each do that, and are each tested for:
 *
 * - one continuable Problem is still only a candidate;
 * - a paused Problem is resumable and is not the one in progress;
 * - a Memory that cannot be reached has not said there is nothing to continue.
 */

import { describe, expect, it } from 'vitest';

import {
  createMemoryApiClient,
  MemoryApiError,
  MemoryApiProtocolError,
  MemoryApiUnreachableError,
  PROBLEM_STATUSES,
  type FetchLike,
  type ProblemResource,
  type ProblemStatus,
} from '@ai-problem-solving-memory/api-client';

import {
  CONTINUABLE_PROBLEM_STATUSES,
  resolveCurrentProblem,
  type CurrentProblemReader,
  type ProblemBindingHint,
} from '../src/index.js';

const PROJECT_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_PROJECT_ID = '77777777-6666-4555-8444-333333333333';

/** Synthetic. Stands in for something nobody should find in an output. */
const PLANTED_SECRET = 'memory-fixture-secret-marker-Qv7X2';

function problem(overrides: Partial<ProblemResource> = {}): ProblemResource {
  return {
    problem_id: 'aaaaaaaa-1111-4222-8333-444444444444',
    owner_id: '99999999-8888-4777-8666-555555555555',
    project_id: PROJECT_ID,
    environment_id: 'bbbbbbbb-1111-4222-8333-444444444444',
    title: 'the build fails only on the second run',
    symptoms: `a cached artifact is reused ${PLANTED_SECRET}`,
    problem_domain: 'build',
    suspected_boundary: 'cache',
    source_ai: 'claude-code',
    status: 'INVESTIGATING',
    fix_kind: null,
    importance: true,
    confidence: 'MEDIUM',
    freshness: 'CURRENT',
    memory_read_enabled: true,
    memory_write_enabled: true,
    suppressed: false,
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

interface ReaderLog {
  readonly getProblem: string[];
  readonly listProblems: string[];
}

/**
 * A reader whose two answers are fixed, and which records what it was asked.
 *
 * A failing answer becomes a **rejected promise**, not a synchronous throw. The
 * real methods are `async`, so that is the shape a failure actually arrives in
 * — and the difference is not academic: a double that threw synchronously would
 * pass straight through a `.catch()` on the call's result, so a resolver that
 * swallowed failures that way would look correct here. A mutation found exactly
 * that, which is what this comment is for.
 */
function reader(answers: {
  list?: readonly ProblemResource[] | Error;
  get?: ProblemResource | Error;
}): { client: CurrentProblemReader; log: ReaderLog } {
  const log: ReaderLog = { getProblem: [], listProblems: [] };

  const client: CurrentProblemReader = {
    getProblem(problemId) {
      log.getProblem.push(problemId);
      if (answers.get === undefined) {
        return Promise.reject(new Error('the test did not expect a Problem to be read'));
      }
      return answers.get instanceof Error
        ? Promise.reject(answers.get)
        : Promise.resolve(answers.get);
    },
    listProblems(projectId) {
      log.listProblems.push(projectId);
      if (answers.list === undefined) {
        return Promise.reject(new Error('the test did not expect the Problems to be listed'));
      }
      return answers.list instanceof Error
        ? Promise.reject(answers.list)
        : Promise.resolve(answers.list);
    },
  };

  return { client, log };
}

function binding(overrides: Partial<ProblemBindingHint> = {}): ProblemBindingHint {
  return { projectId: PROJECT_ID, problemId: 'aaaaaaaa-1111-4222-8333-444444444444', ...overrides };
}

const TERMINAL: readonly ProblemStatus[] = ['VERIFIED', 'CLOSED_UNRESOLVED'];

describe('how every status is classified', () => {
  // The behaviour these three groups produce is asserted throughout this file.
  // What is asserted *here* is that the groups between them account for every
  // status the contract has — which is the property a list of continuable
  // states cannot give, because nothing about such a list mentions the states
  // it leaves out.
  const WORKING: readonly ProblemStatus[] = ['INVESTIGATING', 'FIX_CANDIDATE'];
  const PAUSED_ONLY: readonly ProblemStatus[] = ['PAUSED'];
  const TERMINAL_ONLY: readonly ProblemStatus[] = ['VERIFIED', 'CLOSED_UNRESOLVED'];

  it('classifies every status the contract publishes, and no others', () => {
    expect([...WORKING, ...PAUSED_ONLY, ...TERMINAL_ONLY].sort()).toEqual(
      [...PROBLEM_STATUSES].sort(),
    );
  });

  it('puts each status in exactly one class', () => {
    const all = [...WORKING, ...PAUSED_ONLY, ...TERMINAL_ONLY];
    expect(new Set(all).size).toBe(all.length);
  });

  it('treats the working and paused statuses as continuable, and no others', () => {
    expect([...CONTINUABLE_PROBLEM_STATUSES].sort()).toEqual([...WORKING, ...PAUSED_ONLY].sort());
  });

  it('leaves every terminal status out of the continuable set', () => {
    for (const status of TERMINAL_ONLY) {
      expect(`${status}:${CONTINUABLE_PROBLEM_STATUSES.includes(status as never)}`).toBe(
        `${status}:false`,
      );
    }
  });

  it.each(WORKING)(
    'resolves a binding to a %s Problem, because it is being worked in',
    async (status) => {
      const bound = problem({ status });
      const { client } = reader({ get: bound });

      await expect(resolveCurrentProblem(client, PROJECT_ID, binding())).resolves.toEqual({
        kind: 'RESOLVED',
        problemId: bound.problem_id,
      });
    },
  );

  it.each([...PAUSED_ONLY, ...TERMINAL_ONLY])(
    'does not resolve a binding to a %s Problem',
    async (status) => {
      const bound = problem({ status });
      const { client, log } = reader({ get: bound, list: [] });

      const resolution = await resolveCurrentProblem(client, PROJECT_ID, binding());

      expect(resolution).not.toMatchObject({ kind: 'RESOLVED' });
      expect(log.listProblems).toEqual([PROJECT_ID]);
    },
  );

  it.each([...WORKING, ...PAUSED_ONLY])('offers a %s Problem as a candidate', async (status) => {
    const only = problem({ status });
    const { client } = reader({ list: [only] });

    await expect(resolveCurrentProblem(client, PROJECT_ID)).resolves.toEqual({
      kind: 'CANDIDATES',
      candidates: [{ problemId: only.problem_id, status, title: only.title }],
    });
  });

  it.each(TERMINAL_ONLY)('never offers a %s Problem as a candidate', async (status) => {
    const { client } = reader({ list: [problem({ status })] });

    await expect(resolveCurrentProblem(client, PROJECT_ID)).resolves.toEqual({ kind: 'NONE' });
  });
});

describe('with no binding at all', () => {
  it('answers NONE when the project has no Problems', async () => {
    const { client } = reader({ list: [] });

    await expect(resolveCurrentProblem(client, PROJECT_ID)).resolves.toEqual({ kind: 'NONE' });
  });

  it.each(TERMINAL)('answers NONE when every Problem is %s', async (status) => {
    const { client } = reader({ list: [problem({ status })] });

    await expect(resolveCurrentProblem(client, PROJECT_ID)).resolves.toEqual({ kind: 'NONE' });
  });

  it.each(['INVESTIGATING', 'FIX_CANDIDATE', 'PAUSED'] as const)(
    'offers a single %s Problem as a candidate rather than resolving it',
    async (status) => {
      const only = problem({ status });
      const { client } = reader({ list: [only] });

      const resolution = await resolveCurrentProblem(client, PROJECT_ID);

      // The whole point. One row is not evidence that this conversation is
      // about it, and a resolver that said otherwise would be guessing on the
      // strength of a count.
      expect(resolution).toEqual({
        kind: 'CANDIDATES',
        candidates: [{ problemId: only.problem_id, status, title: only.title }],
      });
    },
  );

  it('offers a working Problem and a paused one together', async () => {
    const working = problem({ problem_id: 'aaaaaaaa-0000-4000-8000-000000000001' });
    const paused = problem({
      problem_id: 'aaaaaaaa-0000-4000-8000-000000000002',
      status: 'PAUSED',
    });
    const { client } = reader({ list: [working, paused] });

    const resolution = await resolveCurrentProblem(client, PROJECT_ID);

    expect(resolution).toMatchObject({ kind: 'CANDIDATES' });
    expect(resolution).toHaveProperty('candidates');
    expect(
      (resolution as { candidates: readonly { problemId: string }[] }).candidates,
    ).toHaveLength(2);
  });

  it('offers two paused Problems, deciding between them no more than between any others', async () => {
    const first = problem({ problem_id: 'aaaaaaaa-0000-4000-8000-000000000001', status: 'PAUSED' });
    const second = problem({
      problem_id: 'aaaaaaaa-0000-4000-8000-000000000002',
      status: 'PAUSED',
    });
    const { client } = reader({ list: [first, second] });

    const resolution = await resolveCurrentProblem(client, PROJECT_ID);

    expect(resolution).toEqual({
      kind: 'CANDIDATES',
      candidates: [
        { problemId: first.problem_id, status: 'PAUSED', title: first.title },
        { problemId: second.problem_id, status: 'PAUSED', title: second.title },
      ],
    });
  });

  it('drops the terminal Problems and keeps the rest', async () => {
    const verified = problem({
      problem_id: 'aaaaaaaa-0000-4000-8000-000000000001',
      status: 'VERIFIED',
    });
    const working = problem({ problem_id: 'aaaaaaaa-0000-4000-8000-000000000002' });
    const closed = problem({
      problem_id: 'aaaaaaaa-0000-4000-8000-000000000003',
      status: 'CLOSED_UNRESOLVED',
    });
    const { client } = reader({ list: [verified, working, closed] });

    const resolution = await resolveCurrentProblem(client, PROJECT_ID);

    expect(resolution).toEqual({
      kind: 'CANDIDATES',
      candidates: [
        { problemId: working.problem_id, status: 'INVESTIGATING', title: working.title },
      ],
    });
  });

  it('keeps the order the server sent, in an order that is not any it would sort into', async () => {
    // Deliberately contradicts both of the orders a sort might produce: the
    // ids descend and the titles are not alphabetical, so a resolver that
    // reordered by either would change this list.
    const third = problem({
      problem_id: 'aaaaaaaa-0000-4000-8000-000000000003',
      title: 'a first alphabetically',
    });
    const second = problem({
      problem_id: 'aaaaaaaa-0000-4000-8000-000000000002',
      title: 'z last alphabetically',
      status: 'PAUSED',
    });
    const first = problem({
      problem_id: 'aaaaaaaa-0000-4000-8000-000000000001',
      title: 'm middle alphabetically',
      status: 'FIX_CANDIDATE',
    });
    const { client } = reader({ list: [third, second, first] });

    const resolution = await resolveCurrentProblem(client, PROJECT_ID);

    expect(resolution).toEqual({
      kind: 'CANDIDATES',
      candidates: [
        { problemId: third.problem_id, status: 'INVESTIGATING', title: third.title },
        { problemId: second.problem_id, status: 'PAUSED', title: second.title },
        { problemId: first.problem_id, status: 'FIX_CANDIDATE', title: first.title },
      ],
    });
  });

  it('does not de-duplicate two Problems that look alike', async () => {
    const one = problem({ problem_id: 'aaaaaaaa-0000-4000-8000-000000000001' });
    const two = problem({ problem_id: 'aaaaaaaa-0000-4000-8000-000000000002' });
    const { client } = reader({ list: [one, two] });

    const resolution = await resolveCurrentProblem(client, PROJECT_ID);

    expect((resolution as { candidates: readonly unknown[] }).candidates).toHaveLength(2);
  });

  it('lists under the project it was asked about', async () => {
    const { client, log } = reader({ list: [] });

    await resolveCurrentProblem(client, PROJECT_ID);

    expect(log.listProblems).toEqual([PROJECT_ID]);
    expect(log.getProblem).toEqual([]);
  });
});

describe('with a binding that holds up', () => {
  it.each(['INVESTIGATING', 'FIX_CANDIDATE'] as const)(
    'resolves a bound %s Problem to its identity',
    async (status) => {
      const bound = problem({ status });
      const { client, log } = reader({ get: bound });

      const resolution = await resolveCurrentProblem(client, PROJECT_ID, binding());

      expect(resolution).toEqual({ kind: 'RESOLVED', problemId: bound.problem_id });
      // Revalidated, and the list never consulted: the binding is the answer
      // when the server agrees with it.
      expect(log.getProblem).toEqual([bound.problem_id]);
      expect(log.listProblems).toEqual([]);
    },
  );

  it('carries an identity and nothing the server said about the Problem', async () => {
    const { client } = reader({ get: problem() });

    const resolution = await resolveCurrentProblem(client, PROJECT_ID, binding());

    expect(Object.keys(resolution).sort()).toEqual(['kind', 'problemId']);
  });
});

describe('with a binding that does not hold up', () => {
  it('ignores a binding recorded under another project, without reading it', async () => {
    const { client, log } = reader({ list: [] });

    const resolution = await resolveCurrentProblem(
      client,
      PROJECT_ID,
      binding({ projectId: OTHER_PROJECT_ID }),
    );

    expect(resolution).toEqual({ kind: 'NONE' });
    // Not read at all. A hint from elsewhere costs no request, and — more to
    // the point — never gets the chance to be revalidated against the wrong
    // Project and pass.
    expect(log.getProblem).toEqual([]);
    expect(log.listProblems).toEqual([PROJECT_ID]);
  });

  it('ignores a bound Problem the server says is in another project', async () => {
    const elsewhere = problem({ project_id: OTHER_PROJECT_ID });
    const here = problem({ problem_id: 'aaaaaaaa-0000-4000-8000-000000000009' });
    const { client, log } = reader({ get: elsewhere, list: [here] });

    const resolution = await resolveCurrentProblem(client, PROJECT_ID, binding());

    expect(resolution).toEqual({
      kind: 'CANDIDATES',
      candidates: [{ problemId: here.problem_id, status: 'INVESTIGATING', title: here.title }],
    });
    expect(log.listProblems).toEqual([PROJECT_ID]);
  });

  it('does not resolve a bound PAUSED Problem, and offers it as a candidate instead', async () => {
    const paused = problem({ status: 'PAUSED' });
    const { client, log } = reader({ get: paused, list: [paused] });

    const resolution = await resolveCurrentProblem(client, PROJECT_ID, binding());

    // Resumable is not the same as in progress. Resuming changes the record's
    // status, and a resolver that skipped that would show a Problem nobody
    // resumed collecting work.
    expect(resolution).toEqual({
      kind: 'CANDIDATES',
      candidates: [{ problemId: paused.problem_id, status: 'PAUSED', title: paused.title }],
    });
    expect(log.listProblems).toEqual([PROJECT_ID]);
  });

  it.each(TERMINAL)('does not resolve a bound %s Problem', async (status) => {
    const finished = problem({ status });
    const { client, log } = reader({ get: finished, list: [] });

    const resolution = await resolveCurrentProblem(client, PROJECT_ID, binding());

    expect(resolution).toEqual({ kind: 'NONE' });
    expect(log.listProblems).toEqual([PROJECT_ID]);
  });

  it('treats a NOT_FOUND on the bound Problem as a hint that has expired', async () => {
    const other = problem({ problem_id: 'aaaaaaaa-0000-4000-8000-000000000009' });
    const { client, log } = reader({
      get: new MemoryApiError(404, 'NOT_FOUND', 'req-0000000000000000'),
      list: [other],
    });

    const resolution = await resolveCurrentProblem(client, PROJECT_ID, binding());

    expect(resolution).toEqual({
      kind: 'CANDIDATES',
      candidates: [{ problemId: other.problem_id, status: 'INVESTIGATING', title: other.title }],
    });
    expect(log.listProblems).toEqual([PROJECT_ID]);
  });
});

describe('a Memory that cannot answer has not answered', () => {
  it('propagates an unreachable Memory from the binding read', async () => {
    const { client, log } = reader({
      get: new MemoryApiUnreachableError('TRANSPORT'),
      list: [],
    });

    await expect(resolveCurrentProblem(client, PROJECT_ID, binding())).rejects.toBeInstanceOf(
      MemoryApiUnreachableError,
    );
    // And the list is not reached for as a second opinion: enumerating after an
    // outage would answer NONE for a project full of open Problems.
    expect(log.listProblems).toEqual([]);
  });

  it('propagates an unreadable answer from the binding read', async () => {
    const { client, log } = reader({
      get: new MemoryApiProtocolError('RESOURCE_MALFORMED', 200),
      list: [],
    });

    await expect(resolveCurrentProblem(client, PROJECT_ID, binding())).rejects.toBeInstanceOf(
      MemoryApiProtocolError,
    );
    expect(log.listProblems).toEqual([]);
  });

  it.each([
    ['a refusal that is not NOT_FOUND', new MemoryApiError(403, 'UNAUTHENTICATED', 'req-0')],
    ['a fault', new MemoryApiError(500, 'INTERNAL_ERROR', 'req-0')],
    ['a NOT_FOUND at another status', new MemoryApiError(410, 'NOT_FOUND', 'req-0')],
    ['another code at 404', new MemoryApiError(404, 'INVALID_REQUEST', 'req-0')],
  ])('propagates %s from the binding read', async (_name, thrown) => {
    const { client, log } = reader({ get: thrown, list: [] });

    await expect(resolveCurrentProblem(client, PROJECT_ID, binding())).rejects.toBe(thrown);
    expect(log.listProblems).toEqual([]);
  });

  it.each([
    ['unreachable', new MemoryApiUnreachableError('TRANSPORT')],
    ['unreadable', new MemoryApiProtocolError('RESOURCE_MALFORMED', 200)],
    ['refused', new MemoryApiError(500, 'INTERNAL_ERROR', 'req-0')],
  ])('propagates a %s list rather than calling it NONE', async (_name, thrown) => {
    const { client } = reader({ list: thrown });

    await expect(resolveCurrentProblem(client, PROJECT_ID)).rejects.toBe(thrown);
  });
});

describe('what a resolution is allowed to carry', () => {
  const FORBIDDEN = [
    'owner_id',
    'environment_id',
    'symptoms',
    'source_ai',
    'version',
    'created_at',
    'updated_at',
    'problem_domain',
    'suspected_boundary',
    'confidence',
    'freshness',
    'importance',
    'suppressed',
    'memory_read_enabled',
    'memory_write_enabled',
    'fix_kind',
  ];

  it('gives a RESOLVED nothing beyond the identity', async () => {
    const { client } = reader({ get: problem() });

    const resolution = await resolveCurrentProblem(client, PROJECT_ID, binding());
    const serialised = JSON.stringify(resolution);

    expect(Object.keys(resolution).sort()).toEqual(['kind', 'problemId']);
    for (const field of [...FORBIDDEN, 'project_id', 'projectId']) {
      expect(serialised.includes(field)).toBe(false);
    }
    expect(serialised.includes(PLANTED_SECRET)).toBe(false);
    expect(serialised.includes(PROJECT_ID)).toBe(false);
  });

  it('gives a candidate exactly three fields', async () => {
    const { client } = reader({ list: [problem(), problem({ status: 'PAUSED' })] });

    const resolution = await resolveCurrentProblem(client, PROJECT_ID);
    const candidates = (resolution as { candidates: readonly object[] }).candidates;

    for (const candidate of candidates) {
      expect(Object.keys(candidate).sort()).toEqual(['problemId', 'status', 'title']);
    }
  });

  it('lets nothing else reach a candidate by any route', async () => {
    const { client } = reader({ list: [problem()] });

    const serialised = JSON.stringify(await resolveCurrentProblem(client, PROJECT_ID));

    for (const field of FORBIDDEN) {
      expect(serialised.includes(field)).toBe(false);
    }
    // The whole resource was available and the symptoms did not travel.
    expect(serialised.includes(PLANTED_SECRET)).toBe(false);
    expect(serialised.includes(PROJECT_ID)).toBe(false);
  });

  it('gives NONE no payload to carry anything in', async () => {
    const { client } = reader({ list: [] });

    const resolution = await resolveCurrentProblem(client, PROJECT_ID);

    expect(Object.keys(resolution)).toEqual(['kind']);
  });
});

describe('revalidating a binding through the real client', () => {
  /** Synthetic. Nothing authenticates it; it only has to look like one. */
  const CREDENTIAL = 'memory_test_0000000000000000000000000000';

  /** A transport that answers every GET with the same body, whatever was asked. */
  function answering(body: unknown): FetchLike {
    return () =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
  }

  it('refuses an answer describing a Problem other than the bound one', async () => {
    // Driven through the real client rather than a double, because the property
    // is the client's: the route named one Problem and the body describes
    // another. The resolver has no second opinion about that and should not
    // grow one — what it must not do is come out the other side with an
    // ordinary answer.
    const bound: ProblemBindingHint = {
      projectId: PROJECT_ID,
      problemId: 'aaaaaaaa-1111-4222-8333-444444444444',
    };
    const impostor = problem({ problem_id: 'bbbbbbbb-1111-4222-8333-444444444444' });
    const memory = createMemoryApiClient({ credential: CREDENTIAL, fetch: answering(impostor) });

    await expect(resolveCurrentProblem(memory, PROJECT_ID, bound)).rejects.toBeInstanceOf(
      MemoryApiProtocolError,
    );
  });

  it('refuses an answer at a version no record could be at', async () => {
    const bound: ProblemBindingHint = {
      projectId: PROJECT_ID,
      problemId: 'aaaaaaaa-1111-4222-8333-444444444444',
    };
    const memory = createMemoryApiClient({
      credential: CREDENTIAL,
      fetch: answering(problem({ version: 0 })),
    });

    await expect(resolveCurrentProblem(memory, PROJECT_ID, bound)).rejects.toBeInstanceOf(
      MemoryApiProtocolError,
    );
  });

  it('still resolves when the answer is about the Problem that was asked for', async () => {
    const bound: ProblemBindingHint = {
      projectId: PROJECT_ID,
      problemId: 'aaaaaaaa-1111-4222-8333-444444444444',
    };
    const memory = createMemoryApiClient({
      credential: CREDENTIAL,
      fetch: answering(problem()),
    });

    await expect(resolveCurrentProblem(memory, PROJECT_ID, bound)).resolves.toEqual({
      kind: 'RESOLVED',
      problemId: 'aaaaaaaa-1111-4222-8333-444444444444',
    });
  });
});
